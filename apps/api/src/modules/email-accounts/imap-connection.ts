import { createHmac } from "node:crypto";
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
import { createLoginThrottle, LockoutStoreUnavailableError, LOGIN_LOCKOUT, withTimeout, type LockoutPolicy } from "../../infrastructure/login-throttle.js";
import { INCR_SCRIPT, type RateLimitRedis } from "../../infrastructure/rate-limit-store.js";
import { AppError, serviceUnavailable, unprocessable } from "../../lib/errors.js";

/*
 * IMAP E3/E4: connection test of a mailbox (POST /email-accounts/imap/test and,
 * before anything is stored, POST /email-accounts/imap). The transport is the
 * one the worker uses (@emailbot/shared imap-client.ts): E1 SSRF checks, a
 * validated IP literal with the DNS name for SNI / certificate, TLS on 993 or
 * mandatory STARTTLS on 143, the login only after TLS, EXAMINE INBOX
 * (read-only), LOGOUT, every client closed (also at the deadline).
 *
 * Abuse protections, on top of the per-IP route limit (RATE_LIMITS) and the
 * caller's role / plan / account checks done by the routes, in this order
 * (test()), before any DNS query or connection:
 *   1. attempts per user and per organization. Every request that reaches this
 *      point counts, whatever its outcome (refused destination, DNS / TLS failure,
 *      timeout);
 *   2. login lockout (login-throttle.ts, IMAP_LOGIN_LOCKOUT): refused LOGINS only
 *      (never DNS, TLS, timeout or validation errors) lock the mailbox after 10
 *      within 15 min and the whole organization after 30, for 15 min, without
 *      contacting the server;
 *   3. destination check (E1 SSRF, specific codes);
 *   4. concurrency: one test per organization (shared), a few per API instance;
 *   5. global rate per external mailbox (M2): refused logins against the same
 *      (server, username) from ALL organizations, IMAP_CONNECTION_LIMITS.perMailboxGlobal;
 *   6. the connection, IMAP_PROBE_DEADLINE_MS for the whole test, then a forced close.
 *
 * Shared state (E4, B4): 1, 2, the per-organization slot of 4 and 5 live in Redis
 * ONLY. There is no per-instance fallback here: without Redis, or when it fails or
 * does not answer within storeTimeoutMs, the request is refused (503
 * SERVICE_UNAVAILABLE) before any DNS query or socket, so N API instances can never
 * multiply the limits. (The portal login and the global per-IP limit keep their
 * own fallback.)
 *
 * Keys (E4, B6): an external mailbox is (server, username), compared without letter
 * case and without the port (993 and 143 reach the same account). Its keys are
 * HMAC-SHA-256 with IMAP_RATE_LIMIT_SECRET (domain separated per purpose), so the
 * Redis keys cannot be used to test candidate usernames offline. Without the secret
 * the IMAP routes refuse (503); there is no unkeyed fallback. User / organization
 * keys carry the internal ids only.
 *
 * Public errors use fixed codes and messages; logs carry the code only (no
 * password, username, host, address, key or server text).
 */

export const IMAP_CONNECTION_LIMITS = {
  perUser: { max: 10, windowMs: 10 * 60_000 },
  perOrganization: { max: 20, windowMs: 10 * 60_000 },
  concurrentPerOrganization: 1,
  /** Local resource cap of one API instance (not a security limit, so not shared). */
  concurrentPerInstance: 4,
  /** Lease of an organization's shared slot: longer than a whole test (DNS + IMAP_PROBE_DEADLINE_MS); frees it if an instance dies. */
  concurrencyLeaseMs: 90_000,
  /**
   * M2: refused logins against one external mailbox from every organization, per fixed
   * window. One organization contributes at most IMAP_LOGIN_LOCKOUT.mailbox.maxFailures (10)
   * before its own mailbox lock, so reaching 30 takes at least 3 organizations; it is a rate
   * that expires with its window, never a lock, and successful logins do not count.
   */
  perMailboxGlobal: { maxRefusedLogins: 30, windowMs: 15 * 60_000 },
  /** Redis answer deadline for every shared check (then 503, never a guess). */
  storeTimeoutMs: 2_000
} as const;

