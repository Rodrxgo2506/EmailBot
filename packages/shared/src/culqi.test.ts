import { describe, expect, it, vi } from "vitest";
import {
  collectCulqiIds,
  createCulqiClient,
  CulqiApiError,
  culqiEnvironment,
  CULQI_PLAN_INTERVAL_COUNT,
  culqiAmountToCents,
  culqiKeyProblem,
  culqiPlanMismatch,
  culqiTimestamp,
  isHandledCulqiEvent,
  mapCulqiSubscriptionStatus
} from "./culqi.js";

const SECRET = "sk_test_abcdefgh12345678";

function fakeFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined
    });
    const next = responses.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("sandbox-only keys", () => {
  it("accepts integration keys and refuses live keys (this phase never charges real cards)", () => {
    expect(culqiKeyProblem(SECRET, "secret")).toBeNull();
    expect(culqiKeyProblem("pk_test_abcdefgh1234", "public")).toBeNull();
    expect(culqiKeyProblem("sk_live_abcdefgh12345678", "secret")).toMatch(/live keys are not enabled/);
    expect(culqiKeyProblem("pk_live_abcdefgh1234", "public")).toMatch(/live keys are not enabled/);
    expect(culqiKeyProblem("pk_test_abcdefgh1234", "secret")).toMatch(/secret key/);
    expect(culqiKeyProblem("sk_test_abcdefgh12345678", "public")).toMatch(/public key/);
    expect(() => createCulqiClient({ secretKey: "sk_live_abcdefgh12345678", fetch: vi.fn() as never })).toThrow(/live keys are not enabled/);
  });

  it("environment from Culqi id prefixes", () => {
    expect(culqiEnvironment("sxn_test_abc")).toBe("test");
    expect(culqiEnvironment("evt_live_abc")).toBe("live");
    expect(culqiEnvironment("abc")).toBeNull();
  });
});

describe("status mapper (Culqi codes are never copied verbatim)", () => {
  it.each([
    [1, null, "PENDING"],
    [2, null, "PENDING"],
    [3, "PENDING", "ACTIVE"],
    [5, "PENDING", "PENDING"],
    [5, "ACTIVE", "PAST_DUE"],
    [5, "PAST_DUE", "PAST_DUE"],
    [4, "ACTIVE", "CANCELED"],
    [6, "ACTIVE", "EXPIRED"],
    [99, "ACTIVE", null],
    [null, "ACTIVE", null]
  ] as const)("Culqi %s (was %s) -> %s", (code, previous, expected) => {
    expect(mapCulqiSubscriptionStatus(code, previous)).toBe(expected);
  });

  it("handled events are Culqi's documented names", () => {
    expect(isHandledCulqiEvent("subscription.charge.succeeded")).toBe(true);
    expect(isHandledCulqiEvent("subscription.charge.failed")).toBe(true);
    expect(isHandledCulqiEvent("order.status.changed")).toBe(false);
    expect(isHandledCulqiEvent("subscription.payment.ok")).toBe(false);
  });
});

describe("culqiAmountToCents (Culqi amounts are in céntimos, possibly with float noise)", () => {
  it("the real BÁSICO mensual value 1989.9999999999998 is 1990 céntimos (S/19.90), never read as soles", () => {
    expect(culqiAmountToCents(1989.9999999999998)).toBe(1990);
    expect(culqiAmountToCents(19.9 * 100)).toBe(1990); // how Culqi produces it
    expect(culqiAmountToCents(1989.9999999999998)).not.toBe(198999);
  });

  it.each([
    [1990, 1990],
    [3990, 3990],
    [8990, 8990],
    [19900, 19900],
    [39900, 39900],
    [89900, 89900],
    [300, 300],
    [39.9 * 100, 3990],
    [89.9 * 100, 8990],
    [199 * 100, 19900],
    [399 * 100, 39900],
    [899 * 100, 89900],
    ["1990", 1990],
    [0, 0]
  ])("%s -> %s céntimos (integer)", (amount, cents) => {
    expect(culqiAmountToCents(amount)).toBe(cents);
    expect(Number.isInteger(culqiAmountToCents(amount))).toBe(true);
  });

  it("a really different amount stays different: 1989 (S/19.89) != 1990", () => {
    expect(culqiAmountToCents(1989)).toBe(1989);
    expect(culqiAmountToCents(1989)).not.toBe(1990);
  });

  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["negative", -1990],
    ["a real fraction of a céntimo", 1989.5],
    ["a soles-looking value (19.9 is not a céntimos amount)", 19.9],
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["text", "S/ 19.90"],
    ["object", { amount: 1990 }]
  ])("invalid data (%s) -> null, never a guessed number", (_label, amount) => {
    expect(culqiAmountToCents(amount)).toBeNull();
  });
});

