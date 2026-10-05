import {
  buildAuthorizationUrl,
  createOAuthState,
  exchangeAuthorizationCode,
  serializeError,
  verifyOAuthState,
  type OAuthProvider,
  watchAccountJobId
} from "@emailbot/shared";
import {
  emailAccountUpdateSchema,
  idParamsSchema,
  imapAccountCreateSchema,
  oauthProviderParamsSchema
} from "@emailbot/validation";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ApiConfig, OAuthProviderConfig } from "../../config/env.js";
import type { AppDeps } from "../../deps.js";
import { conflict, notFound, serviceUnavailable } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import { removeStoredObjects } from "../emails/routes.js";
import { fetchMailboxIdentity } from "./mailbox-identity.js";

const PROVIDERS: Record<"gmail" | "microsoft", OAuthProvider> = { gmail: "GMAIL", microsoft: "MICROSOFT" };

function providerConfig(config: ApiConfig, provider: OAuthProvider): OAuthProviderConfig | null {
  return provider === "GMAIL" ? config.google : config.microsoft;
}

/** Longer than the state TTL (10 min) so a nonce cannot be reused before expiry. */
const OAUTH_NONCE_TTL_SECONDS = 15 * 60;

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(4096).optional(),
  error: z.string().max(200).optional()
});

