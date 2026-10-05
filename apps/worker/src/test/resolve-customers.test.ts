import { describe, expect, it, vi } from "vitest";
import { quotedInList } from "../infrastructure/supabase-stores.js";
import type { IdentifierCandidate, RoutingBot } from "../pipeline/ports.js";
import { lookupValues, resolveCustomers, routeEmail, type CustomerResolverInput } from "../pipeline/resolve-customers.js";
import { makeAudit, makeEmail, ORG, OTHER_ORG, silentLogger } from "./fakes.js";

/*
 * EmailBot V2 phase 3: the CustomerResolver core. The store stub returns
 * whatever candidates it is given (as a buggy query would): the resolver must
 * still keep only eligible ones.
 */

const BOT = "bot-netflix";
const OTHER_BOT = "bot-yape";
const RECIPIENT = { source: "RECIPIENT", onMultipleMatches: "LEAVE_UNASSIGNED" };

function candidate(customerId: string, overrides: Partial<IdentifierCandidate> = {}): IdentifierCandidate {
  return {
    identifierId: `identifier-${customerId}`,
    organizationId: ORG,
    customerId,
    type: "EMAIL",
    normalizedValue: "me@gmail.com",
    botId: null,
    active: true,
    customerStatus: "ACTIVE",
    assigned: true,
    ...overrides
  };
}

function store(candidates: IdentifierCandidate[], bot: Partial<RoutingBot> & { customerResolution?: unknown } = {}) {
  return {
    loadBot: vi.fn(async (organizationId: string, botId: string): Promise<RoutingBot | null> => ({
      id: botId,
      organizationId,
      status: "ACTIVE",
      customerResolution: RECIPIENT,
      ...bot
    })),
    findCandidates: vi.fn(async () => candidates)
  };
}

const input = (overrides: Partial<CustomerResolverInput> = {}): CustomerResolverInput => ({
  organizationId: ORG,
  botId: BOT,
  botSelection: null,
  email: makeEmail(),
  extracted: {},
  ...overrides
});

describe("CustomerResolver: match count and policy", () => {
  it("0 matches -> UNASSIGNED (NO_MATCH)", async () => {
    expect(await resolveCustomers(input(), store([]))).toEqual({ status: "UNASSIGNED", botId: BOT, reason: "NO_MATCH", matchCount: 0 });
  });

  it("1 match -> AUTOMATIC delivery with the matched identifier", async () => {
    expect(await resolveCustomers(input(), store([candidate("c1")]))).toEqual({
      status: "DELIVER",
      botId: BOT,
      deliveries: [{ customerId: "c1", identifierId: "identifier-c1" }],
      matchCount: 1,
      policy: "LEAVE_UNASSIGNED"
    });
  });

  it("N matches + LEAVE_UNASSIGNED -> UNASSIGNED, nobody picked", async () => {
    expect(await resolveCustomers(input(), store([candidate("c1"), candidate("c2")]))).toEqual({
      status: "UNASSIGNED",
      botId: BOT,
      reason: "MULTIPLE_MATCHES",
      matchCount: 2,
      policy: "LEAVE_UNASSIGNED"
    });
  });

  it("N matches + DELIVER_ALL -> one delivery per valid customer, sorted by customer", async () => {
    const result = await resolveCustomers(
      input(),
      store([candidate("c2"), candidate("c1"), candidate("c3", { customerStatus: "SUSPENDED" })], {
        customerResolution: { source: "RECIPIENT", onMultipleMatches: "DELIVER_ALL" }
      })
    );
    expect(result).toMatchObject({ status: "DELIVER", matchCount: 2, policy: "DELIVER_ALL" });
    expect(result.status === "DELIVER" && result.deliveries.map((delivery) => delivery.customerId)).toEqual(["c1", "c2"]);
  });

  it("a shared identifier (same value, several customers) counts every customer", async () => {
    const shared = [candidate("c1", { identifierId: "i1" }), candidate("c2", { identifierId: "i2" })];
    expect(await resolveCustomers(input(), store(shared))).toMatchObject({ status: "UNASSIGNED", reason: "MULTIPLE_MATCHES", matchCount: 2 });
  });

  it("one customer matched by several identifiers is ONE match (bot-scoped identifier preferred, then smallest id)", async () => {
    const result = await resolveCustomers(
      input({ email: makeEmail({ recipients: [{ address: "me@gmail.com", name: null }], cc: [{ address: "alt@gmail.com", name: null }] }) }),
      store([
        candidate("c1", { identifierId: "i-b" }),
        candidate("c1", { identifierId: "i-c", normalizedValue: "alt@gmail.com", botId: BOT }),
        candidate("c1", { identifierId: "i-a", normalizedValue: "alt@gmail.com" })
      ])
    );
    expect(result).toMatchObject({ status: "DELIVER", matchCount: 1, deliveries: [{ customerId: "c1", identifierId: "i-c" }] });
  });

  it("is deterministic: the order of the query rows does not change the result", async () => {
    const rows = [candidate("c3"), candidate("c1"), candidate("c2")];
    const policy = { customerResolution: { source: "RECIPIENT", onMultipleMatches: "DELIVER_ALL" } };
    const first = await resolveCustomers(input(), store(rows, policy));
    const second = await resolveCustomers(input(), store([...rows].reverse(), policy));
    expect(first).toEqual(second);
  });
});

