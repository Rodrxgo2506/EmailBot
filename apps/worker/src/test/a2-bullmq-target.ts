import type { Redis } from "ioredis";

/*
 * IMAP A2 test helper: ownership of the throwaway Valkey used by the opt-in real-BullMQ suites
 * (imap-a2-isolation.test.ts, imap-a2-processing-risk.test.ts). Both empty the database between scenarios,
 * and the URL guard (apps/api/src/test/valkey-target.ts) only proves the target is on loopback: a developer's
 * local Redis on 127.0.0.1 would pass it. So before anything is deleted:
 *
 *   - claim: the database must be EMPTY (or already carry this marker from an earlier run of these suites);
 *     anything else (e.g. a dev Redis with data) is refused, nothing is touched;
 *   - one suite at a time: a run key taken with SET NX; a second suite running in parallel against the same
 *     database fails at once instead of emptying it under the first one (run them with --no-file-parallelism);
 *   - reset: FLUSHDB only while this suite holds the run key; the marker and the run key are written back.
 *
 * Both keys expire (MARKER_TTL_MS), so a stale marker never keeps a database "owned" for long.
 */

const MARKER = "emailbot-a2-test:claimed";
const RUNNING = "emailbot-a2-test:running";
const MARKER_TTL_MS = 30 * 60_000;

export class ForeignValkeyError extends Error {
  constructor(reason: string) {
    super(`A2_BULLMQ_URL refused (${reason}): use a throwaway Valkey and run the A2 BullMQ suites with --no-file-parallelism`);
    this.name = "ForeignValkeyError";
  }
}

/** Takes the database for `owner` (a suite name), or throws without changing anything. */
export async function claimThrowawayValkey(admin: Redis, owner: string): Promise<void> {
  if ((await admin.exists(MARKER)) !== 1 && (await admin.dbsize()) !== 0) throw new ForeignValkeyError("the database is not empty and was not created by these suites");
  if ((await admin.set(RUNNING, owner, "PX", MARKER_TTL_MS, "NX")) !== "OK") throw new ForeignValkeyError("another A2 suite is using this database");
  await admin.set(MARKER, "1", "PX", MARKER_TTL_MS);
}

/** Empties the database between scenarios; only while `owner` holds it. */
export async function resetClaimedValkey(admin: Redis, owner: string): Promise<void> {
  if ((await admin.get(RUNNING)) !== owner) throw new ForeignValkeyError("this suite does not hold the database");
  await admin.flushdb();
  await admin.set(MARKER, "1", "PX", MARKER_TTL_MS);
  await admin.set(RUNNING, owner, "PX", MARKER_TTL_MS);
}

/**
 * Cleanup steps of one scenario, run in reverse order in `finally` (also when the scenario fails half-way).
 * Every step runs even if an earlier one throws; steps already done by the scenario itself are harmless again.
 */
export function cleanupSteps() {
  const steps: Array<() => unknown> = [];
  return {
    defer(step: () => unknown): void {
      steps.push(step);
    },
    async run(): Promise<void> {
      while (steps.length > 0) {
        try {
          await (steps.pop() as () => unknown)();
        } catch {
          // already closed
        }
      }
    }
  };
}

export type CleanupSteps = ReturnType<typeof cleanupSteps>;

/** Lets the next suite take the database (data left in place; the next reset empties it). */
export async function releaseClaimedValkey(admin: Redis, owner: string): Promise<void> {
  if ((await admin.get(RUNNING)) === owner) await admin.del(RUNNING);
}
