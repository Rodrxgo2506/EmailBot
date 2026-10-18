import {
  buildAuthorizationUrl,
  createOAuthState,
  exchangeAuthorizationCode,
  imapAllowedForOrganization,
  imapCredentialContext,
  serializeError,
  verifyOAuthState,
  type OAuthProvider,
  watchAccountJobId
} from "@emailbot/shared";
import type { EmailProviderAvailability } from "@emailbot/types";
import {
  emailAccountUpdateSchema,
  idParamsSchema,
  imapAccountCreateSchema,
  imapConnectionTestSchema,
  oauthProviderParamsSchema
} from "@emailbot/validation";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiConfig, OAuthProviderConfig } from "../../config/env.js";
import type { AppDeps } from "../../deps.js";
import { conflict, notFound, serviceUnavailable } from "../../lib/errors.js";
import { RATE_LIMITS } from "../../lib/rate-limits.js";
import { parseWith } from "../../lib/validation.js";
import { getAuth } from "../../plugins/auth.js";
import { getOrganization, requirePermission } from "../../plugins/organization.js";
import { removeStoredObjects } from "../emails/routes.js";
import {
  assertWithinLimit,
  canUseFeature,
  hasCommercialAccess,
  isWithinLimit,
  planFeatureUnavailable,
  planLimitReached,
  requestEntitlements,
  subscriptionRequired
} from "../plans/entitlements.js";
import { createImapConnectionTester } from "./imap-connection.js";
import { fetchMailboxIdentity } from "./mailbox-identity.js";
import { removeMicrosoftSubscription } from "./microsoft-subscription.js";

const PROVIDERS: Record<"gmail" | "microsoft", OAuthProvider> = { gmail: "GMAIL", microsoft: "MICROSOFT" };

function providerConfig(config: ApiConfig, provider: OAuthProvider): OAuthProviderConfig | null {
  return provider === "GMAIL" ? config.google : config.microsoft;
}

/**
 * Single source of which providers NEW accounts can be connected with: an
 * OAuth provider needs its server configuration (client id, secret, redirect
 * URI), so Microsoft becomes available just by configuring it and deploying;
 * IMAP stays refused until its synchronization exists (config.imapAccountsEnabled) and, even then,
 * for every organization outside the trial allowlist fixed in code (config.imapOrganizationIds).
 * `organizationId` is the organization verified for the request (membership checked); null = none: IMAP false.
 * Existing accounts of any provider can always be listed, disconnected and deleted.
 */