describe("CustomerResolver: eligibility (defence in depth over the query)", () => {
  it.each<[string, Partial<IdentifierCandidate>]>([
    ["inactive identifier", { active: false }],
    ["suspended customer", { customerStatus: "SUSPENDED" }],
    ["inactive or missing assignment to the bot", { assigned: false }],
    ["identifier scoped to another bot", { botId: OTHER_BOT }],
    ["identifier of another organization", { organizationId: OTHER_ORG }],
    ["identifier of another type", { type: "PHONE" }],
    ["identifier value not offered by the email", { normalizedValue: "someone@else.test" }]
  ])("%s -> not eligible", async (_label, overrides) => {
    expect(await resolveCustomers(input(), store([candidate("c1", overrides)]))).toMatchObject({ status: "UNASSIGNED", reason: "NO_MATCH" });
  });

  it("organization-wide identifiers (bot_id NULL) and identifiers of THIS bot are eligible", async () => {
    const result = await resolveCustomers(
      input(),
      store([candidate("c1", { botId: null }), candidate("c2", { botId: BOT })], {
        customerResolution: { source: "RECIPIENT", onMultipleMatches: "DELIVER_ALL" }
      })
    );
    expect(result).toMatchObject({ status: "DELIVER", matchCount: 2 });
  });

  it("the lookup is scoped to the email's organization and bot", async () => {
    const stub = store([]);
    await resolveCustomers(input(), stub);
    expect(stub.loadBot).toHaveBeenCalledWith(ORG, BOT);
    expect(stub.findCandidates).toHaveBeenCalledWith({ organizationId: ORG, botId: BOT, type: "EMAIL", values: ["me@gmail.com"] });
  });
});

describe("CustomerResolver: bot and configuration", () => {
  it("no bot (general rule, V1 email) -> NO_BOT; tie between bots -> AMBIGUOUS_BOT; nothing is queried", async () => {
    const stub = store([candidate("c1")]);
    expect(await resolveCustomers(input({ botId: null }), stub)).toMatchObject({ status: "UNASSIGNED", reason: "NO_BOT" });
    expect(await resolveCustomers(input({ botId: null, botSelection: "AMBIGUOUS" }), stub)).toMatchObject({ reason: "AMBIGUOUS_BOT" });
    expect(stub.loadBot).not.toHaveBeenCalled();
    expect(stub.findCandidates).not.toHaveBeenCalled();
  });

  it("paused bot -> BOT_PAUSED without looking up customers", async () => {
    const stub = store([candidate("c1")], { status: "PAUSED" });
    expect(await resolveCustomers(input(), stub)).toMatchObject({ status: "UNASSIGNED", reason: "BOT_PAUSED" });
    expect(stub.findCandidates).not.toHaveBeenCalled();
  });

  it("a bot of another organization is treated as not found", async () => {
    expect(await resolveCustomers(input(), store([candidate("c1")], { organizationId: OTHER_ORG }))).toMatchObject({ reason: "BOT_NOT_FOUND" });
    const missing = { loadBot: vi.fn(async () => null), findCandidates: vi.fn(async () => [candidate("c1")]) };
    expect(await resolveCustomers(input(), missing)).toMatchObject({ reason: "BOT_NOT_FOUND" });
  });

  it.each([
    [{ source: "RECIPIENT", onMultipleMatches: "PICK_FIRST" }],
    [{ source: "EXTRACTED_FIELD", onMultipleMatches: "LEAVE_UNASSIGNED" }],
    [{ source: "RECIPIENT", onMultipleMatches: "LEAVE_UNASSIGNED", extra: true }],
    ["RECIPIENT"],
    [null]
  ])("customer_resolution %j is re-validated -> INVALID_CONFIGURATION", async (customerResolution) => {
    expect(await resolveCustomers(input(), store([candidate("c1")], { customerResolution }))).toMatchObject({ reason: "INVALID_CONFIGURATION" });
  });

  it("source NONE -> NOT_CONFIGURED", async () => {
    const stub = store([candidate("c1")], { customerResolution: { source: "NONE", onMultipleMatches: "LEAVE_UNASSIGNED" } });
    expect(await resolveCustomers(input(), stub)).toMatchObject({ reason: "NOT_CONFIGURED" });
    expect(stub.findCandidates).not.toHaveBeenCalled();
  });
});

