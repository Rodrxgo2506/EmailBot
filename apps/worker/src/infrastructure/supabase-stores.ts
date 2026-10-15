import type { EmailRuleRow } from "@emailbot/rules-engine";
import { REALTIME_REDIS_CHANNEL } from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpTimeoutError } from "@emailbot/shared";
import type { AppRedis } from "./app-redis.js";
import { RequestCancelledError } from "./http-cancellation.js";
import type {
  AccountStore,
  AttachmentStorage,
  AuditRecorder,
  BillingStore,
  BillingSubscriptionRow,
  CommercialAccess,
  EmailStore,
  IdentifierCandidate,
  OrganizationProcessingSettings,
  RealtimePublisher,
  RoutingStore,
  SubscriptionMaintenance
} from "../pipeline/ports.js";
import type { WorkerAccount } from "../providers/types.js";

/*
 * SERVICE ROLE persistence for the worker. The worker has no end-user JWT,
 * so tenant isolation is preserved by always scoping writes with the
 * organization/account ids taken from the database (never from a client),
 * plus the cross-tenant triggers of migration 3.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

// organizations(status): column grant of migration organization_status_worker_access (no other organization column).
const ACCOUNT_COLUMNS =
  "id,organization_id,provider,status,email_address,sync_cursor,last_synced_at,watch_expires_at,provider_metadata,access_token_encrypted,refresh_token_encrypted,token_expires_at,organizations!inner(status)";

function check<T>(result: { data: T; error: { message: string; code?: string } | null }, operation: string): T {
  if (result.error) {
    const error = new Error(`${operation} failed: ${result.error.message}`) as Error & { code?: string | undefined };
    error.code = result.error.code;
    throw error;
  }
  return result.data;
}

function toAccount(row: Row): WorkerAccount {
  return {
    id: row.id,
    organizationId: row.organization_id,
    // Fail closed: an account whose organization status cannot be read is not processed.
    organizationStatus: row.organizations?.status ?? "SUSPENDED",
    provider: row.provider,
    status: row.status,
    emailAddress: row.email_address,
    syncCursor: row.sync_cursor,
    lastSyncedAt: row.last_synced_at ?? null,
    watchExpiresAt: row.watch_expires_at ?? null,
    providerMetadata: row.provider_metadata ?? {},
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    tokenExpiresAt: row.token_expires_at
  };
}

export function createAccountStore(db: SupabaseClient): AccountStore {
  return {
    async getAccount(id) {
      const row = check(await db.from("email_accounts").select(ACCOUNT_COLUMNS).eq("id", id).maybeSingle(), "getAccount");
      return row ? toAccount(row as Row) : null;
    },

    async findActiveAccountsByAddress(provider, emailAddress) {
      const rows = check(
        await db
          .from("email_accounts")
          .select(ACCOUNT_COLUMNS)
          .eq("provider", provider)
          .eq("status", "ACTIVE")
          .eq("email_address", emailAddress.toLowerCase()),
        "findActiveAccountsByAddress"
      ) as Row[];
      return rows.map(toAccount);
    },

    async findAccountBySubscription(subscriptionId) {
      const row = check(
        await db
          .from("email_accounts")
          .select(ACCOUNT_COLUMNS)
          .eq("provider", "MICROSOFT")
          .eq("provider_metadata->>subscriptionId", subscriptionId)
          .maybeSingle(),
        "findAccountBySubscription"
      );
      return row ? toAccount(row as Row) : null;
    },

    async listActiveOAuthAccounts(limit) {
      const rows = check(
        await db
          .from("email_accounts")
          .select("id,organization_id,organizations!inner(status)")
          .eq("status", "ACTIVE")
          .eq("organizations.status", "ACTIVE")
          .in("provider", ["GMAIL", "MICROSOFT"])
          .order("last_synced_at", { ascending: true, nullsFirst: true })
          .limit(limit),
        "listActiveOAuthAccounts"
      ) as Row[];
      return rows.map((row) => ({ id: row.id, organizationId: row.organization_id }));
    },

    async listActiveImapAccounts(limit) {
      const rows = check(
        await db
          .from("email_accounts")
          .select("id,organization_id,organizations!inner(status)")
          .eq("status", "ACTIVE")
          .eq("organizations.status", "ACTIVE")
          .eq("provider", "IMAP")
          .order("last_synced_at", { ascending: true, nullsFirst: true })
          .limit(limit),
        "listActiveImapAccounts"
      ) as Row[];
      return rows.map((row) => ({ id: row.id, organizationId: row.organization_id }));
    },

    async updateSyncState(id, state) {
      check(
        await db
          .from("email_accounts")
          .update({
            sync_cursor: state.syncCursor,
            last_synced_at: state.lastSyncedAt,
            last_error_code: null,
            last_error_message: null
          })
          .eq("id", id),
        "updateSyncState"
      );
    },

    async advanceSyncCursor(id, state) {
      // Compare-and-set: only from the cursor the sync started with (never overwrites a newer one).
      let query = db
        .from("email_accounts")
        .update({ sync_cursor: state.to, last_synced_at: state.lastSyncedAt, last_error_code: null, last_error_message: null })
        .eq("id", id);
      query = state.from === null ? query.is("sync_cursor", null) : query.eq("sync_cursor", state.from);
      // IMAP (M1 D1): in the same UPDATE, only while the mailbox is still ACTIVE (paused / disconnected meanwhile: unchanged).
      if (state.requireActive) query = query.eq("status", "ACTIVE");
      const rows = check(await query.select("id"), "advanceSyncCursor") as Row[];
      return rows.length > 0;
    },

    async saveWatchState(id, state) {
      const columns: Row = { watch_error_code: state.errorCode?.slice(0, 100) ?? null };
      if (state.expiresAt !== undefined) columns.watch_expires_at = state.expiresAt;
      if (state.renewedAt !== undefined) columns.watch_renewed_at = state.renewedAt;
      if (state.errorAt !== undefined) columns.watch_error_at = state.errorAt;
      check(await db.from("email_accounts").update(columns).eq("id", id), "saveWatchState");
    },

    async saveSubscriptionState(id, state) {
      const columns: Row = {
        provider_metadata: state.providerMetadata,
        watch_expires_at: state.expiresAt,
        watch_error_code: state.errorCode?.slice(0, 100) ?? null
      };
      if (state.renewedAt !== undefined) columns.watch_renewed_at = state.renewedAt;
      if (state.errorAt !== undefined) columns.watch_error_at = state.errorAt;
      check(await db.from("email_accounts").update(columns).eq("id", id).eq("provider", "MICROSOFT"), "saveSubscriptionState");
    },

    async listAccountsNeedingWatch({ renewBefore, limit, providers = ["GMAIL"] }) {
      const rows = check(
        await db
          .from("email_accounts")
          .select("id,organization_id,organizations!inner(status)")
          .in("provider", providers)
          .eq("status", "ACTIVE")
          .eq("organizations.status", "ACTIVE")
          .or(`watch_expires_at.is.null,watch_expires_at.lt.${renewBefore}`)
          .order("watch_expires_at", { ascending: true, nullsFirst: true })
          .limit(limit),
        "listAccountsNeedingWatch"
      ) as Row[];
      return rows.map((row) => ({ id: row.id, organizationId: row.organization_id }));
    },

    async commercialAccess(organizationIds) {
      const ids = [...new Set(organizationIds)];
      const access = new Map<string, CommercialAccess>();
      if (ids.length === 0) return access;
      const rows = check(await db.rpc("organization_access", { p_organization_ids: ids }), "organizationAccess") as Row[] | null;
      for (const row of rows ?? []) {
        const level = row.access === "SUBSCRIPTION" || row.access === "LEGACY" ? row.access : "NONE";
        access.set(row.organization_id, { allowed: level !== "NONE", access: level, subscriptionStatus: row.subscription_status ?? null });
      }
      return access;
    },

    async saveTokens(id, tokens) {
      const columns: Row = {
        access_token_encrypted: tokens.accessTokenEncrypted,
        token_expires_at: tokens.tokenExpiresAt
      };
      if (tokens.refreshTokenEncrypted) columns.refresh_token_encrypted = tokens.refreshTokenEncrypted;
      check(await db.from("email_accounts").update(columns).eq("id", id), "saveTokens");
    },

    async markError(id, error) {
      check(
        await db
          .from("email_accounts")
          .update({
            last_error_code: error.code.slice(0, 100),
            last_error_message: error.message.slice(0, 2000),
            ...(error.status ? { status: error.status } : {})
          })
          .eq("id", id)
          // IMAP (M1 D2): never a DISCONNECTED IMAP mailbox (a late job cannot make it ERROR and count again).
          // Gmail / Microsoft rows always match (provider <> IMAP): unchanged behaviour.
          .or("provider.neq.IMAP,status.neq.DISCONNECTED"),
        "markError"
      );
    },

    async imapEntitled(organizationId) {
      // Same source and rule as public.activate_imap_email_account / connect_imap_email_account (fail closed).
      const rows = check(await db.rpc("organization_entitlements", { p_organization_id: organizationId }), "organizationEntitlements") as Row[] | null;
      return (rows ?? []).some(
        (row) =>
          row.key === "IMAP" &&
          row.kind === "FEATURE" &&
          row.enabled === true &&
          (row.access === "SUBSCRIPTION" || row.access === "LEGACY") &&
          ["BASIC", "PRO", "BUSINESS"].includes(String(row.effective_plan))
      );
    }
  };
}

/** Commercial V1.2: the expiration job (public.expire_due_subscriptions, service role EXECUTE only). */
export function createSubscriptionMaintenance(db: SupabaseClient): SubscriptionMaintenance {
  return {
    async expireDue() {
      return Number(check(await db.rpc("expire_due_subscriptions"), "expireDueSubscriptions") ?? 0);
    }
  };
}

