import { createHash } from "node:crypto";
import {
  classifyImapFailure,
  ImapDestinationError,
  probeImapInbox,
  resolveImapDestination,
  serializeError,
  type ImapInboxPosition
} from "@emailbot/shared";
import type { ImapSecurity } from "@emailbot/types";
import type { FastifyBaseLogger } from "fastify";
import type { AppDeps } from "../../deps.js";
import { createLoginThrottle, LOGIN_LOCKOUT, type LockoutPolicy } from "../../infrastructure/login-throttle.js";
import { createResilientRateLimitStore } from "../../infrastructure/rate-limit-store.js";
import { AppError, unprocessable } from "../../lib/errors.js";

/*
 * IMAP E3: connection test of a mailbox (POST /email-accounts/imap/test and,
 * before anything is stored, POST /email-accounts/imap). The transport is the
 * one the worker uses (@emailbot/shared imap-client.ts): E1 SSRF checks, a
 * validated IP literal with the DNS name for SNI / certificate, TLS on 993 or
 * mandatory STARTTLS on 143, the login only after TLS, EXAMINE INBOX
 * (read-only), LOGOUT, every client closed (also at the deadline).
 *
 * Abuse protections, on top of the per-IP route limit (RATE_LIMITS) and the
 * caller's role / plan / account checks done by the routes, in this order
 * (test()), before any DNS query or connection:
 *   1. attempts per user and per organization (shared rate-limit store: Redis,
 *      per-instance fallback). Every request that reaches this point counts,
 *      whatever its outcome (refused destination, DNS / TLS failure, timeout);
 *   2. login lockout (login-throttle.ts, IMAP_LOGIN_LOCKOUT): refused LOGINS only
 *      (never DNS, TLS, timeout or validation errors) lock the mailbox after 10
 *      within 15 min and the whole organization after 30, for 15 min, without
 *      contacting the server. The mailbox is (organization, server, username):
 *      the username is compared case-insensitively and the port is not part of it
 *      (993 and 143 reach the same account). Keys are hashes / ids, never the host
 *      or the username;
 *   3. destination check (E1 SSRF, specific codes);
 *   4. concurrency (per API instance): one test per organization, a few per instance;
 *   5. the connection, IMAP_PROBE_DEADLINE_MS for the whole test, then a forced close.
 * Only 993 / 143 and public DNS names are ever dialled (validation + E1): the
 * endpoint cannot probe ports or internal hosts.
 *
 * Public errors use fixed codes and messages; logs carry the code only (no
 * password, username, host, address or server text).
 */

export const IMAP_CONNECTION_LIMITS = {
  perUser: { max: 10, windowMs: 10 * 60_000 },
  perOrganization: { max: 20, windowMs: 10 * 60_000 },
  concurrentPerOrganization: 1,
  concurrentPerInstance: 4
} as const;

/** Refused logins: per mailbox (the portal's 10 / 15 min) and per organization (higher: several mailboxes are set up at once). */
export const IMAP_LOGIN_LOCKOUT = {
  mailbox: LOGIN_LOCKOUT,
  organization: { maxFailures: 30, failureWindowMs: 15 * 60_000, lockMs: 15 * 60_000 }
} as const satisfies Record<string, LockoutPolicy>;

/**
 * Lockout key of one external mailbox: the same account on the same server whatever
 * the letter case of its username or the port (993 / 143). Used only as a key: the
 * username sent to the server is never changed.
 */
export function imapMailboxLockKey(organizationId: string, host: string, username: string): string {
  return `mailbox:${createHash("sha256").update([organizationId, host.trim().toLowerCase(), username.trim().toLowerCase()].join("\u0000")).digest("hex")}`;
}

export interface ImapConnectionInput {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  password: string;
}

const tooMany = (code: string, message: string) => new AppError(429, code, message);

const PUBLIC_FAILURES: Record<string, string> = {
  IMAP_AUTH_FAILED: "The IMAP server refused the username or password",
  IMAP_HOST_FORBIDDEN: "The IMAP server is not an allowed destination",
  IMAP_TLS_FAILED: "The IMAP server's certificate or TLS connection could not be verified",
  IMAP_STARTTLS_UNAVAILABLE: "The IMAP server does not offer a secure (STARTTLS) connection on port 143",
  IMAP_DNS_FAILED: "The IMAP server name could not be resolved",
  IMAP_TIMEOUT: "The IMAP server did not answer in time",
  IMAP_UNREACHABLE: "The IMAP server could not be reached",
  IMAP_FAILED: "The connection to the IMAP server failed",
  IMAP_INBOX_UNAVAILABLE: "The IMAP INBOX could not be opened read-only"
};

/** Fixed-window counter on the shared rate-limit store (same mechanism as the global per-IP limit). */
interface AttemptCounter {
  hit(key: string, windowMs: number): Promise<number>;
}