describe("Culqi plan vs EmailBot price (checkout and activation)", () => {
  const expected = { planId: "pln_test_PRO", environment: "test" as const, amountCents: 3990, currency: "PEN", billingPeriod: "MONTHLY" as const };
  const plan = { id: "pln_test_PRO", amount: 3990, currency: "PEN", interval_unit_time: 3, interval_count: 1 };

  it("matches: plan id, environment, amount, currency, unit and interval_count 1", () => {
    expect(culqiPlanMismatch(plan, expected)).toBeNull();
    expect(culqiPlanMismatch({ ...plan, interval_unit_time: 4 }, { ...expected, billingPeriod: "YEARLY" })).toBeNull();
    expect(CULQI_PLAN_INTERVAL_COUNT).toBe(1);
  });

  it.each([
    ["interval_count 0", { interval_count: 0 }, "PLAN_INTERVAL_COUNT_MISMATCH"],
    ["interval_count 2", { interval_count: 2 }, "PLAN_INTERVAL_COUNT_MISMATCH"],
    ["interval_unit_time daily", { interval_unit_time: 1 }, "PLAN_INTERVAL_MISMATCH"],
    ["interval_unit_time yearly for a monthly price", { interval_unit_time: 4 }, "PLAN_INTERVAL_MISMATCH"],
    ["amount", { amount: 300 }, "PLAN_AMOUNT_MISMATCH"],
    ["currency", { currency: "USD" }, "PLAN_CURRENCY_MISMATCH"],
    ["plan id", { id: "pln_test_OTHER" }, "PLAN_ID_MISMATCH"]
  ] as const)("%s -> %s", (_label, change, reason) => {
    expect(culqiPlanMismatch({ ...plan, ...change }, expected)).toBe(reason);
  });

  it("interval_count missing -> PLAN_INTERVAL_COUNT_MISMATCH (fail closed)", () => {
    const { interval_count: _omitted, ...withoutCount } = plan;
    expect(culqiPlanMismatch(withoutCount, expected)).toBe("PLAN_INTERVAL_COUNT_MISMATCH");
  });

  it("the real BÁSICO mensual plan (amount 1989.9999999999998) matches S/19.90; a wrong amount is still a mismatch", () => {
    const basic = { id: "pln_test_R4OkGMwJmYgatc1y", amount: 1989.9999999999998, currency: "PEN", interval_unit_time: 3, interval_count: 1 };
    const basicPrice = { ...expected, planId: "pln_test_R4OkGMwJmYgatc1y", amountCents: 1990 };
    expect(culqiPlanMismatch(basic, basicPrice)).toBeNull();
    expect(culqiPlanMismatch({ ...basic, amount: 1989 }, basicPrice)).toBe("PLAN_AMOUNT_MISMATCH");
    expect(culqiPlanMismatch({ ...basic, amount: 1989.5 }, basicPrice)).toBe("PLAN_AMOUNT_MISMATCH");
    expect(culqiPlanMismatch({ ...basic, amount: Number.NaN }, basicPrice)).toBe("PLAN_AMOUNT_MISMATCH");
    expect(culqiPlanMismatch({ ...basic, amount: 199000 }, basicPrice)).toBe("PLAN_AMOUNT_MISMATCH");
  });

  it("a live plan never matches a test price", () => {
    expect(culqiPlanMismatch({ ...plan, id: "pln_live_PRO" }, { ...expected, planId: "pln_live_PRO" })).toBe("PLAN_ENVIRONMENT_MISMATCH");
  });
});

describe("event data helpers", () => {
  it("timestamps in seconds or milliseconds", () => {
    expect(culqiTimestamp(1656201600)?.toISOString()).toBe("2022-06-26T00:00:00.000Z");
    expect(culqiTimestamp(1656201600000)?.toISOString()).toBe("2022-06-26T00:00:00.000Z");
    expect(culqiTimestamp("1656201600")?.toISOString()).toBe("2022-06-26T00:00:00.000Z");
    expect(culqiTimestamp(null)).toBeNull();
    expect(culqiTimestamp("x")).toBeNull();
  });

  it("collects subscription / charge ids anywhere in the data, also when it is a JSON string", () => {
    expect(collectCulqiIds({ object: "subscription", id: "sxn_test_AAA", periods: [{ charges: { charge_id: "chr_test_BBB" } }] })).toEqual({
      subscriptionIds: ["sxn_test_AAA"],
      chargeIds: ["chr_test_BBB"]
    });
    expect(collectCulqiIds(JSON.stringify({ subscription: { id: "sxn_test_CCC" } }))).toEqual({ subscriptionIds: ["sxn_test_CCC"], chargeIds: [] });
    expect(collectCulqiIds("not json")).toEqual({ subscriptionIds: [], chargeIds: [] });
  });
});