export function providerAvailability(config: ApiConfig, organizationId: string | null): EmailProviderAvailability {
  return {
    GMAIL: providerConfig(config, "GMAIL") !== null,
    MICROSOFT: providerConfig(config, "MICROSOFT") !== null,
    IMAP: imapAllowedForOrganization(config.imapAccountsEnabled, config.imapOrganizationIds, organizationId)
  };
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
    /*
     * IMAP routes (E4, B2): the per-IP limit runs in onRequest like every route; then
     * authentication, organization, permission and the "IMAP disabled" check run in
     * preParsing, i.e. BEFORE the body (and its password) is read or parsed. Anonymous
     * and unauthorized callers keep their 401 / 403; while IMAP is disabled every other
     * caller gets 503 whatever the body (malformed, oversized, another content type).
     * The check uses the organization verified just before (requireOrganization): an organization
     * outside the trial allowlist gets the same 503 as when IMAP is off (nothing tells it a trial exists).
     */
    const imapAvailable = async (request: FastifyRequest) => {
      if (!providerAvailability(deps.config, getOrganization(request).id).IMAP) {
        throw serviceUnavailable("IMAP accounts are not available yet", "IMAP_NOT_AVAILABLE");
      }
    };
    const beforeBody = (hook: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
      async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
        await hook(request, reply);
        return payload;
      };
    const imapPreParsing = [app.authenticate, app.requireOrganization, requirePermission("email-accounts:manage"), imapAvailable].map(beforeBody);
    const imapGuards = { preParsing: imapPreParsing, config: { rateLimit: RATE_LIMITS.imapCreate } };
    const imapTestGuards = { preParsing: imapPreParsing, config: { rateLimit: RATE_LIMITS.imapTest } };
    const imap = createImapConnectionTester(deps, app.log);

    /**
     * Checks done before any IMAP connection (test or creation): plan feature IMAP
     * (PRO, BUSINESS), the same mailbox not connected through Gmail / Microsoft, and
     * room for one more mailbox unless this one already counts (a reconnection).
     * Only this organization is looked at. The database decides again atomically.
     */
    async function assertImapConnectable(request: FastifyRequest, emailAddress: string) {
      const plans = requestEntitlements(request);
      const entitlements = await plans.assertFeatureEnabled("IMAP");
      const address = emailAddress.trim().toLowerCase();
      const accounts = await getAuth(request).repos.emailAccounts.list(getOrganization(request).id);
      const sameMailbox = accounts.filter((existing) => existing.status !== "DISCONNECTED" && existing.emailAddress.trim().toLowerCase() === address);
      if (sameMailbox.some((existing) => existing.provider !== "IMAP")) {
        throw conflict("This mailbox is already connected with another provider", "EMAIL_ACCOUNT_ALREADY_CONNECTED");
      }
      if (!sameMailbox.some((existing) => existing.provider === "IMAP")) {
        assertWithinLimit(entitlements, "EMAIL_ACCOUNTS", (await plans.usage(["EMAIL_ACCOUNTS"])).EMAIL_ACCOUNTS ?? 0);
      }
      return entitlements;
    }

    /** Providers new accounts can be connected with (the web app only offers these). */
    app.get("/email-accounts/providers", read, async (request, reply) => {
      reply.header("cache-control", "no-store");
      return { providers: providerAvailability(deps.config, getOrganization(request).id) };
    });

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

      // Commercial V1: the provider must be in the plan (Microsoft: PRO and BUSINESS).
      const plans = requestEntitlements(request);
      const entitlements = await plans.assertFeatureEnabled(provider);
      // Early refusal at the account limit, unless this can be the re-authorization of a mailbox
      // that already counts (same provider); the callback decides with the real mailbox address.
      const used = (await plans.usage(["EMAIL_ACCOUNTS"])).EMAIL_ACCOUNTS ?? 0;
      if (!isWithinLimit(entitlements, "EMAIL_ACCOUNTS", used)) {
        const accounts = await getAuth(request).repos.emailAccounts.list(getOrganization(request).id);
        if (!accounts.some((account) => account.provider === provider && account.status !== "DISCONNECTED")) {
          assertWithinLimit(entitlements, "EMAIL_ACCOUNTS", used);
        }
      }

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

        // Commercial V1, re-checked here: the plan may have changed since the start.
        const entitlements = await deps.privileged.getOrganizationEntitlements(organizationId);
        if (!entitlements || !hasCommercialAccess(entitlements)) {
          request.log.info(
            {
              event: "subscription.access_denied",
              organizationId,
              subscriptionStatus: entitlements?.subscriptionStatus ?? null,
              operation: "oauth_callback",
              provider,
              reason: "no_active_subscription"
            },
            "oauth connection refused: no active subscription"
          );
          return fail("subscription_required");
        }
        if (!canUseFeature(entitlements, provider)) {
          request.log.info({ organizationId, provider, code: "PLAN_FEATURE_UNAVAILABLE" }, "oauth connection refused by the plan");
          return fail("plan_feature");
        }

        const tokens = await exchangeAuthorizationCode(provider, config, query.data.code, deps.fetch);
        const identity = await fetchMailboxIdentity(provider, tokens.accessToken, deps.fetch);

        // One locked transaction decides and stores (concurrent callbacks cannot exceed the plan):
        // re-authorizing a mailbox that already counts is always allowed, a new (or disconnected)
        // one needs room in the plan. On a refusal nothing is stored and the tokens just obtained are discarded.
        const connection = await deps.privileged.connectOAuthEmailAccount({
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
        if (connection.outcome === "PLAN_LIMIT_REACHED") {
          request.log.info(
            { organizationId, provider, code: "PLAN_LIMIT_REACHED", used: connection.used, max: connection.limit },
            "oauth connection refused by the plan"
          );
          return fail("plan_limit");
        }
        if (connection.outcome === "MISSING_REFRESH_TOKEN") {
          // Offline access is required to keep synchronizing; nothing was stored and the user can retry.
          request.log.warn({ organizationId, provider, code: "MISSING_REFRESH_TOKEN" }, "oauth connection refused: no refresh token");
          return fail("missing_refresh_token");
        }
        const { account, created } = connection;

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

        // Push notifications (Gmail users.watch, Microsoft Graph subscription) are created by the
        // worker, only for an ACTIVE account with credentials and push configured; a still valid one is kept.
        await deps.queue
          .enqueueEmailEvent(
            { type: "WATCH_ACCOUNT", emailAccountId: account.id, organizationId },
            { jobId: watchAccountJobId(account.id) }
          )
          .catch((error: unknown) =>
            request.log.warn({ err: serializeError(error), emailAccountId: account.id }, "could not queue the push subscription; the renewal job will create it")
          );

        request.log.info({ organizationId, emailAccountId: account.id, provider }, "email account connected");
        return redirect({ oauth: "connected", provider: params.data.provider, accountId: account.id });
      } catch (error) {
        request.log.error({ err: serializeError(error), organizationId, provider }, "oauth callback failed");
        return fail("connection_failed");
      }
    });

    /**
     * IMAP / custom domains. Synchronization is NOT enabled, so both IMAP routes
     * answer 503 IMAP_NOT_AVAILABLE before the body (and its password) is even
     * parsed (config.imapAccountsEnabled: false, fixed in code). When enabled:
     *   - OWNER / ADMIN (email-accounts:manage), per-IP route limit;
     *   - only 993/TLS or 143/STARTTLS and a public DNS name (validation);
     *   - plan feature IMAP (PRO, BUSINESS) and EMAIL_ACCOUNTS room (assertImapConnectable);
     *   - imap.test(): attempts per user / organization and login lockout BEFORE any
     *     DNS query, then SSRF (every address of the host must be public,
     *     resolveImapDestination; checked again by the shared connector right before
     *     it dials the validated IP), concurrency and the connection;
     *   - connection test with the transport the worker uses: login only after TLS /
     *     STARTTLS, EXAMINE INBOX read-only, LOGOUT, every connection closed.
     */

    /** Connection test only: nothing is stored, no password is kept, nothing is queued or imported. */
    app.post("/email-accounts/imap/test", imapTestGuards, async (request) => {
      if (!providerAvailability(deps.config, getOrganization(request).id).IMAP) {
        throw serviceUnavailable("IMAP accounts are not available yet", "IMAP_NOT_AVAILABLE");
      }
      const input = parseWith(imapConnectionTestSchema, request.body);
      await assertImapConnectable(request, input.emailAddress);
      await imap.test({ organizationId: getOrganization(request).id, userId: getAuth(request).user.id, log: request.log }, input);
      return { ok: true };
    });

    /**
     * Connection, after the same checks and a successful connection test: the
     * password is encrypted bound to the mailbox (SecretBox v2) and the database
     * decides plan, limit, duplicates and reconnection atomically
     * (connect_imap_email_account: one transaction, nothing stored on a refusal).
     * The account stays PAUSED and nothing is queued. Its initial cursor is the
     * INBOX position seen by the test ("imap:v1:<UIDVALIDITY>:<UIDNEXT - 1>"):
     * no older message is ever imported, none received after the test is lost.
     */
    app.post("/email-accounts/imap", imapGuards, async (request, reply) => {
      const organizationId = getOrganization(request).id;
      if (!providerAvailability(deps.config, organizationId).IMAP) {
        throw serviceUnavailable("IMAP accounts are not available yet", "IMAP_NOT_AVAILABLE");
      }
      const input = parseWith(imapAccountCreateSchema, request.body);
      // Early, friendly refusals; the database checks plan and limit again in the same transaction as the write.
      const entitlements = await assertImapConnectable(request, input.emailAddress);
      const plan = entitlements.effectivePlan;

      const position = await imap.test({ organizationId, userId: getAuth(request).user.id, log: request.log }, input);

      const connection = await deps.privileged.connectImapEmailAccount({
        organizationId,
        emailAddress: input.emailAddress,
        displayName: input.displayName ?? null,
        username: input.username,
        host: input.host,
        port: input.port,
        security: input.security,
        passwordEncrypted: deps.secretBox.encryptBound(input.password, imapCredentialContext(organizationId, input.emailAddress)),
        syncCursor: position.cursor
      });
      // The plan may have changed since the early check: the database's answer wins.
      if (connection.outcome === "FEATURE_NOT_AVAILABLE") {
        throw plan ? planFeatureUnavailable({ feature: "IMAP", plan }) : subscriptionRequired(entitlements.subscriptionStatus);
      }
      if (connection.outcome === "PLAN_LIMIT_REACHED") {
        throw plan
          ? planLimitReached({ limit: "EMAIL_ACCOUNTS", max: connection.limit, used: connection.used, plan })
          : subscriptionRequired(entitlements.subscriptionStatus);
      }
      if (connection.outcome === "DUPLICATE_ACCOUNT") {
        throw conflict("This mailbox is already connected with another provider", "EMAIL_ACCOUNT_ALREADY_CONNECTED");
      }
      const { account, created } = connection;

      await app.audit(request, {
        action: "CONNECT",
        entityType: "email_account",
        entityId: account.id,
        metadata: { provider: "IMAP", emailAddress: account.emailAddress, host: input.host, reconnected: !created }
      });
      return reply.status(created ? 201 : 200).send({ account });
    });

    /**
     * IMAP M1: resuming an IMAP mailbox (PAUSED after every (re)connection) goes through
     * public.activate_imap_email_account only (service role, organization lock): plan feature IMAP with
     * commercial access, a usable stored login and settings, never a DISCONNECTED mailbox. Members cannot
     * set it ACTIVE directly (E1 trigger). The first synchronization is queued best effort: the mailbox is
     * ACTIVE either way and the recovery polling picks it up if the queue is unavailable.
     * A mailbox in ERROR (refused login, certificate, TLS...) is never resumed: resuming it would make the
     * worker log in again outside the connection-test limits (E4). It must be connected again (connection test
     * with those limits, then PAUSED); the database refuses it too (RECONNECT_REQUIRED).
     */
    const imapReconnectRequired = () =>
      conflict("The IMAP mailbox stopped with an error; connect it again so the connection is tested again", "IMAP_RECONNECT_REQUIRED");

    async function activateImapMailbox(request: FastifyRequest, current: { id: string; status: string }, displayName: string | null | undefined) {
      const organizationId = getOrganization(request).id;
      // Refused before anything else: no plan lookup, no RPC, no queue, no audit, no connection.
      if (current.status === "ERROR") throw imapReconnectRequired();
      // Early, friendly refusal; the database checks plan and access again in the same transaction as the write.
      const entitlements = await requestEntitlements(request).assertFeatureEnabled("IMAP");
      const plan = entitlements.effectivePlan;
      const activation = await deps.privileged.activateImapEmailAccount(organizationId, current.id);
      switch (activation.outcome) {
        case "NOT_FOUND":
        case "NOT_IMAP":
          throw notFound("Email account");
        case "DISCONNECTED":
          throw conflict("The account is disconnected; connect it again", "RECONNECT_REQUIRED");
        case "RECONNECT_REQUIRED":
          // Became ERROR after the early check (a worker failure in between): the database's answer wins.
          throw imapReconnectRequired();
        case "CREDENTIALS_MISSING":
        case "SETTINGS_INVALID":
          throw conflict("The stored IMAP login cannot be used; connect the mailbox again", "IMAP_RECONNECT_REQUIRED");
        case "FEATURE_NOT_AVAILABLE":
          // The plan may have changed since the early check: the database's answer wins.
          throw plan ? planFeatureUnavailable({ feature: "IMAP", plan }) : subscriptionRequired(entitlements.subscriptionStatus);
      }

      let account = activation.account;
      if (displayName !== undefined) {
        account = (await getAuth(request).repos.emailAccounts.update(organizationId, current.id, { display_name: displayName })) ?? account;
      }
      if (activation.outcome === "ACTIVATED") {
        await app.audit(request, {
          action: "UPDATE",
          entityType: "email_account",
          entityId: current.id,
          metadata: {
            from: activation.previousStatus,
            to: "ACTIVE",
            fields: displayName !== undefined ? ["status", "display_name"] : ["status"],
            via: "activate_imap"
          }
        });
        await deps.queue
          .enqueueEmailEvent(
            { type: "SYNC_ACCOUNT", emailAccountId: current.id, organizationId, requestedBy: getAuth(request).user.id },
            // Same id as a manual sync: a repeated activation never queues a second pending run.
            { jobId: `sync-${current.id}` }
          )
          .catch((error: unknown) =>
            request.log.warn(
              { event: "imap.activation.enqueue_failed", emailAccountId: current.id, err: serializeError(error) },
              "first IMAP sync not queued; polling will pick the mailbox up"
            )
          );
      }
      return { account };
    }

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
          // IMAP disabled (config.imapAccountsEnabled: false, fixed in code) or this organization outside the trial
          // allowlist: unchanged refusal, nothing contacted.
          if (!providerAvailability(deps.config, organizationId).IMAP) {
            throw conflict("IMAP synchronization is not available yet", "IMAP_SYNC_NOT_IMPLEMENTED");
          }
          return activateImapMailbox(request, current, input.displayName);
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

      // F9: delete the Graph subscription while the account still has its tokens (best effort).
      if (current.provider === "MICROSOFT") await removeMicrosoftSubscription(deps, organizationId, id, request.log);

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
        // IMAP off, or this organization outside the trial allowlist: the worker would skip it; nothing is queued.
        if (account.provider === "IMAP" && !providerAvailability(deps.config, organizationId).IMAP) {
          throw conflict("IMAP synchronization is not available yet", "IMAP_SYNC_NOT_IMPLEMENTED");
        }
        // Commercial V1.2: the worker would skip it anyway; say why instead of queuing a no-op.
        await requestEntitlements(request).get();

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

      // F9: normally already removed at disconnection; covers older disconnections (best effort).
      if (account.provider === "MICROSOFT") await removeMicrosoftSubscription(deps, organizationId, id, request.log);

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