const BILLING_COLUMNS =
  "id,organization_id,status,environment,external_subscription_id,external_plan_id,external_customer_id,external_card_id,cancel_reason,created_at," +
  "price:plan_prices(billing_period,amount_cents,currency)";

function toBillingRow(row: Row): BillingSubscriptionRow {
  const price = Array.isArray(row.price) ? row.price[0] : row.price;
  return {
    id: row.id,
    organizationId: row.organization_id,
    status: row.status,
    environment: row.environment === "live" ? "live" : "test",
    externalSubscriptionId: row.external_subscription_id ?? null,
    externalPlanId: row.external_plan_id,
    externalCustomerId: row.external_customer_id ?? null,
    externalCardId: row.external_card_id ?? null,
    billingPeriod: price?.billing_period === "YEARLY" ? "YEARLY" : "MONTHLY",
    // Fail closed: an unreadable price never matches a charge.
    amountCents: Number.isFinite(Number(price?.amount_cents)) ? Number(price.amount_cents) : -1,
    currency: typeof price?.currency === "string" ? price.currency : "",
    cancelReason: row.cancel_reason ?? null,
    createdAt: row.created_at
  };
}

/** Commercial V1 phase 2 (Culqi sandbox): billing_* tables (service role) and the three billing functions. */
export function createBillingStore(db: SupabaseClient): BillingStore {
  const provider = "CULQI";
  return {
    async getWebhookEvent(eventId) {
      const row = check(
        await db.from("billing_webhook_events").select("status,attempts").eq("provider", provider).eq("external_event_id", eventId).maybeSingle(),
        "getWebhookEvent"
      ) as Row | null;
      return row ? { status: row.status, attempts: Number(row.attempts) } : null;
    },

    async updateWebhookEvent(eventId, patch) {
      const update: Row = {};
      if (patch.status !== undefined) update.status = patch.status;
      if (patch.eventType !== undefined) update.event_type = patch.eventType;
      if (patch.lastError !== undefined) update.last_error = patch.lastError === null ? null : patch.lastError.slice(0, 500);
      if (patch.externalSubscriptionId !== undefined) update.external_subscription_id = patch.externalSubscriptionId;
      if (patch.externalChargeId !== undefined) update.external_charge_id = patch.externalChargeId;
      if (patch.attempts !== undefined) update.attempts = patch.attempts;
      if (patch.processed) update.processed_at = new Date().toISOString();
      check(await db.from("billing_webhook_events").update(update).eq("provider", provider).eq("external_event_id", eventId), "updateWebhookEvent");
    },

    async getBillingSubscription(id) {
      const row = check(await db.from("billing_subscriptions").select(BILLING_COLUMNS).eq("id", id).maybeSingle(), "getBillingSubscription") as Row | null;
      return row ? toBillingRow(row) : null;
    },

    async findBillingSubscriptionByExternalId(externalSubscriptionId) {
      const row = check(
        await db.from("billing_subscriptions").select(BILLING_COLUMNS).eq("external_subscription_id", externalSubscriptionId).maybeSingle(),
        "findBillingSubscription"
      ) as Row | null;
      return row ? toBillingRow(row) : null;
    },

    async activate(input) {
      const rows = check(
        await db.rpc("billing_activate_culqi_subscription", {
          p_billing_subscription_id: input.billingSubscriptionId,
          p_activation_key: input.activationKey,
          p_event_type: input.eventType,
          p_period_start: input.periodStart,
          p_period_end: input.periodEnd,
          p_current_period: input.currentPeriod,
          p_external_charge_id: input.externalChargeId,
          p_provider_status: input.providerStatus,
          p_request_id: input.requestId
        }),
        "activateCulqiSubscription"
      ) as Row[] | null;
      const row = rows?.[0] ?? {};
      return { outcome: String(row.outcome), subscriptionId: row.subscription_id ?? null, supersededExternalIds: (row.superseded_external_ids as string[] | null) ?? [] };
    },

    async recordChargeFailure(input) {
      return String(
        check(
          await db.rpc("billing_record_culqi_charge_failure", {
            p_billing_subscription_id: input.billingSubscriptionId,
            p_external_event_id: input.externalEventId,
            p_event_type: input.eventType,
            p_external_charge_id: input.externalChargeId,
            p_failure_code: input.failureCode,
            p_failure_message: input.failureMessage,
            p_provider_status: input.providerStatus,
            p_request_id: input.requestId
          }),
          "recordCulqiChargeFailure"
        )
      );
    },

    async setStatus(input) {
      return String(
        check(
          await db.rpc("billing_set_culqi_status", {
            p_billing_subscription_id: input.billingSubscriptionId,
            p_status: input.status,
            p_provider_status: input.providerStatus,
            p_cancel_reason: input.cancelReason,
            p_failure_code: input.failureCode,
            p_failure_message: input.failureMessage,
            p_request_id: input.requestId
          }),
          "setCulqiStatus"
        )
      );
    },

    async listUnconfirmedCancellations(organizationId) {
      const rows = check(
        await db
          .from("billing_subscriptions")
          .select("id,external_subscription_id")
          .eq("organization_id", organizationId)
          .eq("cancel_reason", "UPGRADED")
          .is("provider_canceled_at", null)
          .not("external_subscription_id", "is", null),
        "listUnconfirmedCancellations"
      ) as Row[];
      return rows.map((row) => ({ id: row.id as string, externalSubscriptionId: row.external_subscription_id as string }));
    },

    async markProviderCanceled(id) {
      check(await db.from("billing_subscriptions").update({ provider_canceled_at: new Date().toISOString() }).eq("id", id), "markProviderCanceled");
    },

    async listDueForReconciliation({ endBefore, endAfter, limit }) {
      const rows = check(
        await db
          .from("billing_subscriptions")
          .select(BILLING_COLUMNS)
          .eq("provider", provider)
          .in("status", ["ACTIVE", "PAST_DUE"])
          .not("external_subscription_id", "is", null)
          .lte("current_period_end", endBefore)
          .gte("current_period_end", endAfter)
          .order("current_period_end", { ascending: true })
          .limit(limit),
        "listDueForReconciliation"
      ) as Row[];
      return rows.map(toBillingRow);
    },

    async listStalePending({ withSubscriptionCreatedBefore, withoutSubscriptionCreatedBefore, limit }) {
      const [withSubscription, withoutSubscription] = await Promise.all([
        db
          .from("billing_subscriptions")
          .select(BILLING_COLUMNS)
          .eq("provider", provider)
          .eq("status", "PENDING")
          .not("external_subscription_id", "is", null)
          .lte("created_at", withSubscriptionCreatedBefore)
          .order("created_at", { ascending: true })
          .limit(limit),
        db
          .from("billing_subscriptions")
          .select(BILLING_COLUMNS)
          .eq("provider", provider)
          .eq("status", "PENDING")
          .is("external_subscription_id", null)
          .lte("created_at", withoutSubscriptionCreatedBefore)
          .order("created_at", { ascending: true })
          .limit(limit)
      ]);
      return [...(check(withSubscription, "listStalePending") as Row[]), ...(check(withoutSubscription, "listStalePending") as Row[])].map(toBillingRow);
    }
  };
}

