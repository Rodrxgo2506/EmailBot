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

/* ------------------------------------------------------------------ subscription statuses */

/** Culqi subscription status codes (GET /v2/recurrent/subscriptions: 1 Creada, 2 Periodo de prueba, 3 Activa, 4 Cancelada, 5 En cola, 6 Vencida). */
export const CULQI_SUBSCRIPTION_STATUS = { CREATED: 1, TRIAL: 2, ACTIVE: 3, CANCELED: 4, QUEUED: 5, EXPIRED: 6 } as const;

export type BillingStatus = "PENDING" | "ACTIVE" | "PAST_DUE" | "CANCELED" | "EXPIRED" | "FAILED";

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
 * Culqi charge (GET /v2/charges/{id}, "Objeto Cargo"): the documented proof of a
 * payment. `outcome.code` is "succesfull_charge" (sic, Culqi's spelling) or
 * "card_declined"; `paid` / `capture` are booleans; amounts in céntimos.
 */
export interface CulqiCharge {
  id: string;
  amount?: number | null;
  current_amount?: number | null;
  currency_code?: string | null;
  paid?: boolean | null;
  capture?: boolean | null;
  creation_date?: number | string | null;
  outcome?: { type?: string | null; code?: string | null; decline_code?: string | null; merchant_message?: string | null } | null;
  /** The card or token used ({ object: "card" | "token", id, customer_id? ... }). */
  source?: { object?: string | null; id?: string | null; customer_id?: string | null } | null;
  metadata?: Record<string, unknown> | null;
}

/** Culqi's documented outcome code of an approved charge (spelling as in the API). */
export const CULQI_CHARGE_SUCCESS_CODE = "succesfull_charge";

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
