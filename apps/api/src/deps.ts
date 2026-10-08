import type { EmailEventJob, SecretBox, SyncReason } from "@emailbot/shared";
import type { RealtimeEvent } from "@emailbot/types";
import type { ApiConfig } from "./config/env.js";
import type { RateLimitRedis } from "./infrastructure/rate-limit-store.js";
import type { GoogleOidcVerifier } from "./lib/google-oidc.js";
import type { PollSchedulerState } from "./modules/health/sync-health.js";
import type { AdminOperations, PrivilegedOperations, Repositories } from "./repositories/types.js";

export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

/** Validates a Supabase Auth access token (JWT). */
export interface IdentityVerifier {
  verifyAccessToken(accessToken: string): Promise<AuthenticatedUser | null>;
}

/** Producer side of the BullMQ queues. */
export interface JobQueue {
  enqueueEmailEvent(job: EmailEventJob, options?: { jobId?: string }): Promise<void>;
  /**
   * Coalesced account sync (shared logic with the worker): at most one
   * waiting sync per account plus one follow-up while it runs.
   */
  requestAccountSync(account: { id: string; organizationId: string }, reason: SyncReason, requestedBy?: string | null): Promise<"QUEUED" | "ALREADY_QUEUED">;
  /** A sync of this account is waiting, delayed or running. */
  isAccountSyncPending(emailAccountId: string): Promise<boolean>;
  /** Read-only: next run and interval (ms) of the worker's polling job scheduler; null when it does not exist. */
  pollSchedulerState(): Promise<PollSchedulerState | null>;
  close(): Promise<void>;
}

/** Single-use markers (OAuth state nonces). */
export interface NonceStore {
  /** Returns true the first time a nonce is seen, false on replay. */
  consume(nonce: string, ttlSeconds: number): Promise<boolean>;
}

/** One transactional e-mail (Libro de Reclamaciones). */
export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key = the provider returns the first result instead of sending again. */
  idempotencyKey: string;
  /** Provider tag (letters, digits, _ and - only). */
  category: string;
}

/**
 * Outcome of one e-mail request:
 * - SENT: the provider accepted it (accepted, not necessarily delivered);
 * - REJECTED: the provider confirmed it did NOT accept it (safe to retry with a new idempotency key);
 * - UNKNOWN: it may have been accepted (timeout, network error, 5xx, 409): retry with the SAME key and content.
 */
export type MailOutcome =
  | { outcome: "SENT"; providerMessageId: string | null }
  | { outcome: "REJECTED"; errorCode: "PROVIDER_REJECTED" | "PROVIDER_AUTH" | "PROVIDER_RATE_LIMITED" }
  | { outcome: "UNKNOWN"; errorCode: "PROVIDER_TIMEOUT" | "PROVIDER_NETWORK" | "PROVIDER_UNAVAILABLE" | "PROVIDER_CONFLICT" | "PROVIDER_ERROR" };

/** Transactional e-mail provider. Never throws; never logs addresses or content. */
export interface TransactionalMailer {
  send(email: OutgoingEmail): Promise<MailOutcome>;
}

export interface ReadinessCheck {
  name: string;
  check(): Promise<void>;
}

/**
 * Everything the HTTP layer depends on. Built from real infrastructure in
 * server.ts and from fakes in tests, so routes never import Supabase/Redis.
 */
export interface AppDeps {
  config: ApiConfig;
  identity: IdentityVerifier;
  /** Per-request repositories bound to the caller's JWT (RLS enforced). */
  repositories(accessToken: string): Repositories;
  /** Service-role operations (RLS bypassed). */
  privileged: PrivilegedOperations;
  /** Platform administration: admin.* functions only (service role, actor re-checked in the database). */
  admin: AdminOperations;
  queue: JobQueue;
  secretBox: SecretBox;
  fetch: typeof fetch;
  readinessChecks: ReadinessCheck[];
  oauthNonces: NonceStore;
  /** Redis for the shared rate-limit store (per-instance counters when absent or failing). */
  rateLimitRedis?: RateLimitRedis;
  /** Pub/Sub push OIDC verification (default: Google's JWKS through deps.fetch). */
  pubsubVerifier?: GoogleOidcVerifier;
  /** Transactional e-mail (RESEND_API_KEY + TRANSACTIONAL_EMAIL_FROM); absent = the complaints book e-mails stay pending. */
  mailer?: TransactionalMailer;
  /** Publishes realtime events to every API instance through Redis (portal signals of manual deliveries). */
  realtimePublisher?: { publish(event: RealtimeEvent): Promise<void> };
}