/** Refused logins: per mailbox (the portal's 10 / 15 min) and per organization (higher: several mailboxes are set up at once). */
export const IMAP_LOGIN_LOCKOUT = {
  mailbox: LOGIN_LOCKOUT,
  organization: { maxFailures: 30, failureWindowMs: 15 * 60_000, lockMs: 15 * 60_000 }
} as const satisfies Record<string, LockoutPolicy>;

/* ---------------------------------------------------------------- *
 * Keys (B6)
 * ---------------------------------------------------------------- */

const KEY_DOMAIN = "emailbot-imap-limit:v1";

/** IMAP_RATE_LIMIT_SECRET decoded, or null when absent / not a strict base64 of >= 32 bytes (then IMAP refuses). */
export function imapLimitSecret(value: string | null | undefined): Buffer | null {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value && bytes.length >= 32 ? bytes : null;
}

const canonical = (value: string) => value.trim().toLowerCase();
const hmac = (secret: Buffer, purpose: string, parts: string[]) =>
  createHmac("sha256", secret).update([`${KEY_DOMAIN}:${purpose}`, ...parts].join("\u0000")).digest("hex");

/**
 * Lockout key of one external mailbox in one organization: the same account on the same
 * server whatever the letter case of its username or the port (993 / 143). Only a key:
 * the username sent to the server is never changed.
 */
export function imapMailboxLockKey(secret: Buffer, organizationId: string, host: string, username: string): string {
  return `mailbox:${hmac(secret, "mailbox", [organizationId, canonical(host), canonical(username)])}`;
}

/** Global (all organizations) key of one external mailbox: server + username only. */
export function imapMailboxGlobalKey(secret: Buffer, host: string, username: string): string {
  return `target:${hmac(secret, "target", [canonical(host), canonical(username)])}`;
}

/* ---------------------------------------------------------------- *
 * Atomic Redis scripts (M2, concurrency)
 * ---------------------------------------------------------------- */

