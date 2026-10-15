/*
 * Culqi API v2 client (Commercial V1 phase 2, SANDBOX ONLY), shared by the
 * API (checkout) and the worker (webhook processing / reconciliation).
 *
 * Every endpoint, field and status code below comes from Culqi's official
 * OpenAPI specification (https://apidocs.culqi.com, apiculqi.yaml, API v2):
 *   POST   /v2/customers                       crear cliente
 *   GET    /v2/customers?email=                listar clientes
 *   POST   /v2/cards                           crear tarjeta (200 + action_code REVIEW = 3DS required)
 *   POST   /v2/recurrent/plans/create          crear plan
 *   GET    /v2/recurrent/plans/{id}            consultar plan
 *   POST   /v2/recurrent/subscriptions/create  crear suscripción (card_id, plan_id, tyc, metadata)
 *   GET    /v2/recurrent/subscriptions/{id}    consultar suscripción
 *   DELETE /v2/recurrent/subscriptions/{id}    cancelar suscripción
 *   GET    /v2/events/{id}                     consultar evento (the id sent by the webhook)
 *   GET    /v2/charges/{id}                    consultar cargo (paid / outcome: the proof of a payment)
 * Authentication: `Authorization: Bearer <secret key>`. Secret keys start with
 * sk_test_ (integration) or sk_live_ (production); public keys pk_test_ / pk_live_.
 *
 * No card data ever goes through EmailBot: the browser tokenizes the card
 * (Culqi Custom Checkout) and EmailBot only sends the token id to Culqi.
 */

export const CULQI_API_URL = "https://api.culqi.com";

export type CulqiEnvironment = "test" | "live";

/** Environment of a key / id from its prefix (sk_test_, pk_live_, sxn_test_, evt_live_ ...); null if unknown. */
export function culqiEnvironment(value: string): CulqiEnvironment | null {
  const match = /^[a-z]{2,4}_(test|live)_/.exec(value);
  return match ? (match[1] as CulqiEnvironment) : null;
}

/** This phase only allows Culqi's integration environment. */
export const CULQI_ALLOWED_ENVIRONMENTS: readonly CulqiEnvironment[] = ["test"];

/** Problem with a key (never echoes it), or null when it is a usable sandbox key of the expected kind. */
export function culqiKeyProblem(key: string, kind: "secret" | "public"): string | null {
  const prefix = kind === "secret" ? "sk" : "pk";
  if (!new RegExp(`^${prefix}_(test|live)_[A-Za-z0-9]{8,}$`).test(key)) return `must be a Culqi ${kind} key (${prefix}_test_...)`;
  if (!CULQI_ALLOWED_ENVIRONMENTS.includes(culqiEnvironment(key) as CulqiEnvironment)) {
    return `live keys are not enabled in this phase (use ${prefix}_test_...)`;
  }
  return null;
}

/* ------------------------------------------------------------------ ids */

export const CULQI_ID_PATTERNS = {
  token: /^tkn_(test|live)_[A-Za-z0-9]{1,64}$/,
  customer: /^cus_(test|live)_[A-Za-z0-9]{1,64}$/,
  card: /^crd_(test|live)_[A-Za-z0-9]{1,64}$/,
  plan: /^pln_(test|live)_[A-Za-z0-9]{1,64}$/,
  subscription: /^sxn_(test|live)_[A-Za-z0-9]{1,64}$/,
  charge: /^chr_(test|live)_[A-Za-z0-9]{1,64}$/,
  event: /^evt_(test|live)_[A-Za-z0-9]{1,64}$/
} as const;

/* ------------------------------------------------------------------ plans */

/** Culqi interval_unit_time: 1 daily, 2 weekly, 3 monthly, 4 yearly, 5 quarterly, 6 half-yearly. */
export const CULQI_INTERVAL_UNIT = { MONTHLY: 3, YEARLY: 4 } as const;

/**
 * Culqi amounts (plans and charges) are in CÉNTIMOS ("S/ 1.00 = 100"), but may come back as floats with binary
 * representation noise: the S/19.90 plan is returned as 1989.9999999999998 (sandbox, verified). This is the one
 * normalization used before comparing with the catalog's integer amount_cents: Math.round to an integer of céntimos.
 * Returns null (never a guessed number) for data that is not an amount: missing, non-numeric, NaN, Infinity,
 * negative, or with a real fraction of a céntimo (e.g. 1989.5, which is not representation noise).
 */
