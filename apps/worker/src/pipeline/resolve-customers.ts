import { serializeError } from "@emailbot/shared";
import type { CustomerIdentifierType, CustomerResolution, MultipleMatchPolicy, NormalizedEmail } from "@emailbot/types";
import { customerResolutionSchema, normalizeIdentifier } from "@emailbot/validation";
import type { AuditRecorder, IdentifierCandidate, Logger, RoutingStore } from "./ports.js";

/*
 * CustomerResolver (EmailBot V2 phase 3): Email -> Bot -> Customer(s).
 *
 * Deterministic: the same email, configuration and customer data always give
 * the same result. A customer is never picked arbitrarily (no created_at / id
 * tie-break between customers): one match is delivered, several matches are
 * either all delivered (DELIVER_ALL) or none (LEAVE_UNASSIGNED).
 *
 * Eligible customer = identifier ACTIVE, of the email's organization, scoped
 * to the whole organization (bot_id NULL) or to the email's bot; customer
 * ACTIVE; ACTIVE assignment to the bot. The store filters in SQL and this
 * module filters again (defence in depth); the database re-checks on insert
 * (composite foreign keys + eligibility trigger).
 */

export type UnassignedReason =
  | "NO_BOT"
  | "AMBIGUOUS_BOT"
  | "BOT_NOT_FOUND"
  | "BOT_PAUSED"
  | "NOT_CONFIGURED"
  | "INVALID_CONFIGURATION"
  | "NO_IDENTIFIER"
  | "NO_MATCH"
  | "MULTIPLE_MATCHES";

export interface CustomerResolverInput {
  organizationId: string;
  /** Bot selected for the email (emails.bot_id); null for general rules, V1 emails and ties. */
  botId: string | null;
  /** Outcome of the bot selection of the rule evaluation. */
  botSelection: "AMBIGUOUS" | null;
  email: Pick<NormalizedEmail, "sender" | "recipients" | "cc">;
  /** emails.extracted_data */
  extracted: Record<string, string>;
}

export interface ResolvedDelivery {
  customerId: string;
  identifierId: string;
}

export type CustomerResolverResult =
  | { status: "DELIVER"; botId: string; deliveries: ResolvedDelivery[]; matchCount: number; policy: MultipleMatchPolicy }
  | { status: "UNASSIGNED"; botId: string | null; reason: UnassignedReason; matchCount: number; policy?: MultipleMatchPolicy };

/** Upper bound of distinct values looked up for one email (bounded queries). */
export const MAX_LOOKUP_VALUES = 200;

/** Normalized, de-duplicated, sorted values the email offers for the configured source. */
export function lookupValues(
  resolution: CustomerResolution,
  email: CustomerResolverInput["email"],
  extracted: Record<string, string>
): { type: CustomerIdentifierType; values: string[] } | null {
  if (resolution.source === "NONE") return null;
  const type: CustomerIdentifierType = resolution.identifierType ?? "EMAIL";

  let raw: string[];
  if (resolution.source === "RECIPIENT") raw = [...email.recipients, ...email.cc].map((address) => address.address);
  else if (resolution.source === "SENDER") raw = [email.sender.address];
  else {
    const value = resolution.field === undefined ? undefined : extracted[resolution.field];
    raw = value === undefined ? [] : [value];
  }

  const values = new Set<string>();
  for (const candidate of raw) {
    const normalized = normalizeIdentifier(type, candidate);
    if (normalized.ok) values.add(normalized.normalized);
  }
  return { type, values: [...values].sort().slice(0, MAX_LOOKUP_VALUES) };
}

