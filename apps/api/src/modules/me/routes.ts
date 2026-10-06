import { serializeError } from "@emailbot/shared";
import { CURRENT_LEGAL_VERSIONS, legalAcceptanceStatus } from "@emailbot/types";
import { legalAcceptanceSchema } from "@emailbot/validation";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../../deps.js";
import { conflict } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";

export function meRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    /**
     * Current user, the organizations they belong to (with role) and whether
     * they are a platform administrator (EmailBot V2 phase 6). The flag only
     * adapts the web UI; /api/admin/* checks it again on every request. A
     * failed lookup reports false instead of breaking the panel.
     *
     * `legal` (phase 7): whether the user accepted the CURRENT Terms and
     * Privacy versions; the web app shows the acceptance screen until they
     * do. Unlike the admin flag it is not defaulted: a failed lookup fails
     * the request rather than skipping the acceptance.
     */
    app.get("/me", { preHandler: [app.authenticate], config: { allowWithoutLegalAcceptance: true } }, async (request) => {
      const auth = getAuth(request);
      const [memberships, isPlatformAdmin, acceptances] = await Promise.all([
        auth.repos.memberships.listForUser(auth.user.id),
        deps.admin.isPlatformAdmin(auth.user.id).catch((error: unknown) => {
          request.log.warn({ err: serializeError(error) }, "platform admin lookup failed; reported as false");
          return false;
        }),
        deps.privileged.listLegalAcceptances(auth.user.id)
      ]);
      return { user: auth.user, memberships, isPlatformAdmin, legal: legalAcceptanceStatus(acceptances) };
    });

    /**
     * Accepts the CURRENT legal versions (phase 7). The body carries the
     * versions the user was shown; if they are no longer current the request
     * is refused (409) so a stale page cannot accept a text the user has not
     * seen. What is recorded never comes from the body: the user is the one of
     * the verified token, the versions are the server's and the time is the
     * database's. Unknown fields (user id, date...) are rejected (400).
     */
    app.post(
      "/me/legal-acceptance",
      { preHandler: [app.authenticate], config: { rateLimit: RATE_LIMITS.legalAcceptance, allowWithoutLegalAcceptance: true } },
      async (request) => {
        const auth = getAuth(request);
        const shown = parseWith(legalAcceptanceSchema, request.body);
        if (shown.termsVersion !== CURRENT_LEGAL_VERSIONS.terms || shown.privacyVersion !== CURRENT_LEGAL_VERSIONS.privacy) {
          throw conflict("The legal documents changed; reload to see the current versions", "LEGAL_VERSION_OUTDATED");
        }
        await deps.privileged.recordLegalAcceptance(auth.user.id, CURRENT_LEGAL_VERSIONS);
        const legal = legalAcceptanceStatus(await deps.privileged.listLegalAcceptances(auth.user.id));
        if (legal.accepted) app.legalAcceptance.remember(auth.user.id);
        request.log.info({ termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion }, "legal documents accepted");
        return { legal };
      }
    );

    /**
     * Called by the web app right after a successful sign-in so the login is
     * recorded in the active organization's audit trail. Sign-in itself is
     * handled by Supabase Auth in the browser.
     */
    app.post(
      "/me/login-event",
      { preHandler: [app.authenticate, app.requireOrganization], config: { rateLimit: RATE_LIMITS.loginEvent } },
      async (request, reply) => {
        await app.audit(request, { action: "LOGIN", entityType: "user", entityId: getAuth(request).user.id });
        return reply.status(204).send();
      }
    );
  };
}
