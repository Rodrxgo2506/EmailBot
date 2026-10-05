import type { EmailEventJob, SecretBox, SyncReason } from "@emailbot/shared";
import type { RealtimeEvent } from "@emailbot/types";
import type { ApiConfig } from "./config/env.js";
import type { RateLimitRedis } from "./infrastructure/rate-limit-store.js";
import type { GoogleOidcVerifier } from "./lib/google-oidc.js";
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
  close(): Promise<void>;
}

/** Single-use markers (OAuth state nonces). */
export interface NonceStore {
  /** Returns true the first time a nonce is seen, false on replay. */
  consume(nonce: string, ttlSeconds: number): Promise<boolean>;
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
  /** Publishes realtime events to every API instance through Redis (portal signals of manual deliveries). */
  realtimePublisher?: { publish(event: RealtimeEvent): Promise<void> };
}
