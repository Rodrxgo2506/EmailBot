import { legalAcceptanceStatus } from "@emailbot/types";
import type { PrivilegedOperations } from "../repositories/types.js";

declare module "fastify" {
  interface FastifyContextConfig {
    /**
     * Authenticated route usable WITHOUT having accepted the current legal
     * versions: only the routes that resolve that state (GET /api/me and
     * POST /api/me/legal-acceptance). Every other `authenticate` route answers
     * 403 LEGAL_ACCEPTANCE_REQUIRED until the user accepts.
     */
    allowWithoutLegalAcceptance?: boolean;
  }
  interface FastifyInstance {
    legalAcceptance: LegalAcceptanceGate;
  }
}

/** How long a positive answer is reused before reading the database again. */
export const LEGAL_ACCEPTANCE_CACHE_MS = 5 * 60 * 1000;
const MAX_CACHED_USERS = 10_000;

/**
 * EmailBot V2 phase 7: whether a user accepted the CURRENT Terms and Privacy
 * versions (@emailbot/types CURRENT_LEGAL_VERSIONS), the API-side barrier
 * behind `authenticate` and the panel's realtime handshake.
 *
 * Only positive answers are cached, per instance and briefly: an acceptance is
 * never withdrawn while the user exists, and new versions ship with a deploy
 * (new process, empty cache). A user without acceptance is read from the
 * database on every request, so accepting takes effect immediately.
 */
export interface LegalAcceptanceGate {
  isAccepted(userId: string): Promise<boolean>;
  /** Called after the acceptance was recorded and confirmed. */
  remember(userId: string): void;
}

export function createLegalAcceptanceGate(
  privileged: Pick<PrivilegedOperations, "listLegalAcceptances">,
  options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}
): LegalAcceptanceGate {
  const ttlMs = options.ttlMs ?? LEGAL_ACCEPTANCE_CACHE_MS;
  const maxEntries = options.maxEntries ?? MAX_CACHED_USERS;
  const now = options.now ?? Date.now;
  const acceptedUntil = new Map<string, number>();

  const remember = (userId: string) => {
    acceptedUntil.delete(userId);
    if (acceptedUntil.size >= maxEntries) {
      const oldest = acceptedUntil.keys().next().value;
      if (oldest !== undefined) acceptedUntil.delete(oldest);
    }
    acceptedUntil.set(userId, now() + ttlMs);
  };

  return {
    async isAccepted(userId) {
      const until = acceptedUntil.get(userId);
      if (until !== undefined && until > now()) return true;
      acceptedUntil.delete(userId);
      const accepted = legalAcceptanceStatus(await privileged.listLegalAcceptances(userId)).accepted;
      if (accepted) remember(userId);
      return accepted;
    },
    remember
  };
}