describe("CustomerResolver: identifier values", () => {
  const email = makeEmail({
    sender: { address: "Info@Streaming.Example", name: null },
    recipients: [{ address: "ME@gmail.com", name: null }, { address: "not an address", name: null }],
    cc: [{ address: "me@gmail.com", name: null }, { address: "Ana@Gmail.com", name: null }]
  });

  it("RECIPIENT = To + Cc, normalized, de-duplicated and sorted; invalid addresses ignored", () => {
    expect(lookupValues({ source: "RECIPIENT", identifierType: "EMAIL", onMultipleMatches: "LEAVE_UNASSIGNED" }, email, {})).toEqual({
      type: "EMAIL",
      values: ["ana@gmail.com", "me@gmail.com"]
    });
  });

  it("SENDER = the sender address", () => {
    expect(lookupValues({ source: "SENDER", identifierType: "EMAIL", onMultipleMatches: "LEAVE_UNASSIGNED" }, email, {})).toEqual({
      type: "EMAIL",
      values: ["info@streaming.example"]
    });
  });

  it("EXTRACTED_FIELD = the extracted value, normalized with the identifier type (same normalizer as the API)", () => {
    const resolution = { source: "EXTRACTED_FIELD" as const, field: "phone", identifierType: "PHONE" as const, onMultipleMatches: "LEAVE_UNASSIGNED" as const };
    expect(lookupValues(resolution, email, { phone: "+51 987-654-321" })).toEqual({ type: "PHONE", values: ["+51987654321"] });
    expect(lookupValues(resolution, email, { phone: "call me" })).toEqual({ type: "PHONE", values: [] });
    expect(lookupValues(resolution, email, {})).toEqual({ type: "PHONE", values: [] });
  });

  it("an email without a usable identifier -> NO_IDENTIFIER (nothing queried)", async () => {
    const stub = store([candidate("c1")], {
      customerResolution: { source: "EXTRACTED_FIELD", field: "account", identifierType: "USERNAME", onMultipleMatches: "LEAVE_UNASSIGNED" }
    });
    expect(await resolveCustomers(input({ extracted: {} }), stub)).toMatchObject({ reason: "NO_IDENTIFIER" });
    expect(stub.findCandidates).not.toHaveBeenCalled();
  });
});