export function createEmailStore(db: SupabaseClient): EmailStore {
  return {
    async findEmailIdByInternetMessageId(emailAccountId, internetMessageId, receivedAt) {
      const rows = check(
        await db
          .from("emails")
          .select("id")
          .eq("email_account_id", emailAccountId)
          .eq("internet_message_id", internetMessageId)
          .eq("received_at", receivedAt)
          .limit(1),
        "findEmailIdByInternetMessageId"
      ) as Row[];
      return rows[0]?.id ?? null;
    },

    async findEmail(emailAccountId, providerMessageId) {
      const row = check(
        await db
          .from("emails")
          .select("id,processing_status,processing_attempts,processing_started_at,bot_id,bot_selection:provider_metadata->>botSelection,extracted_data")
          .eq("email_account_id", emailAccountId)
          .eq("provider_message_id", providerMessageId)
          .maybeSingle(),
        "findEmail"
      ) as Row | null;
      return row
        ? {
            id: row.id,
            processingStatus: row.processing_status,
            processingAttempts: row.processing_attempts,
            processingStartedAt: row.processing_started_at,
            botId: row.bot_id ?? null,
            botSelection: row.bot_selection === "AMBIGUOUS" ? "AMBIGUOUS" : null,
            extractedData: toExtractedData(row.extracted_data)
          }
        : null;
    },

    async updateProcessingState(emailId, state) {
      const columns: Row = { processing_status: state.status };
      if (state.attempts !== undefined) columns.processing_attempts = state.attempts;
      if (state.processedAt !== undefined) columns.processed_at = state.processedAt;
      if (state.errorCode !== undefined) columns.processing_error_code = state.errorCode?.slice(0, 150) ?? null;
      if (state.errorMessage !== undefined) columns.processing_error_message = state.errorMessage?.slice(0, 4000) ?? null;
      check(await db.from("emails").update(columns).eq("id", emailId), "updateProcessingState");
    },

    async listIncompleteEmails({ startedBefore, limit, imap, after, excludeOrganizations }) {
      let query = db
        .from("emails")
        .select(
          imap === "only"
            ? "id,organization_id,email_account_id,provider_message_id,processing_attempts,processing_started_at,email_accounts!inner(provider,status),organizations!inner(status)"
            : "id,organization_id,email_account_id,provider_message_id,processing_attempts,email_accounts!inner(provider,status),organizations!inner(status)"
        )
        .in("processing_status", ["RECEIVED", "PROCESSING"])
        .lt("processing_started_at", startedBefore)
        .eq("email_accounts.status", "ACTIVE")
        // Suspended organizations keep their incomplete emails untouched (not retried towards FAILED).
        .eq("organizations.status", "ACTIVE");
      // F2: IMAP mailboxes get their own recovery batch (handle-email-event.ts), so they never fill this one.
      if (imap === "exclude") query = query.neq("email_accounts.provider", "IMAP");
      if (imap === "only") {
        // F2.2: a page of the bounded IMAP recovery scan: a total order (id breaks ties), rows strictly after the previous
        // page's last key, minus the organizations already settled for this run (blocked or with enough candidates).
        query = query.eq("email_accounts.provider", "IMAP");
        if (after) query = query.or(`processing_started_at.gt."${after.startedAt}",and(processing_started_at.eq."${after.startedAt}",id.gt.${after.id})`);
        if (excludeOrganizations && excludeOrganizations.length > 0) query = query.not("organization_id", "in", `(${excludeOrganizations.join(",")})`);
        const page = check(
          await query.order("processing_started_at", { ascending: true }).order("id", { ascending: true }).limit(limit),
          "listIncompleteEmails"
        ) as Row[];
        return page.map((row) => ({
          id: row.id,
          organizationId: row.organization_id,
          emailAccountId: row.email_account_id,
          provider: row.email_accounts.provider,
          providerMessageId: row.provider_message_id,
          processingAttempts: row.processing_attempts,
          processingStartedAt: row.processing_started_at
        }));
      }
      const rows = check(await query.order("processing_started_at", { ascending: true }).limit(limit), "listIncompleteEmails") as Row[];
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        emailAccountId: row.email_account_id,
        provider: row.email_accounts.provider,
        providerMessageId: row.provider_message_id,
        processingAttempts: row.processing_attempts
      }));
    },

    async loadEnabledRules(organizationId) {
      const rows = check(
        await db
          .from("email_rules")
          // bot:bots(status): rules of PAUSED bots are not evaluated (rules-engine parseRuleRow).
          .select("id,name,enabled,priority,stop_processing,match_mode,category_id,bot_id,bot:bots(status),conditions,actions,created_at")
          .eq("organization_id", organizationId)
          .eq("enabled", true)
          .order("priority", { ascending: true })
          .order("created_at", { ascending: true }),
        "loadEnabledRules"
      ) as unknown as Array<Omit<EmailRuleRow, "bot"> & { bot: EmailRuleRow["bot"] | Array<{ status: string }> }>;
      // Many-to-one embeds come back as an object; accept a one-element array too (untyped client).
      return rows.map((row) => ({ ...row, bot: (Array.isArray(row.bot) ? row.bot[0] : row.bot) ?? null }));
    },

    async loadSettings(organizationId): Promise<OrganizationProcessingSettings> {
      const row = check(
        await db
          .from("organization_settings")
          .select("auto_processing_enabled,process_attachments,notifications_enabled")
          .eq("organization_id", organizationId)
          .maybeSingle(),
        "loadSettings"
      ) as Row | null;

      // Defaults of migration 4 if the row is missing.
      return {
        autoProcessingEnabled: row?.auto_processing_enabled ?? true,
        processAttachments: row?.process_attachments ?? true,
        notificationsEnabled: row?.notifications_enabled ?? true
      };
    },

    async insertEmail(row) {
      // Relies on the unique index emails_account_provider_message_unique_idx (migration 5).
      const rows = check(
        await db
          .from("emails")
          .upsert(row, { onConflict: "email_account_id,provider_message_id", ignoreDuplicates: true })
          .select("id"),
        "insertEmail"
      ) as Row[];
      return rows[0] ? { id: rows[0].id as string } : null;
    },

    async insertAttachments(rows) {
      // Unique (email_id, provider_attachment_id) of migration 9: a concurrent or
      // resumed insert of the same attachment is a no-op (NULL ids never conflict).
      const inserted = check(
        await db
          .from("email_attachments")
          .upsert(rows, { onConflict: "email_id,provider_attachment_id", ignoreDuplicates: true })
          .select("id,provider_attachment_id"),
        "insertAttachments"
      ) as Row[];
      // PostgREST returns rows in insertion order.
      return inserted.map((row) => ({ id: row.id, providerAttachmentId: row.provider_attachment_id }));
    },

    async listAttachments(emailId) {
      const rows = check(
        await db
          .from("email_attachments")
          .select("id,provider_attachment_id,filename,content_type,file_size,is_inline,storage_uploaded")
          .eq("email_id", emailId)
          .order("created_at", { ascending: true }),
        "listAttachments"
      ) as Row[];
      return rows.map((row) => ({
        id: row.id,
        providerAttachmentId: row.provider_attachment_id,
        filename: row.filename,
        contentType: row.content_type,
        fileSize: row.file_size === null ? null : Number(row.file_size),
        isInline: row.is_inline,
        storageUploaded: row.storage_uploaded
      }));
    },

    async markAttachmentStored(attachmentId, bucket, path) {
      check(
        await db
          .from("email_attachments")
          .update({ storage_bucket: bucket, storage_path: path, storage_uploaded: true })
          .eq("id", attachmentId),
        "markAttachmentStored"
      );
    }
  };
}