export function culqiAmountToCents(amount: unknown): number | null {
  const value = typeof amount === "number" ? amount : typeof amount === "string" && amount.trim() !== "" ? Number(amount) : Number.NaN;
  if (!Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value);
  // Float noise is ~1e-12 for these magnitudes; anything larger is a real fractional value: refused, not rounded away.
  if (Math.abs(value - cents) > 1e-6) return null;
  return cents;
}

/** Every EmailBot plan charges once per unit (month / year): interval_count 1, verified in the sandbox. Never 0. */
export const CULQI_PLAN_INTERVAL_COUNT = 1;

export type CulqiPlanMismatch =
  | "PLAN_ID_MISMATCH"
  | "PLAN_ENVIRONMENT_MISMATCH"
  | "PLAN_AMOUNT_MISMATCH"
  | "PLAN_CURRENCY_MISMATCH"
  | "PLAN_INTERVAL_MISMATCH"
  | "PLAN_INTERVAL_COUNT_MISMATCH";

/**
 * First difference between a Culqi plan (GET /v2/recurrent/plans/{id}) and the EmailBot price it must charge, or
 * null when it matches. Shared by the checkout (API) and the activation (worker). A missing interval_count fails
 * closed (Culqi returns it on GET).
 */
export function culqiPlanMismatch(
  plan: CulqiPlan,
  expected: { planId: string; environment: CulqiEnvironment; amountCents: number; currency: string; billingPeriod: keyof typeof CULQI_INTERVAL_UNIT }
): CulqiPlanMismatch | null {
  if (plan.id !== expected.planId) return "PLAN_ID_MISMATCH";
  if (culqiEnvironment(plan.id) !== expected.environment) return "PLAN_ENVIRONMENT_MISMATCH";
  if (culqiAmountToCents(plan.amount) !== expected.amountCents) return "PLAN_AMOUNT_MISMATCH";
  if (plan.currency !== expected.currency) return "PLAN_CURRENCY_MISMATCH";
  if (Number(plan.interval_unit_time) !== CULQI_INTERVAL_UNIT[expected.billingPeriod]) return "PLAN_INTERVAL_MISMATCH";
  if (Number(plan.interval_count) !== CULQI_PLAN_INTERVAL_COUNT) return "PLAN_INTERVAL_COUNT_MISMATCH";
  return null;
}

/* ------------------------------------------------------------------ subscription statuses */

/** Culqi subscription status codes (GET /v2/recurrent/subscriptions: 1 Creada, 2 Periodo de prueba, 3 Activa, 4 Cancelada, 5 En cola, 6 Vencida). */
export const CULQI_SUBSCRIPTION_STATUS = { CREATED: 1, TRIAL: 2, ACTIVE: 3, CANCELED: 4, QUEUED: 5, EXPIRED: 6 } as const;

export type BillingStatus = "PENDING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED" | "FAILED" | "REVIEW_REQUIRED";

/**
 * Culqi status -> EmailBot provider-side status. Never copied verbatim:
 *   1 Creada / 2 Prueba  -> PENDING (no confirmed charge yet; EmailBot plans have no trial)
 *   3 Activa             -> ACTIVE (only applied through a confirmed activation)
 *   5 En cola            -> PAST_DUE once it had been ACTIVE (a charge is being retried), else PENDING
 *   4 Cancelada          -> CANCELED
 *   6 Vencida            -> EXPIRED
 * Unknown codes -> null (left unchanged, logged).
 */
export function mapCulqiSubscriptionStatus(code: number | null | undefined, previous: BillingStatus | null): BillingStatus | null {
  switch (code) {
    case CULQI_SUBSCRIPTION_STATUS.CREATED:
    case CULQI_SUBSCRIPTION_STATUS.TRIAL:
      return "PENDING";
    case CULQI_SUBSCRIPTION_STATUS.ACTIVE:
      return "ACTIVE";
    case CULQI_SUBSCRIPTION_STATUS.QUEUED:
      return previous === "ACTIVE" || previous === "PAST_DUE" ? "PAST_DUE" : "PENDING";
    case CULQI_SUBSCRIPTION_STATUS.CANCELED:
      return "CANCELED";
    case CULQI_SUBSCRIPTION_STATUS.EXPIRED:
      return "EXPIRED";
    default:
      return null;
  }
}