/** Keeps eligible candidates, one per customer (bot-scoped identifier first, then the smallest id), sorted by customer. */
export function eligibleDeliveries(
  candidates: IdentifierCandidate[],
  scope: { organizationId: string; botId: string; type: CustomerIdentifierType; values: string[] }
): ResolvedDelivery[] {
  const values = new Set(scope.values);
  const byCustomer = new Map<string, IdentifierCandidate>();
  for (const candidate of candidates) {
    const eligible =
      candidate.organizationId === scope.organizationId &&
      candidate.type === scope.type &&
      values.has(candidate.normalizedValue) &&
      candidate.active &&
      (candidate.botId === null || candidate.botId === scope.botId) &&
      candidate.customerStatus === "ACTIVE" &&
      candidate.assigned;
    if (!eligible) continue;
    const current = byCustomer.get(candidate.customerId);
    if (!current || preferred(candidate, current)) byCustomer.set(candidate.customerId, candidate);
  }
  return [...byCustomer.values()]
    .sort((a, b) => compare(a.customerId, b.customerId))
    .map((candidate) => ({ customerId: candidate.customerId, identifierId: candidate.identifierId }));
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function preferred(candidate: IdentifierCandidate, current: IdentifierCandidate): boolean {
  const candidateScoped = candidate.botId !== null;
  const currentScoped = current.botId !== null;
  if (candidateScoped !== currentScoped) return candidateScoped;
  return compare(candidate.identifierId, current.identifierId) < 0;
}

export async function resolveCustomers(input: CustomerResolverInput, store: Pick<RoutingStore, "loadBot" | "findCandidates">): Promise<CustomerResolverResult> {
  const unassigned = (reason: UnassignedReason, extra: { matchCount?: number; policy?: MultipleMatchPolicy } = {}): CustomerResolverResult => ({
    status: "UNASSIGNED",
    botId: input.botId,
    reason,
    matchCount: extra.matchCount ?? 0,
    ...(extra.policy ? { policy: extra.policy } : {})
  });

  if (input.botId === null) return unassigned(input.botSelection === "AMBIGUOUS" ? "AMBIGUOUS_BOT" : "NO_BOT");
  const botId = input.botId;

  const bot = await store.loadBot(input.organizationId, botId);
  if (!bot || bot.organizationId !== input.organizationId || bot.id !== botId) return unassigned("BOT_NOT_FOUND");
  if (bot.status !== "ACTIVE") return unassigned("BOT_PAUSED");

  // The JSONB may have been edited outside the API: only the validated shape is used.
  const parsed = customerResolutionSchema.safeParse(bot.customerResolution);
  if (!parsed.success) return unassigned("INVALID_CONFIGURATION");
  const resolution: CustomerResolution = parsed.data;
  if (resolution.source === "NONE") return unassigned("NOT_CONFIGURED");

  const lookup = lookupValues(resolution, input.email, input.extracted);
  if (!lookup || lookup.values.length === 0) return unassigned("NO_IDENTIFIER");

  const scope = { organizationId: input.organizationId, botId, type: lookup.type, values: lookup.values };
  const deliveries = eligibleDeliveries(await store.findCandidates(scope), scope);
  const policy = resolution.onMultipleMatches;

  if (deliveries.length === 0) return unassigned("NO_MATCH");
  if (deliveries.length > 1 && policy !== "DELIVER_ALL") return unassigned("MULTIPLE_MATCHES", { matchCount: deliveries.length, policy });
  return { status: "DELIVER", botId, deliveries, matchCount: deliveries.length, policy };
}

export interface RouteEmailDeps {
  routing: RoutingStore;
  audit: AuditRecorder;
  logger: Logger;
}

/** Outcomes recorded in audit_logs (metadata.event). Normal outcomes (one customer, no bot, resolution NONE) are not audited. */
const AUDITED: Partial<Record<UnassignedReason, { event: string; description: string }>> = {
  AMBIGUOUS_BOT: { event: "routing.ambiguous_bot", description: "Email matched rules of several bots with the same priority; not routed" },
  BOT_NOT_FOUND: { event: "routing.unassigned", description: "Email not routed: bot not found" },
  BOT_PAUSED: { event: "routing.unassigned", description: "Email not routed: bot paused" },
  INVALID_CONFIGURATION: { event: "routing.unassigned", description: "Email not routed: invalid customer resolution configuration" },
  NO_IDENTIFIER: { event: "routing.unassigned", description: "Email not routed: no customer identifier in the email" },
  NO_MATCH: { event: "routing.unassigned", description: "Email not routed: no eligible customer matched" },
  MULTIPLE_MATCHES: { event: "routing.multiple_matches", description: "Email not routed: several customers matched" }
};

/**
 * Resolves the customers of a stored email and inserts its deliveries
 * (idempotent). Throws on any failure so the job is retried and the email
 * stays incomplete (never PROCESSED without its deliveries).
 */
export async function routeEmail(
  emailId: string,
  input: CustomerResolverInput & { botCandidateIds?: string[] },
  deps: RouteEmailDeps
): Promise<CustomerResolverResult> {
  const { organizationId } = input;
  let result: CustomerResolverResult;
  try {
    result = await resolveCustomers(input, deps.routing);
    if (result.status === "DELIVER") {
      await deps.routing.insertDeliveries(
        result.deliveries.map((delivery) => ({
          organization_id: organizationId,
          email_id: emailId,
          customer_id: delivery.customerId,
          bot_id: result.botId as string,
          resolution: "AUTOMATIC" as const,
          identifier_id: delivery.identifierId
        }))
      );
    }
  } catch (error) {
    deps.logger.error(
      { event: "routing.failed", err: serializeError(error), organizationId, emailId, botId: input.botId },
      "customer resolution failed; the email stays incomplete and is retried"
    );
    try {
      await deps.audit.recordEmailEvent({
        organizationId,
        emailId,
        event: "routing.failed",
        description: "Customer resolution failed; will be retried",
        metadata: { botId: input.botId, errorCode: errorCode(error) }
      });
    } catch (auditError) {
      deps.logger.warn({ err: serializeError(auditError), emailId }, "could not record the routing failure");
    }
    throw error;
  }

  const metadata: Record<string, unknown> = { botId: result.botId, matchCount: result.matchCount };
  if (result.status === "DELIVER") {
    deps.logger.info({ event: "routing.delivered", organizationId, emailId, botId: result.botId, customers: result.deliveries.length }, "email routed");
    if (result.matchCount > 1) {
      await deps.audit.recordEmailEvent({
        organizationId,
        emailId,
        event: "routing.multiple_matches",
        description: "Email delivered to every matching customer (DELIVER_ALL)",
        metadata: { ...metadata, policy: result.policy, delivered: result.deliveries.length }
      });
    }
    return result;
  }

  const audited = AUDITED[result.reason];
  deps.logger.info({ event: "routing.unassigned", organizationId, emailId, botId: result.botId, reason: result.reason }, "email not routed");
  if (audited) {
    await deps.audit.recordEmailEvent({
      organizationId,
      emailId,
      event: audited.event,
      description: audited.description,
      metadata: {
        ...metadata,
        reason: result.reason,
        ...(result.policy ? { policy: result.policy, delivered: 0 } : {}),
        ...(result.reason === "AMBIGUOUS_BOT" && input.botCandidateIds ? { botCandidateIds: input.botCandidateIds } : {})
      }
    });
  }
  return result;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) return code.slice(0, 50);
  return error instanceof Error ? error.name.slice(0, 50) : "UNKNOWN";
}
