import type { EmailEventJob, SecretBox } from "@emailbot/shared";
import type { ApiConfig } from "./config/env.js";
import type { RateLimitRedis } from "./infrastructure/rate-limit-store.js";
import type { PrivilegedOperations, Repositories } from "./repositories/types.js";

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
  queue: JobQueue;
  secretBox: SecretBox;
  fetch: typeof fetch;
  readinessChecks: ReadinessCheck[];
  oauthNonces: NonceStore;
  /** Redis for the shared rate-limit store (per-instance counters when absent or failing). */
  rateLimitRedis?: RateLimitRedis;
}