export interface ImapConnectionTester {
  /** Attempt limits, lockout, destination check (E1), concurrency, then the connection test. The INBOX position gives the initial cursor. */
  test(context: { organizationId: string; userId: string; log: FastifyBaseLogger }, input: ImapConnectionInput): Promise<ImapInboxPosition>;
}

export function createImapConnectionTester(deps: AppDeps, log: FastifyBaseLogger): ImapConnectionTester {
  let lastFallbackLog = 0;
  const onFallback = (error: unknown) => {
    const now = Date.now();
    if (now - lastFallbackLog < 60_000) return;
    lastFallbackLog = now;
    log.warn({ err: serializeError(error) }, "IMAP connection limits using per-instance counters");
  };

  const Store = createResilientRateLimitStore(deps.rateLimitRedis, { prefix: "emailbot-imap-attempt:", onFallback });
  const store = new Store();
  const attempts: AttemptCounter = {
    hit: (key, windowMs) =>
      new Promise((resolve, reject) =>
        store.incr(key, (error, result) => (error || !result ? reject(error ?? new Error("rate limit store")) : resolve(result.current)), windowMs)
      )
  };
  const mailboxLockout = createLoginThrottle(deps.rateLimitRedis, { prefix: "emailbot-imap-login:", onFallback, policy: IMAP_LOGIN_LOCKOUT.mailbox });
  const organizationLockout = createLoginThrottle(deps.rateLimitRedis, { prefix: "emailbot-imap-login:", onFallback, policy: IMAP_LOGIN_LOCKOUT.organization });

  /** Destination check (E1) with its specific codes, before any connection; no DNS answer is returned. */
  async function checkDestination(input: Pick<ImapConnectionInput, "host" | "port" | "security">): Promise<void> {
    try {
      await resolveImapDestination({ host: input.host, port: input.port, security: input.security }, deps.imapResolver ? { resolver: deps.imapResolver } : {});
    } catch (error) {
      if (error instanceof ImapDestinationError) throw unprocessable(error.message, error.code);
      throw error;
    }
  }

  const running = new Map<string, number>();
  let total = 0;
  const acquire = (organizationId: string): (() => void) | null => {
    const current = running.get(organizationId) ?? 0;
    if (current >= IMAP_CONNECTION_LIMITS.concurrentPerOrganization || total >= IMAP_CONNECTION_LIMITS.concurrentPerInstance) return null;
    running.set(organizationId, current + 1);
    total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      total -= 1;
      const left = (running.get(organizationId) ?? 1) - 1;
      if (left > 0) running.set(organizationId, left);
      else running.delete(organizationId);
    };
  };

  return {
    async test({ organizationId, userId, log: requestLog }, input) {
      const { perUser, perOrganization } = IMAP_CONNECTION_LIMITS;
      if ((await attempts.hit(`user:${userId}`, perUser.windowMs)) > perUser.max || (await attempts.hit(`org:${organizationId}`, perOrganization.windowMs)) > perOrganization.max) {
        throw tooMany("IMAP_TEST_RATE_LIMITED", "Too many IMAP connection attempts. Try again later.");
      }

      const mailboxKey = imapMailboxLockKey(organizationId, input.host, input.username);
      const organizationKey = `org:${organizationId}`;
      if ((await mailboxLockout.lockedFor(mailboxKey)) > 0 || (await organizationLockout.lockedFor(organizationKey)) > 0) {
        throw tooMany("IMAP_LOGIN_LOCKED", "Too many refused IMAP logins. Try again later.");
      }

      await checkDestination(input);

      const release = acquire(organizationId);
      if (!release) throw tooMany("IMAP_TEST_BUSY", "Another IMAP connection test is running. Try again in a moment.");

      const started = Date.now();
      try {
        const position = await probeImapInbox(
          { host: input.host, port: input.port, security: input.security },
          { username: input.username, password: input.password },
          { ...(deps.imapResolver ? { resolver: deps.imapResolver } : {}), ...(deps.imapProbeOpen ? { open: deps.imapProbeOpen } : {}) }
        );
        await mailboxLockout.recordSuccess(mailboxKey);
        requestLog.info({ event: "imap.connection_test", organizationId, outcome: "OK", port: input.port, durationMs: Date.now() - started }, "IMAP connection test passed");
        return position;
      } catch (error) {
        const failure = classifyImapFailure(error);
        if (failure.kind === "AUTH") {
          await mailboxLockout.recordFailure(mailboxKey);
          await organizationLockout.recordFailure(organizationKey);
        }
        requestLog.info(
          { event: "imap.connection_test", organizationId, outcome: failure.code, kind: failure.kind, port: input.port, durationMs: Date.now() - started },
          "IMAP connection test failed"
        );
        throw unprocessable(PUBLIC_FAILURES[failure.code] ?? PUBLIC_FAILURES.IMAP_FAILED!, failure.code);
      } finally {
        release();
      }
    }
  };
}