/** Subscription / charge events EmailBot acts on (names from Culqi's "Lista de eventos"). */
export const CULQI_HANDLED_EVENTS = [
  "subscription.creation.succeeded",
  "subscription.creation.failed",
  "subscription.charge.succeeded",
  "subscription.charge.failed",
  "subscription.cancel.succeeded",
  "charge.creation.succeeded",
  "charge.creation.failed"
] as const;
export type CulqiHandledEvent = (typeof CULQI_HANDLED_EVENTS)[number];

export function isHandledCulqiEvent(type: string): type is CulqiHandledEvent {
  return (CULQI_HANDLED_EVENTS as readonly string[]).includes(type);
}

/**
 * Culqi timestamps appear in seconds or in milliseconds in the official
 * examples (e.g. 1656201600 and 1665537611000): both are accepted.
 */
export function culqiTimestamp(value: unknown): Date | null {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number <= 0) return null;
  return new Date(number < 1e12 ? number * 1000 : number);
}

/**
 * The shape of an event's `data` per event type is not specified in Culqi's
 * documentation, so EmailBot does not rely on field names: it collects the ids
 * with Culqi's documented prefixes (sxn_, chr_) anywhere in the data (which may
 * arrive as a JSON string) and then re-reads the subscription itself.
 */
export function collectCulqiIds(data: unknown): { subscriptionIds: string[]; chargeIds: string[] } {
  const subscriptions = new Set<string>();
  const charges = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 8) return;
    if (typeof value === "string") {
      if (CULQI_ID_PATTERNS.subscription.test(value)) subscriptions.add(value);
      else if (CULQI_ID_PATTERNS.charge.test(value)) charges.add(value);
      else if (depth === 0 && value.trim().startsWith("{")) {
        try {
          visit(JSON.parse(value), depth + 1);
        } catch {
          /* not JSON */
        }
      }
      return;
    }
    if (Array.isArray(value)) for (const item of value.slice(0, 200)) visit(item, depth + 1);
    else if (value && typeof value === "object") for (const item of Object.values(value as Record<string, unknown>).slice(0, 200)) visit(item, depth + 1);
  };
  visit(data, 0);
  return { subscriptionIds: [...subscriptions], chargeIds: [...charges] };
}

/* ------------------------------------------------------------------ errors */

/** A Culqi API error. `merchantMessage` comes from Culqi (no card data); never includes the key. */
export class CulqiApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
    readonly merchantMessage: string | null,
    readonly operation: string
  ) {
    super(`Culqi ${operation} failed (HTTP ${status}${type ? ` ${type}` : ""}${code ? ` ${code}` : ""})`);
    this.name = "CulqiApiError";
  }

  /** 4xx other than 429: the request itself was refused (not retryable as is). */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

/* ------------------------------------------------------------------ resources */

export interface CulqiCustomerInput {
  first_name: string;
  last_name: string;
  email: string;
  address: string;
  address_city: string;
  country_code: string;
  phone_number: string;
  metadata?: Record<string, string>;
}

export interface CulqiPlan {
  id: string;
  amount: number;
  currency: string;
  interval_unit_time: number;
  interval_count?: number;
  status?: number;
}