/** emails.extracted_data as string values only (written by the worker, read defensively). */
function toExtractedData(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** PostgREST in.(...) list with every value double-quoted and escaped (values come from emails). */
export function quotedInList(values: string[]): string {
  return `(${values.map((value) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")})`;
}

const LOOKUP_CHUNK = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * CustomerResolver persistence (EmailBot V2 phase 3). Column grants only:
 * bots.customer_resolution/status, customers(id, organization_id, status),
 * customer_identifiers without the raw value, bot_customer_assignments, and
 * INSERT on email_deliveries. Every query is scoped by organization_id.
 */
export function createRoutingStore(db: SupabaseClient): RoutingStore {
  return {
    async loadBot(organizationId, botId) {
      const row = check(
        await db
          .from("bots")
          .select("id,organization_id,status,customer_resolution")
          .eq("organization_id", organizationId)
          .eq("id", botId)
          .maybeSingle(),
        "loadBot"
      ) as Row | null;
      return row
        ? { id: row.id, organizationId: row.organization_id, status: row.status, customerResolution: row.customer_resolution }
        : null;
    },

    async findCandidates({ organizationId, botId, type, values }) {
      if (values.length === 0) return [];
      if (!UUID.test(botId)) throw new Error("findCandidates: invalid bot id");
      const identifiers: Row[] = [];
      for (let start = 0; start < values.length; start += LOOKUP_CHUNK) {
        const rows = check(
          await db
            .from("customer_identifiers")
            .select("id,organization_id,customer_id,type,normalized_value,bot_id,active,customer:customers!inner(status)")
            .eq("organization_id", organizationId)
            .eq("type", type)
            .eq("active", true)
            .or(`bot_id.is.null,bot_id.eq.${botId}`)
            .filter("normalized_value", "in", quotedInList(values.slice(start, start + LOOKUP_CHUNK))),
          "findCandidates"
        ) as Row[];
        identifiers.push(...rows);
      }
      if (identifiers.length === 0) return [];

      const customerIds = [...new Set(identifiers.map((row) => row.customer_id as string))];
      const assignments = check(
        await db
          .from("bot_customer_assignments")
          .select("customer_id")
          .eq("organization_id", organizationId)
          .eq("bot_id", botId)
          .eq("active", true)
          .in("customer_id", customerIds),
        "findCandidates.assignments"
      ) as Row[];
      const assigned = new Set(assignments.map((row) => row.customer_id as string));

      return identifiers.map((row): IdentifierCandidate => {
        const customer = Array.isArray(row.customer) ? row.customer[0] : row.customer;
        return {
          identifierId: row.id,
          organizationId: row.organization_id,
          customerId: row.customer_id,
          type: row.type,
          normalizedValue: row.normalized_value,
          botId: row.bot_id ?? null,
          active: row.active === true,
          // Fail closed: a customer whose status cannot be read is not eligible.
          customerStatus: customer?.status ?? "SUSPENDED",
          assigned: assigned.has(row.customer_id)
        };
      });
    },

    async insertDeliveries(rows) {
      if (rows.length === 0) return [];
      const inserted = check(
        await db
          .from("email_deliveries")
          .upsert(rows, { onConflict: "email_id,customer_id", ignoreDuplicates: true })
          .select("customer_id"),
        "insertDeliveries"
      ) as Row[];
      return inserted.map((row) => row.customer_id as string);
    }
  };
}

export function createAuditRecorder(db: SupabaseClient): AuditRecorder {
  return {
    async recordAccountEvent(entry) {
      check(
        await db.from("audit_logs").insert({
          organization_id: entry.organizationId,
          actor_type: "SYSTEM",
          actor_user_id: null,
          action: entry.action,
          entity_type: "email_account",
          entity_id: entry.emailAccountId,
          description: entry.description.slice(0, 2000),
          metadata: { event: entry.event, ...entry.metadata }
        }),
        "recordAccountEvent"
      );
    },

    async recordEmailEvent(entry) {
      check(
        await db.from("audit_logs").insert({
          organization_id: entry.organizationId,
          actor_type: "SYSTEM",
          actor_user_id: null,
          action: "PROCESS",
          entity_type: "email",
          entity_id: entry.emailId,
          description: entry.description.slice(0, 2000),
          metadata: { event: entry.event, ...entry.metadata }
        }),
        "recordEmailEvent"
      );
    }
  };
}

/**
 * `uploads`: the client used for uploads only (F5.5: its own limit and the shutdown cancellation, see
 * supabase-client.ts); the existence check uses `db`. Uploads overwrite (upsert) the deterministic path, so a
 * repeated upload never creates a second object.
 */
export function createAttachmentStorage(db: SupabaseClient, uploads: SupabaseClient = db): AttachmentStorage {
  return {
    async upload(bucket, path, content, contentType) {
      const { error } = await uploads.storage.from(bucket).upload(path, content, {
        contentType: contentType ?? "application/octet-stream",
        upsert: true
      });
      if (!error) return;
      // F5.5: a timeout or a shutdown cancellation keeps its type (storage-js wraps it): the caller treats them apart.
      const original = (error as { originalError?: unknown }).originalError;
      if (original instanceof HttpTimeoutError || original instanceof RequestCancelledError) throw original;
      throw new Error(`Storage upload failed: ${error.message}`);
    },
    async exists(bucket, path) {
      const { data, error } = await db.storage.from(bucket).exists(path);
      if (data) return true;
      // 400/404 = not found; anything else is a real failure (retried by the caller).
      const status = (error as { status?: number; statusCode?: string } | null)?.status;
      if (!error || status === 400 || status === 404) return false;
      throw new Error(`Storage existence check failed: ${error.message}`);
    }
  };
}

/** The one Redis command the publisher needs (an ioredis client, or index.ts's bounded application client). */
export interface RealtimeRedis {
  publish(channel: string, message: string): Promise<number>;
}

/** F5.2: publishing on a bounded application client (index.ts); a failure or timeout rejects (never a success). */
export function createAppRealtimePublisher(app: AppRedis): RealtimePublisher {
  return createRealtimePublisher({ publish: (channel, message) => app.run("realtime publish", (redis) => redis.publish(channel, message)) });
}

export function createRealtimePublisher(redis: RealtimeRedis): RealtimePublisher {
  return {
    async publish(event) {
      await redis.publish(REALTIME_REDIS_CHANNEL, JSON.stringify(event));
    }
  };
}