describe("routeEmail: deliveries, audit and failures", () => {
  const deps = (candidates: IdentifierCandidate[], bot: Partial<RoutingBot> = {}) => {
    const audit = makeAudit();
    const routing = { ...store(candidates, bot), insertDeliveries: vi.fn(async (rows: Array<{ customer_id: string }>) => rows.map((row) => row.customer_id)) };
    return { audit, routing, logger: silentLogger };
  };

  it("inserts AUTOMATIC deliveries for the email's organization and bot; one match is not audited", async () => {
    const d = deps([candidate("c1")]);
    await routeEmail("email-1", input(), d);
    expect(d.routing.insertDeliveries).toHaveBeenCalledWith([
      { organization_id: ORG, email_id: "email-1", customer_id: "c1", bot_id: BOT, resolution: "AUTOMATIC", identifier_id: "identifier-c1" }
    ]);
    expect(d.audit.entries).toEqual([]);
  });

  it("records unassigned, multiple matches and ambiguous bot without personal data", async () => {
    const unassigned = deps([]);
    await routeEmail("email-1", input(), unassigned);
    const multiple = deps([candidate("c1"), candidate("c2")]);
    await routeEmail("email-2", input(), multiple);
    const ambiguous = deps([]);
    await routeEmail("email-3", { ...input({ botId: null, botSelection: "AMBIGUOUS" }), botCandidateIds: [BOT, OTHER_BOT] }, ambiguous);

    expect(unassigned.audit.entries).toEqual([
      expect.objectContaining({ organizationId: ORG, emailId: "email-1", event: "routing.unassigned", metadata: { botId: BOT, matchCount: 0, reason: "NO_MATCH" } })
    ]);
    expect(multiple.audit.entries).toEqual([
      expect.objectContaining({
        event: "routing.multiple_matches",
        metadata: { botId: BOT, matchCount: 2, reason: "MULTIPLE_MATCHES", policy: "LEAVE_UNASSIGNED", delivered: 0 }
      })
    ]);
    expect(ambiguous.audit.entries).toEqual([
      expect.objectContaining({ event: "routing.ambiguous_bot", metadata: expect.objectContaining({ botCandidateIds: [BOT, OTHER_BOT] }) })
    ]);
    const serialized = JSON.stringify([unassigned, multiple, ambiguous].map((d) => d.audit.entries));
    expect(serialized).not.toMatch(/@|gmail/);
    expect(multiple.routing.insertDeliveries).not.toHaveBeenCalled();
  });

  it("DELIVER_ALL with several customers is delivered and audited as multiple matches", async () => {
    const d = deps([candidate("c1"), candidate("c2")], { customerResolution: { source: "RECIPIENT", onMultipleMatches: "DELIVER_ALL" } });
    await routeEmail("email-1", input(), d);
    expect(d.routing.insertDeliveries.mock.calls[0]?.[0]).toHaveLength(2);
    expect(d.audit.entries).toEqual([
      expect.objectContaining({ event: "routing.multiple_matches", metadata: expect.objectContaining({ policy: "DELIVER_ALL", delivered: 2 }) })
    ]);
  });

  it("no bot and source NONE are normal outcomes (not audited)", async () => {
    const noBot = deps([]);
    await routeEmail("email-1", input({ botId: null }), noBot);
    const none = deps([], { customerResolution: { source: "NONE", onMultipleMatches: "LEAVE_UNASSIGNED" } });
    await routeEmail("email-2", input(), none);
    expect([...noBot.audit.entries, ...none.audit.entries]).toEqual([]);
  });

  it("a resolver failure is audited (error code only) and rethrown for the retry policy", async () => {
    const d = deps([candidate("c1")]);
    d.routing.insertDeliveries.mockRejectedValueOnce(Object.assign(new Error("insertDeliveries failed: me@gmail.com"), { code: "08006" }));
    await expect(routeEmail("email-1", input(), d)).rejects.toThrow(/insertDeliveries failed/);
    expect(d.audit.entries).toEqual([
      expect.objectContaining({ event: "routing.failed", metadata: { botId: BOT, errorCode: "08006" } })
    ]);
  });

  it("if even the failure audit fails, the original error is still rethrown", async () => {
    const d = deps([]);
    d.routing.findCandidates.mockRejectedValueOnce(new Error("lookup failed"));
    d.audit.recordEmailEvent.mockRejectedValueOnce(new Error("audit down"));
    await expect(routeEmail("email-1", input(), d)).rejects.toThrow("lookup failed");
  });
});

describe("quotedInList (PostgREST in.(...) values from emails)", () => {
  it("quotes every value and escapes quotes and backslashes", () => {
    expect(quotedInList(["a@b.test", 'x"),or(id.neq.0', "back\\slash"])).toBe('("a@b.test","x\\"),or(id.neq.0","back\\\\slash")');
  });
});