describe("Culqi client (official v2 endpoints)", () => {
  it("authenticates with the secret key as a Bearer token and calls the documented paths", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: { id: "cus_test_C1" } },
      { status: 201, body: { id: "crd_test_K1" } },
      { status: 201, body: { id: "sxn_test_S1", status: 1 } },
      { status: 200, body: { id: "sxn_test_S1", status: 3 } },
      { status: 200, body: { id: "evt_test_E1", type: "subscription.charge.succeeded", data: {} } },
      { status: 200, body: { id: "sxn_test_S1", delete: true } }
    ]);
    const client = createCulqiClient({ secretKey: SECRET, fetch, baseUrl: "https://culqi.example" });
    expect(client.environment).toBe("test");
    await client.createCustomer({ first_name: "Ana", last_name: "Pérez", email: "a@b.pe", address: "Av. Lima 123", address_city: "Lima", country_code: "PE", phone_number: "999888777" });
    await client.createCard({ customer_id: "cus_test_C1", token_id: "tkn_test_T1" });
    await client.createSubscription({ card_id: "crd_test_K1", plan_id: "pln_test_P1", tyc: true, metadata: { organization_id: "o" } });
    await client.getSubscription("sxn_test_S1");
    await client.getEvent("evt_test_E1");
    expect(await client.cancelSubscription("sxn_test_S1")).toBe(true);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://culqi.example/v2/customers",
      "POST https://culqi.example/v2/cards",
      "POST https://culqi.example/v2/recurrent/subscriptions/create",
      "GET https://culqi.example/v2/recurrent/subscriptions/sxn_test_S1",
      "GET https://culqi.example/v2/events/evt_test_E1",
      "DELETE https://culqi.example/v2/recurrent/subscriptions/sxn_test_S1"
    ]);
    expect(calls.every((call) => call.headers.Authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(calls[2]?.body).toEqual({ card_id: "crd_test_K1", plan_id: "pln_test_P1", tyc: true, metadata: { organization_id: "o" } });
  });

  it("plans: created with Culqi's required initial_cycles; read back for verification", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 201, body: { id: "pln_test_P1" } },
      { status: 200, body: { id: "pln_test_P1", amount: 3990, currency: "PEN", interval_unit_time: 3 } },
      { status: 404, body: { object: "error" } }
    ]);
    const client = createCulqiClient({ secretKey: SECRET, fetch });
    await client.createPlan({ name: "EmailBot Pro mensual", short_name: "emailbot-pro-m", description: "Plan Pro", amount: 3990, currency: "PEN", interval_unit_time: 3, interval_count: 0 });
    expect(calls[0]?.url).toBe("https://api.culqi.com/v2/recurrent/plans/create");
    expect(calls[0]?.body).toMatchObject({ amount: 3990, initial_cycles: { count: 0, has_initial_charge: false, amount: 0, interval_unit_time: 3 } });
    expect(await client.getPlan("pln_test_P1")).toMatchObject({ amount: 3990 });
    expect(await client.getPlan("pln_test_missing")).toBeNull();
  });

  it("charges: GET /v2/charges/{id} (the documented proof of payment); unknown -> null", async () => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { object: "charge", id: "chr_test_C1", amount: 3990, currency_code: "PEN", paid: true, outcome: { code: "succesfull_charge" } } },
      { status: 404, body: { object: "error" } }
    ]);
    const client = createCulqiClient({ secretKey: SECRET, fetch });
    expect(await client.getCharge("chr_test_C1")).toMatchObject({ paid: true, outcome: { code: "succesfull_charge" } });
    expect(await client.getCharge("chr_test_missing")).toBeNull();
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual(["GET https://api.culqi.com/v2/charges/chr_test_C1", "GET https://api.culqi.com/v2/charges/chr_test_missing"]);
  });

  it("a card that needs 3DS (200 + action_code REVIEW) is reported, not treated as created", async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { action_code: "REVIEW", user_message: "El usuario necesita autenticarse" } }]);
    const client = createCulqiClient({ secretKey: SECRET, fetch });
    expect(await client.createCard({ customer_id: "cus_test_C1", token_id: "tkn_test_T1" })).toEqual({ kind: "REVIEW_3DS", userMessage: "El usuario necesita autenticarse" });
  });

  it("errors carry Culqi's type / code / merchant message, never the key", async () => {
    const { fetch } = fakeFetch([{ status: 402, body: { object: "error", type: "card_error", code: "card_declined", merchant_message: "Tarjeta rechazada" } }]);
    const client = createCulqiClient({ secretKey: SECRET, fetch });
    const error = await client.createSubscription({ card_id: "crd_test_K1", plan_id: "pln_test_P1", tyc: true }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CulqiApiError);
    expect(error).toMatchObject({ status: 402, type: "card_error", code: "card_declined", merchantMessage: "Tarjeta rechazada", isClientError: true });
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it("an unexpected id format from Culqi is rejected", async () => {
    const { fetch } = fakeFetch([{ status: 201, body: { id: "4111111111111111" } }]);
    const client = createCulqiClient({ secretKey: SECRET, fetch });
    await expect(client.createCustomer({ first_name: "A", last_name: "B", email: "a@b.pe", address: "Av 12345", address_city: "Lima", country_code: "PE", phone_number: "99988877" })).rejects.toThrow(
      /unexpected customer id|createCustomer/
    );
  });
});