export function emailAccountRoutes(deps: AppDeps) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: [app.authenticate, app.requireOrganization, requirePermission("email-accounts:read")] };
    const manage = {
      preHandler: [app.authenticate, app.requireOrganization, requirePermission("email-accounts:manage")]
    };

    const oauthStartGuards = { ...manage, config: { rateLimit: RATE_LIMITS.oauthStart } };
    const oauthCallbackOptions = { config: { rateLimit: RATE_LIMITS.oauthCallback } };
    const imapGuards = { ...manage, config: { rateLimit: RATE_LIMITS.imapCreate } };

    app.get("/email-accounts", read, async (request) => {
      return { items: await getAuth(request).repos.emailAccounts.list(getOrganization(request).id) };
    });

    app.get("/email-accounts/:id", read, async (request) => {
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const account = await getAuth(request).repos.emailAccounts.get(getOrganization(request).id, id);
      if (!account) throw notFound("Email account");
      return { account };
    });

    /** Step 1 of the OAuth connection: returns the provider consent URL. */
    app.post("/email-accounts/oauth/:provider/start", oauthStartGuards, async (request) => {
      const { provider: slug } = parseWith(oauthProviderParamsSchema, request.params, "params");
      const provider = PROVIDERS[slug];
      const config = providerConfig(deps.config, provider);
      if (!config) throw serviceUnavailable(`${slug} integration is not configured`, "PROVIDER_NOT_CONFIGURED");

      const state = createOAuthState(
        { userId: getAuth(request).user.id, organizationId: getOrganization(request).id, provider },
        deps.config.oauthStateSecret
      );
      return { authorizationUrl: buildAuthorizationUrl(provider, config, state) };
    });

    /**
     * Step 2: provider redirects the browser here. There is no bearer token
     * on this request; the signed state identifies user and organization,
     * and the role is re-checked with the service role before storing.
     * Tokens are encrypted before being written and never sent to the browser.
     */
    app.get("/oauth/:provider/callback", oauthCallbackOptions, async (request, reply) => {
      const redirect = (params: Record<string, string>) =>
        reply.redirect(`${deps.config.webAppUrl}/accounts?${new URLSearchParams(params).toString()}`, 302);
      const fail = (reason: string): FastifyReply => redirect({ oauth: "error", reason });

      const params = oauthProviderParamsSchema.safeParse(request.params);
      const query = callbackQuerySchema.safeParse(request.query);
      if (!params.success || !query.success || !query.data.state) return fail("invalid_request");

      const provider = PROVIDERS[params.data.provider];
      const config = providerConfig(deps.config, provider);
      if (!config) return fail("not_configured");

      const verification = verifyOAuthState(query.data.state, deps.config.oauthStateSecret);
      if (!verification.ok || verification.payload.provider !== provider) return fail("invalid_state");
      const { userId, organizationId } = verification.payload;

      if (query.data.error || !query.data.code) return fail("denied");

      try {
        // Each state is usable once: a replayed/leaked state cannot attach another mailbox.
        if (!(await deps.oauthNonces.consume(verification.payload.nonce, OAUTH_NONCE_TTL_SECONDS))) {
          request.log.warn({ organizationId, provider }, "replayed OAuth state rejected");
          return fail("invalid_state");
        }

        const role = await deps.privileged.getMemberRole(organizationId, userId);
        if (role !== "OWNER" && role !== "ADMIN") return fail("forbidden");

        const tokens = await exchangeAuthorizationCode(provider, config, query.data.code, deps.fetch);
        const identity = await fetchMailboxIdentity(provider, tokens.accessToken, deps.fetch);

        const { account, created } = await deps.privileged.upsertOAuthEmailAccount({
          organizationId,
          provider: provider === "GMAIL" ? "GMAIL" : "MICROSOFT",
          emailAddress: identity.emailAddress,
          displayName: identity.displayName,
          providerAccountId: identity.providerAccountId,
          accessTokenEncrypted: deps.secretBox.encrypt(tokens.accessToken),
          refreshTokenEncrypted: tokens.refreshToken ? deps.secretBox.encrypt(tokens.refreshToken) : null,
          tokenExpiresAt: tokens.expiresAt?.toISOString() ?? null,
          syncCursor: identity.syncCursor
        });

        await deps.privileged
          .insertAuditLog({
            organizationId,
            actorUserId: userId,
            action: "CONNECT",
            entityType: "email_account",
            entityId: account.id,
            metadata: { provider, emailAddress: account.emailAddress, reconnected: !created },
            requestId: request.id
          })
          .catch((error: unknown) =>
            request.log.error({ err: serializeError(error) }, "failed to write audit log")
          );

        if (provider === "GMAIL") {
          // Push notifications (users.watch) are created by the worker; a still valid watch is kept.
          await deps.queue
            .enqueueEmailEvent(
              { type: "WATCH_ACCOUNT", emailAccountId: account.id, organizationId },
              { jobId: watchAccountJobId(account.id) }
            )
            .catch((error: unknown) =>
              request.log.warn({ err: serializeError(error), emailAccountId: account.id }, "could not queue the Gmail watch; the renewal job will create it")
            );
        }

        request.log.info({ organizationId, emailAccountId: account.id, provider }, "email account connected");
        return redirect({ oauth: "connected", provider: params.data.provider, accountId: account.id });
      } catch (error) {
        request.log.error({ err: serializeError(error), organizationId, provider }, "oauth callback failed");
        return fail("connection_failed");
      }
    });

    /**
     * IMAP / custom domains. Credentials are validated and stored encrypted.
     * Synchronization is NOT implemented yet: the account is created PAUSED
     * with an explicit error code so nobody mistakes it for a working sync.
     */
    app.post("/email-accounts/imap", imapGuards, async (request, reply) => {
      const input = parseWith(imapAccountCreateSchema, request.body);
      const account = await deps.privileged.createImapEmailAccount({
        organizationId: getOrganization(request).id,
        emailAddress: input.emailAddress,
        displayName: input.displayName ?? null,
        passwordEncrypted: deps.secretBox.encrypt(input.password),
        host: input.host,
        port: input.port,
        secure: input.secure,
        username: input.username
      });

      await app.audit(request, {
        action: "CONNECT",
        entityType: "email_account",
        entityId: account.id,
        metadata: { provider: "IMAP", emailAddress: account.emailAddress, host: input.host }
      });
      return reply.status(201).send({ account });
    });

    /** Pause / resume and rename. */
    app.patch("/email-accounts/:id", manage, async (request) => {
      const repos = getAuth(request).repos;
      const organizationId = getOrganization(request).id;
      const { id } = parseWith(idParamsSchema, request.params, "params");
      const input = parseWith(emailAccountUpdateSchema, request.body);

      const current = await repos.emailAccounts.get(organizationId, id);
      if (!current) throw notFound("Email account");

      if (input.status !== undefined) {
        if (current.status === "DISCONNECTED") {
          throw conflict("The account is disconnected; connect it again", "RECONNECT_REQUIRED");
        }
        if (input.status === "ACTIVE" && current.provider === "IMAP") {
          throw conflict("IMAP synchronization is not available yet", "IMAP_SYNC_NOT_IMPLEMENTED");
        }
      }

      const patch: { status?: "ACTIVE" | "PAUSED"; display_name?: string | null } = {};
      if (input.status !== undefined) patch.status = input.status;
      if (input.displayName !== undefined) patch.display_name = input.displayName;

      const account = await repos.emailAccounts.update(organizationId, id, patch);
      if (!account) throw notFound("Email account");

      await app.audit(request, {
        action: "UPDATE",
        entityType: "email_account",
        entityId: id,
        metadata: { ...(input.status ? { from: current.status, to: input.status } : {}), fields: Object.keys(patch) }
      });
      return { account };
    });

    /** Removes stored credentials and stops processing. Emails already stored are kept. */
    app.post("/email-accounts/:id/disconnect", manage, async (request) => {
      const organizationId = getOrganization(request).id;
      const { id } = parseWith(idParamsSchema, request.params, "params");

      const current = await getAuth(request).repos.emailAccounts.get(organizationId, id);
      if (!current) throw notFound("Email account");

      const account = await deps.privileged.disconnectEmailAccount(organizationId, id);
      if (!account) throw notFound("Email account");

      await app.audit(request, {
        action: "DISCONNECT",
        entityType: "email_account",
        entityId: id,
        metadata: { provider: current.provider, emailAddress: current.emailAddress }
      });
      return { account };
    });

    /** Requests an immediate synchronization (processed by the worker). */
    app.post(
      "/email-accounts/:id/sync",
      {
        preHandler: [app.authenticate, app.requireOrganization, requirePermission("email-accounts:sync")],
        config: { rateLimit: RATE_LIMITS.accountSync }
      },
      async (request, reply) => {
        const organizationId = getOrganization(request).id;
        const { id } = parseWith(idParamsSchema, request.params, "params");

        const account = await getAuth(request).repos.emailAccounts.get(organizationId, id);
        if (!account) throw notFound("Email account");
        if (account.status !== "ACTIVE") throw conflict("Only active accounts can be synchronized", "ACCOUNT_NOT_ACTIVE");

        await deps.queue.enqueueEmailEvent(
          { type: "SYNC_ACCOUNT", emailAccountId: id, organizationId, requestedBy: getAuth(request).user.id },
          // One pending manual sync per account at a time.
          { jobId: `sync-${id}` }
        );
        return reply.status(202).send({ queued: true });
      }
    );

    /** Deletes the account and (by cascade) its stored emails. Must be disconnected first. */
    app.delete("/email-accounts/:id", manage, async (request, reply) => {
      const repos = getAuth(request).repos;
      const organizationId = getOrganization(request).id;
      const { id } = parseWith(idParamsSchema, request.params, "params");

      const account = await repos.emailAccounts.get(organizationId, id);
      if (!account) throw notFound("Email account");
      if (account.status !== "DISCONNECTED") {
        throw conflict("Disconnect the account before deleting it", "ACCOUNT_NOT_DISCONNECTED");
      }

      // Collected before the cascade deletes the rows; removed after it succeeded.
      const objects = await repos.attachments.listStoredObjects(organizationId, { accountId: id });
      await repos.emailAccounts.remove(organizationId, id);
      await removeStoredObjects(deps, request.log, organizationId, objects);
      await app.audit(request, {
        action: "DELETE",
        entityType: "email_account",
        entityId: id,
        metadata: { provider: account.provider, emailAddress: account.emailAddress }
      });
      return reply.status(204).send();
    });
  };
}