/** Reserves one unit of a fixed window (ARGV[1] ms) capped at ARGV[2]: 1 reserved, 0 refused (nothing kept). */
export const RESERVE_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 or redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if current > tonumber(ARGV[2]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;

/** Gives one unit back (never below zero; the window's expiry is kept). */
export const RELEASE_SCRIPT = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current > 0 then redis.call('DECR', KEYS[1]) end
return 0
`;

/** Takes a concurrency slot (max ARGV[1]) leased for ARGV[2] ms: 1 taken, 0 busy. */
export const ACQUIRE_SLOT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
  return 0
end
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

/** A shared limit could not be checked (no Redis, error, timeout): the operation is refused. */
class ImapLimitsUnavailableError extends Error {
  constructor(override readonly cause?: unknown) {
    super("IMAP limits store unavailable");
    this.name = "ImapLimitsUnavailableError";
  }
}

/* ---------------------------------------------------------------- *
 * Connection test
 * ---------------------------------------------------------------- */

export interface ImapConnectionInput {
  host: string;
  port: number;
  security: ImapSecurity;
  username: string;
  password: string;
}

const tooMany = (code: string, message: string) => new AppError(429, code, message);
const RATE_LIMITED_MESSAGE = "Too many IMAP connection attempts. Try again later.";

const PUBLIC_FAILURES: Record<string, string> = {
  IMAP_AUTH_FAILED: "The IMAP server refused the username or password",
  IMAP_HOST_FORBIDDEN: "The IMAP server is not an allowed destination",
  IMAP_TLS_FAILED: "The IMAP server's certificate or TLS connection could not be verified",
  IMAP_STARTTLS_UNAVAILABLE: "The IMAP server does not offer a secure (STARTTLS) connection on port 143",
  IMAP_DNS_FAILED: "The IMAP server name could not be resolved",
  IMAP_TIMEOUT: "The IMAP server did not answer in time",
  IMAP_UNREACHABLE: "The IMAP server could not be reached",
  IMAP_FAILED: "The connection to the IMAP server failed",
  IMAP_INBOX_UNAVAILABLE: "The IMAP INBOX could not be opened read-only",
  IMAP_RESPONSE_TOO_LARGE: "The IMAP server sent an answer larger than allowed"
};

export interface ImapConnectionTester {
  /** Attempt limits, lockout, destination check (E1), concurrency, global rate, then the connection test. The INBOX position gives the initial cursor. */
  test(context: { organizationId: string; userId: string; log: FastifyBaseLogger }, input: ImapConnectionInput): Promise<ImapInboxPosition>;
}

export function createImapConnectionTester(deps: AppDeps, log: FastifyBaseLogger): ImapConnectionTester {
  const secret = imapLimitSecret(deps.config.imapRateLimitSecret);
  const redis: RateLimitRedis | undefined = deps.rateLimitRedis;
  const timeoutMs = IMAP_CONNECTION_LIMITS.storeTimeoutMs;

  async function shared(script: string, key: string, args: Array<string | number>): Promise<unknown> {
    if (!redis) throw new ImapLimitsUnavailableError();
    try {
      return await withTimeout(redis.eval(script, 1, key, ...args), timeoutMs);
    } catch (error) {
      throw new ImapLimitsUnavailableError(error);
    }
  }
  const hit = async (key: string, windowMs: number) => Number(((await shared(INCR_SCRIPT, `emailbot-imap-attempt:${key}`, [windowMs])) as [number, number])[0]);
  const lockout = (policy: LockoutPolicy) =>
    createLoginThrottle(redis, { prefix: "emailbot-imap-login:", onFallback: () => undefined, policy, failClosed: true, timeoutMs });
  const mailboxLockout = lockout(IMAP_LOGIN_LOCKOUT.mailbox);
  const organizationLockout = lockout(IMAP_LOGIN_LOCKOUT.organization);
  const slotKey = (organizationId: string) => `emailbot-imap-busy:org:${organizationId}`;
  const globalKey = (key: string) => `emailbot-imap-${key}`;

  /** Bookkeeping after the connection (it already happened): a store failure is logged, never turned into another answer. */
  const after = (what: string, operation: () => Promise<unknown>) =>
    operation().catch((error: unknown) =>
      log.warn({ event: "imap.limits_bookkeeping_failed", operation: what, err: serializeError(error instanceof Error && "cause" in error ? error.cause : error) }, "IMAP limit bookkeeping failed")
    );

  let runningHere = 0;

  /** Destination check (E1) with its specific codes, before any connection; no DNS answer is returned. */
  async function checkDestination(input: Pick<ImapConnectionInput, "host" | "port" | "security">): Promise<void> {
    try {
      await resolveImapDestination({ host: input.host, port: input.port, security: input.security }, deps.imapResolver ? { resolver: deps.imapResolver } : {});
    } catch (error) {
      if (error instanceof ImapDestinationError) throw unprocessable(error.message, error.code);
      throw error;
    }
  }

  async function run(organizationId: string, userId: string, requestLog: FastifyBaseLogger, input: ImapConnectionInput, key: Buffer): Promise<ImapInboxPosition> {
    const { perUser, perOrganization, perMailboxGlobal } = IMAP_CONNECTION_LIMITS;
    if ((await hit(`user:${userId}`, perUser.windowMs)) > perUser.max || (await hit(`org:${organizationId}`, perOrganization.windowMs)) > perOrganization.max) {
      throw tooMany("IMAP_TEST_RATE_LIMITED", RATE_LIMITED_MESSAGE);
    }

    const mailboxKey = imapMailboxLockKey(key, organizationId, input.host, input.username);
    const organizationKey = `org:${organizationId}`;
    if ((await mailboxLockout.lockedFor(mailboxKey)) > 0 || (await organizationLockout.lockedFor(organizationKey)) > 0) {
      throw tooMany("IMAP_LOGIN_LOCKED", "Too many refused IMAP logins. Try again later.");
    }

    await checkDestination(input);

    if (runningHere >= IMAP_CONNECTION_LIMITS.concurrentPerInstance) throw tooMany("IMAP_TEST_BUSY", "Another IMAP connection test is running. Try again in a moment.");
    runningHere += 1;
    try {
      const slot = Number(await shared(ACQUIRE_SLOT_SCRIPT, slotKey(organizationId), [IMAP_CONNECTION_LIMITS.concurrentPerOrganization, IMAP_CONNECTION_LIMITS.concurrencyLeaseMs]));
      if (slot !== 1) throw tooMany("IMAP_TEST_BUSY", "Another IMAP connection test is running. Try again in a moment.");
      try {
        const target = globalKey(imapMailboxGlobalKey(key, input.host, input.username));
        if (Number(await shared(RESERVE_SCRIPT, target, [perMailboxGlobal.windowMs, perMailboxGlobal.maxRefusedLogins])) !== 1) {
          // Same answer as the other attempt limits: nothing tells whether other organizations use this mailbox.
          requestLog.info({ event: "imap.connection_test", organizationId, outcome: "GLOBAL_RATE_LIMITED", port: input.port }, "IMAP connection test refused by the global mailbox rate");
          throw tooMany("IMAP_TEST_RATE_LIMITED", RATE_LIMITED_MESSAGE);
        }

        const started = Date.now();
        try {
          const position = await probeImapInbox(
            { host: input.host, port: input.port, security: input.security },
            { username: input.username, password: input.password },
            { ...(deps.imapResolver ? { resolver: deps.imapResolver } : {}), ...(deps.imapProbeOpen ? { open: deps.imapProbeOpen } : {}) }
          );
          // A successful login does not use the global budget.
          await after("refund_global", () => shared(RELEASE_SCRIPT, target, []));
          await after("reset_mailbox", () => mailboxLockout.recordSuccess(mailboxKey));
          requestLog.info({ event: "imap.connection_test", organizationId, outcome: "OK", port: input.port, durationMs: Date.now() - started }, "IMAP connection test passed");
          return position;
        } catch (error) {
          const failure = classifyImapFailure(error);
          if (failure.kind === "AUTH") {
            // The reservation stays: it is this refused login in the global window.
            await after("record_mailbox_failure", () => mailboxLockout.recordFailure(mailboxKey));
            await after("record_organization_failure", () => organizationLockout.recordFailure(organizationKey));
          } else {
            await after("refund_global", () => shared(RELEASE_SCRIPT, target, []));
          }
          requestLog.info(
            { event: "imap.connection_test", organizationId, outcome: failure.code, kind: failure.kind, port: input.port, durationMs: Date.now() - started },
            "IMAP connection test failed"
          );
          throw unprocessable(PUBLIC_FAILURES[failure.code] ?? PUBLIC_FAILURES.IMAP_FAILED!, failure.code);
        }
      } finally {
        await after("release_slot", () => shared(RELEASE_SCRIPT, slotKey(organizationId), []));
      }
    } finally {
      runningHere -= 1;
    }
  }

  return {
    async test({ organizationId, userId, log: requestLog }, input) {
      // B6: no key, no keyed limits; never an unkeyed hash.
      if (!secret) throw serviceUnavailable("IMAP connection checks are not configured", "PROVIDER_NOT_CONFIGURED");
      try {
        return await run(organizationId, userId, requestLog, input, secret);
      } catch (error) {
        if (error instanceof ImapLimitsUnavailableError || error instanceof LockoutStoreUnavailableError) {
          // B4: the shared limits cannot be guaranteed: refuse before any connection (never a "wrong password").
          requestLog.warn({ event: "imap.limits_unavailable", organizationId, err: serializeError(error.cause ?? error) }, "IMAP limits store unavailable; connection test refused");
          throw serviceUnavailable("IMAP connection checks are temporarily unavailable. Try again later.");
        }
        throw error;
      }
    }
  };
}