export interface CulqiSubscription {
  id: string;
  status: number;
  current_period?: number | null;
  next_billing_date?: number | string | null;
  creation_date?: number | string | null;
  plan_id?: string | null;
  plan?: { plan_id?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Culqi charge (GET /v2/charges/{id}, "Objeto Cargo"): the proof of a payment; amounts in céntimos.
 * The specification's success code ("succesfull_charge") and its description of `paid` do not match what the
 * sandbox returns: an approved, captured subscription charge came back with `paid: false` and
 * outcome { type: "venta_exitosa", code: "AUT0000" }. `paid` is therefore never used to decide (see the worker's
 * verifyCulqiCharge); what it means for Culqi is not documented.
 */
export interface CulqiCharge {
  id: string;
  amount?: number | null;
  current_amount?: number | null;
  amount_refunded?: number | null;
  currency_code?: string | null;
  paid?: boolean | null;
  capture?: boolean | null;
  authorization_code?: string | null;
  reference_code?: string | null;
  dispute?: boolean | null;
  creation_date?: number | string | null;
  outcome?: { type?: string | null; code?: string | null; decline_code?: string | null; merchant_message?: string | null } | null;
  /** The card or token used ({ object: "card" | "token", id, customer_id? ... }). */
  source?: { object?: string | null; id?: string | null; customer_id?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Outcome of an approved sale, as returned by the Culqi sandbox for a captured subscription charge (verified with a
 * real charge). Only this exact pair counts as a confirmed success; other codes are not assumed to be successes.
 */
export const CULQI_CHARGE_SUCCESS_OUTCOME = { type: "venta_exitosa", code: "AUT0000" } as const;

/** Culqi's documented outcome code of a declined charge. */
export const CULQI_CHARGE_DECLINED_CODE = "card_declined";

/**
 * Bank declines seen in the sandbox, as outcome { type: "operacion_denegada", code }. Only codes observed in a real
 * charge are listed (DNGE0015: first charge of a subscription with the "insufficient_funds" test card; Culqi's
 * documentation uses DNGE0015 as its insufficient_funds example). Other DNGE codes are not assumed.
 */
export const CULQI_DENIED_OPERATION_TYPE = "operacion_denegada";
export const CULQI_CONFIRMED_DECLINE_CODES: readonly string[] = ["DNGE0015"];

/**
 * A charge Culqi confirms as declined: the documented "card_declined" code, or an observed bank decline
 * (operacion_denegada + a listed code) without any evidence of success (no authorization code, not a sale).
 * `paid` and `capture` are never used: the sandbox returned capture: true on a declined charge.
 */
export function isConfirmedCulqiDecline(charge: CulqiCharge): boolean {
  const outcome = charge.outcome ?? null;
  if (!outcome) return false;
  if (outcome.code === CULQI_CHARGE_DECLINED_CODE) return true;
  const authorized = typeof charge.authorization_code === "string" && charge.authorization_code.trim() !== "";
  return (
    outcome.type === CULQI_DENIED_OPERATION_TYPE &&
    typeof outcome.code === "string" &&
    CULQI_CONFIRMED_DECLINE_CODES.includes(outcome.code) &&
    !authorized
  );
}

export interface CulqiEvent {
  id: string;
  type: string;
  creation_date?: number | string | null;
  data?: unknown;
}

export type CulqiCardResult = { kind: "CREATED"; id: string } | { kind: "REVIEW_3DS"; userMessage: string | null };

export interface CulqiClient {
  readonly environment: CulqiEnvironment;
  createCustomer(input: CulqiCustomerInput): Promise<{ id: string }>;
  findCustomerByEmail(email: string): Promise<{ id: string } | null>;
  createCard(input: { customer_id: string; token_id: string; metadata?: Record<string, string> }): Promise<CulqiCardResult>;
  createPlan(input: {
    name: string;
    short_name: string;
    description: string;
    amount: number;
    currency: string;
    interval_unit_time: number;
    interval_count: number;
    metadata?: Record<string, string>;
  }): Promise<{ id: string }>;
  getPlan(id: string): Promise<CulqiPlan | null>;
  createSubscription(input: { card_id: string; plan_id: string; tyc: boolean; metadata?: Record<string, string> }): Promise<CulqiSubscription>;
  getSubscription(id: string): Promise<CulqiSubscription | null>;
  /** Returns false when Culqi no longer knows it (404): already gone. */
  cancelSubscription(id: string): Promise<boolean>;
  getEvent(id: string): Promise<CulqiEvent | null>;
  /** GET /v2/charges/{id}; null when Culqi does not know it (404). */
  getCharge(id: string): Promise<CulqiCharge | null>;
}

export interface CulqiClientOptions {
  secretKey: string;
  fetch: typeof fetch;
  baseUrl?: string;
}

export function createCulqiClient(options: CulqiClientOptions): CulqiClient {
  const problem = culqiKeyProblem(options.secretKey, "secret");
  if (problem) throw new Error(`CULQI_SECRET_KEY ${problem}`);
  const environment = culqiEnvironment(options.secretKey) as CulqiEnvironment;
  const baseUrl = (options.baseUrl ?? CULQI_API_URL).replace(/\/+$/, "");

  async function call<T>(operation: string, method: string, path: string, body?: unknown, notFoundAsNull = false): Promise<{ status: number; body: T } | null> {
    const response = await options.fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${options.secretKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (notFoundAsNull && response.status === 404) return null;
    if (!response.ok) {
      const error = (parsed ?? {}) as { type?: unknown; code?: unknown; merchant_message?: unknown };
      throw new CulqiApiError(
        response.status,
        typeof error.type === "string" ? error.type.slice(0, 100) : null,
        typeof error.code === "string" ? error.code.slice(0, 100) : null,
        typeof error.merchant_message === "string" ? error.merchant_message.slice(0, 300) : null,
        operation
      );
    }
    return { status: response.status, body: parsed as T };
  }

  const required = <T>(result: { status: number; body: T } | null, operation: string): T => {
    if (!result || !result.body) throw new CulqiApiError(502, null, null, "empty response", operation);
    return result.body;
  };
  const encode = (id: string) => encodeURIComponent(id);

  return {
    environment,

    async createCustomer(input) {
      const body = required(await call<{ id?: string }>("createCustomer", "POST", "/v2/customers", input), "createCustomer");
      if (typeof body.id !== "string" || !CULQI_ID_PATTERNS.customer.test(body.id)) throw new CulqiApiError(502, null, null, "unexpected customer id", "createCustomer");
      return { id: body.id };
    },

    async findCustomerByEmail(email) {
      const body = required(
        await call<{ data?: Array<{ id?: string; email?: string }> }>("listCustomers", "GET", `/v2/customers?email=${encodeURIComponent(email)}&limit=1`),
        "listCustomers"
      );
      const found = (body.data ?? []).find((item) => typeof item.id === "string" && CULQI_ID_PATTERNS.customer.test(item.id));
      return found?.id ? { id: found.id } : null;
    },

    async createCard(input) {
      const result = required(await call<{ id?: string; action_code?: string; user_message?: string }>("createCard", "POST", "/v2/cards", input), "createCard");
      if (result.action_code === "REVIEW") return { kind: "REVIEW_3DS", userMessage: typeof result.user_message === "string" ? result.user_message.slice(0, 300) : null };
      if (typeof result.id !== "string" || !CULQI_ID_PATTERNS.card.test(result.id)) throw new CulqiApiError(502, null, null, "unexpected card id", "createCard");
      return { kind: "CREATED", id: result.id };
    },

    async createPlan(input) {
      const body = required(
        await call<{ id?: string }>("createPlan", "POST", "/v2/recurrent/plans/create", {
          ...input,
          initial_cycles: { count: 0, has_initial_charge: false, amount: 0, interval_unit_time: input.interval_unit_time }
        }),
        "createPlan"
      );
      if (typeof body.id !== "string" || !CULQI_ID_PATTERNS.plan.test(body.id)) throw new CulqiApiError(502, null, null, "unexpected plan id", "createPlan");
      return { id: body.id };
    },

    async getPlan(id) {
      const result = await call<CulqiPlan>("getPlan", "GET", `/v2/recurrent/plans/${encode(id)}`, undefined, true);
      return result?.body ?? null;
    },

    async createSubscription(input) {
      const body = required(await call<CulqiSubscription>("createSubscription", "POST", "/v2/recurrent/subscriptions/create", input), "createSubscription");
      if (typeof body.id !== "string" || !CULQI_ID_PATTERNS.subscription.test(body.id)) {
        throw new CulqiApiError(502, null, null, "unexpected subscription id", "createSubscription");
      }
      return body;
    },

    async getSubscription(id) {
      const result = await call<CulqiSubscription>("getSubscription", "GET", `/v2/recurrent/subscriptions/${encode(id)}`, undefined, true);
      return result?.body ?? null;
    },

    async cancelSubscription(id) {
      const result = await call<unknown>("cancelSubscription", "DELETE", `/v2/recurrent/subscriptions/${encode(id)}`, undefined, true);
      return result !== null;
    },

    async getEvent(id) {
      const result = await call<CulqiEvent>("getEvent", "GET", `/v2/events/${encode(id)}`, undefined, true);
      return result?.body ?? null;
    },

    async getCharge(id) {
      const result = await call<CulqiCharge>("getCharge", "GET", `/v2/charges/${encode(id)}`, undefined, true);
      return result?.body ?? null;
    }
  };
}
