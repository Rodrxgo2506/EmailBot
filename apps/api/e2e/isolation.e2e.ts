/*
 * EmailBot V2 - end-to-end tenant and customer isolation (phase 7).
 *
 * Runs against a LOCAL Supabase stack only (Auth, PostgREST + RLS, Postgres
 * triggers and functions), the real API (buildApp, in process) and the real
 * worker pipeline (processEmail with the real Supabase stores; only the Gmail
 * provider is replaced by in-memory messages):
 *
 *   Organization A: bot Netflix, customers A1 and A2
 *   Organization B: bot Netflix, customer B1 whose identifier is A1's address
 *
 * Emails with crossed identifiers are processed and isolation is checked in
 * the database (RLS as each user, anon), the panel API, the customer portal
 * and the realtime signals.
 *
 *   supabase start && supabase db reset          # local stack, every migration
 *   pnpm --filter @emailbot/api e2e              # reads LOCAL_* or `supabase status`
 *
 * Every run uses unique names, so it can be repeated without a reset. It
 * refuses to run against anything but 127.0.0.1 / localhost.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { SecretBox } from "@emailbot/shared";
import type { NormalizedEmail, RealtimeEvent } from "@emailbot/types";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { AppDeps, JobQueue } from "../src/deps.js";
import { createMemoryNonceStore } from "../src/infrastructure/nonces.js";
import { adminOperations, createSupabaseClients, createSupabaseRepositories, privilegedOperations } from "../src/repositories/supabase/index.js";
import {
  createAccountStore,
  createAttachmentStorage,
  createAuditRecorder,
  createEmailStore,
  createRoutingStore
} from "../../worker/src/infrastructure/supabase-stores.js";
import { processEmail, type ProcessEmailDeps } from "../../worker/src/pipeline/process-email.js";
import type { ProviderRegistry } from "../../worker/src/providers/registry.js";
import type { ProviderAdapter, WorkerAccount } from "../../worker/src/providers/types.js";

/* ------------------------------------------------------------------ local stack only */

function localEnv(): { url: string; anonKey: string; serviceKey: string } {
  let url = process.env.LOCAL_SUPABASE_URL ?? "";
  let anonKey = process.env.LOCAL_ANON_KEY ?? "";
  let serviceKey = process.env.LOCAL_SERVICE_ROLE_KEY ?? "";
  if (!url || !anonKey || !serviceKey) {
    const status = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" });
    const read = (name: string) => /^(?:export )?NAME="?([^"\n]*)"?$/m.source.replace("NAME", name);
    url ||= new RegExp(read("API_URL"), "m").exec(status)?.[1] ?? "";
    anonKey ||= new RegExp(read("ANON_KEY"), "m").exec(status)?.[1] ?? "";
    serviceKey ||= new RegExp(read("SERVICE_ROLE_KEY"), "m").exec(status)?.[1] ?? "";
  }
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) throw new Error("refusing to run: the E2E only runs against a local Supabase stack");
  if (!anonKey || !serviceKey) throw new Error("missing local Supabase keys (supabase start)");
  return { url, anonKey, serviceKey };
}

const { url, anonKey, serviceKey } = localEnv();

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}
const must = <T>(value: T | undefined | null, label: string): T => {
  if (value === undefined || value === null) throw new Error(`setup failed: ${label}`);
  return value;
};
const sameSet = (actual: string[], expected: string[]) => actual.length === expected.length && [...actual].sort().join() === [...expected].sort().join();

/* ------------------------------------------------------------------ API in process */

const run = randomBytes(3).toString("hex");
const password = randomBytes(18).toString("base64url");
const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
async function newUser(name: string) {
  const email = `${name}-${run}@e2e.test`;
  const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser ${name}: ${error?.message}`);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const session = await client.auth.signInWithPassword({ email, password });
  if (session.error || !session.data.session) throw new Error(`signIn ${name}: ${session.error?.message}`);
  return { id: data.user.id, email, token: session.data.session.access_token };
}

const queue: JobQueue = {
  async enqueueEmailEvent() {},
  async requestAccountSync() {
    return "QUEUED";
  },
  async isAccountSyncPending() {
    return false;
  },
  async close() {}
};
const config = loadConfig({
  NODE_ENV: "test",
  SUPABASE_URL: url,
  SUPABASE_ANON_KEY: anonKey,
  SUPABASE_SERVICE_ROLE_KEY: serviceKey,
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  OAUTH_STATE_SECRET: randomBytes(32).toString("hex"),
  CORS_ORIGINS: "http://localhost:5173",
  RATE_LIMIT_MAX: "100000"
});
const clients = createSupabaseClients(config.supabase);
const secretBox = SecretBox.fromBase64(config.tokenEncryptionKey);
const privileged = privilegedOperations(clients.service);
const deps: AppDeps = {
  config,
  identity: {
    async verifyAccessToken(token) {
      const { data, error } = await clients.anon.auth.getUser(token);
      return error || !data.user ? null : { id: data.user.id, email: data.user.email ?? null };
    }
  },
  repositories: (token) => createSupabaseRepositories(clients.forUser(token)),
  privileged,
  admin: adminOperations(clients.service),
  queue,
  secretBox,
  fetch: globalThis.fetch,
  readinessChecks: [],
  oauthNonces: createMemoryNonceStore()
};
const app = await buildApp(deps, { logger: false });

let ip = 1;
async function call(method: string, path: string, token: string | null, org: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (org) headers["x-organization-id"] = org;
  const response = await app.inject({
    method: method as "GET",
    url: path,
    headers,
    remoteAddress: `198.51.100.${(ip++ % 250) + 1}`,
    ...(body !== undefined ? { payload: body as object } : {})
  });
  let json: any = null;
  try {
    json = response.json();
  } catch {
    json = response.body;
  }
  return { status: response.statusCode, json, raw: response.body };
}
async function portalLogin(accessId: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/portal/session",
    remoteAddress: `203.0.113.${(ip++ % 250) + 1}`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ accessId })
  });
  if (response.statusCode !== 200) throw new Error(`portal login failed: ${response.statusCode}`);
  const header = response.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0] as string;
}
async function portal(path: string, cookie: string) {
  const response = await app.inject({ method: "GET", url: path, headers: { cookie }, remoteAddress: `203.0.113.${(ip++ % 250) + 1}` });
  let json: any = null;
  try {
    json = response.json();
  } catch {
    json = response.body;
  }
  return { status: response.statusCode, json, raw: response.body };
}
const userDb = (token: string): SupabaseClient =>
  createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });

/* ------------------------------------------------------------------ setup: two organizations, three customers */

const ownerA = await newUser("owner-a");
const operatorA = await newUser("operator-a");
const ownerB = await newUser("owner-b");
const orgA: string = must((await call("POST", "/api/organizations", ownerA.token, null, { name: `E2E A ${run}` })).json?.organization?.id, "org A");
const orgB: string = must((await call("POST", "/api/organizations", ownerB.token, null, { name: `E2E B ${run}` })).json?.organization?.id, "org B");
must((await call("POST", "/api/organizations/current/members", ownerA.token, orgA, { email: operatorA.email, role: "OPERATOR" })).json?.member, "operator A");

const RESOLUTION = { source: "RECIPIENT", onMultipleMatches: "DELIVER_ALL" };
const BODY = { showBody: true, showAttachments: true, fields: [] };
const botA: string = must((await call("POST", "/api/bots", ownerA.token, orgA, { name: "Netflix", customerResolution: RESOLUTION, portalSettings: BODY })).json?.bot?.id, "bot A");
const botB: string = must((await call("POST", "/api/bots", ownerB.token, orgB, { name: "Netflix", customerResolution: RESOLUTION, portalSettings: BODY })).json?.bot?.id, "bot B");
for (const [token, org, bot] of [
  [ownerA.token, orgA, botA],
  [ownerB.token, orgB, botB]
] as const) {
  must((await call("POST", "/api/rules", token, org, { name: "Netflix", priority: 10, botId: bot, conditions: [{ field: "sender", operator: "contains", value: "netflix.example" }] })).json?.rule?.id, "rule");
}

const address = (name: string) => `${name}-${run}@cliente.test`;
async function customer(token: string, org: string, bot: string, name: string, identifier: string) {
  const id: string = must((await call("POST", "/api/customers", token, org, { displayName: name })).json?.customer?.id, `customer ${name}`);
  must((await call("POST", `/api/customers/${id}/identifiers`, token, org, { type: "EMAIL", value: identifier })).json?.identifier?.id, `identifier ${name}`);
  must((await call("POST", `/api/bots/${bot}/customers`, token, org, { customerId: id })).status === 201 ? true : null, `assignment ${name}`);
  const accessId: string = must((await call("POST", `/api/customers/${id}/access`, token, org, {})).json?.accessId, `access ${name}`);
  return { id, accessId };
}
const a1 = await customer(ownerA.token, orgA, botA, "Cliente A1", address("uno"));
const a2 = await customer(ownerA.token, orgA, botA, "Cliente A2", address("dos"));
// Crossed identifier: B1 is recognized by A1's address, in another organization.
const b1 = await customer(ownerB.token, orgB, botB, "Cliente B1", address("uno"));

async function account(org: string, box: string) {
  const created = await privileged.upsertOAuthEmailAccount({
    organizationId: org,
    provider: "GMAIL",
    emailAddress: box,
    displayName: null,
    providerAccountId: `g-${box}`,
    accessTokenEncrypted: secretBox.encrypt("access"),
    refreshTokenEncrypted: secretBox.encrypt("refresh"),
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    syncCursor: "1"
  });
  return created.account.id;
}
const accountA = await account(orgA, `box-a-${run}@e2e.test`);
const accountB = await account(orgB, `box-b-${run}@e2e.test`);

/* ------------------------------------------------------------------ worker pipeline against the real database */

const messages = new Map<string, NormalizedEmail>();
const mail = (id: string, to: string[], subject: string): NormalizedEmail => ({
  provider: "GMAIL",
  providerMessageId: id,
  threadId: null,
  internetMessageId: null,
  accountId: "x",
  direction: "INBOUND",
  sender: { address: "info@netflix.example", name: "Netflix" },
  recipients: to.map((value) => ({ address: value, name: null })),
  cc: [],
  bcc: [],
  subject,
  snippet: null,
  textBody: `Contenido de ${subject}`,
  htmlBody: null,
  receivedAt: new Date().toISOString(),
  sentAt: null,
  attachments: [],
  headers: {}
});
const gmail: ProviderAdapter = {
  provider: "GMAIL",
  async listNewMessageIds() {
    return { messageIds: [], nextCursor: "2" };
  },
  async fetchMessage(_context, id) {
    return must(messages.get(id), `message ${id}`);
  },
  async downloadAttachment() {
    return new Uint8Array();
  }
};
const signals: Array<Extract<RealtimeEvent, { type: "portal.deliveries" }>> = [];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const processDeps: ProcessEmailDeps = {
  accounts: createAccountStore(clients.service),
  emails: createEmailStore(clients.service),
  routing: createRoutingStore(clients.service),
  audit: createAuditRecorder(clients.service),
  storage: createAttachmentStorage(clients.service),
  providers: { GMAIL: gmail, MICROSOFT: gmail, IMAP: gmail } as unknown as ProviderRegistry,
  realtime: {
    async publish(event) {
      if (event.type === "portal.deliveries") signals.push(event);
    }
  },
  producer: { async enqueueProcessing() {}, async enqueueNotification() {} },
  createContext: (acc: WorkerAccount) => ({ account: acc, async getAccessToken() { return "x"; } }) as never,
  attachmentsBucket: config.attachmentsBucket,
  maxAttachmentBytes: 1024,
  logger: quiet
};

const SUBJECT = (name: string) => `${name} ${run}`;
const scenarios = [
  { id: "e1", org: orgA, account: accountA, to: [address("uno")], subject: SUBJECT("E1 para A1"), expected: [a1.id] },
  { id: "e2", org: orgA, account: accountA, to: [address("dos")], subject: SUBJECT("E2 para A2"), expected: [a2.id] },
  { id: "e3", org: orgA, account: accountA, to: [address("uno"), address("dos")], subject: SUBJECT("E3 para A1 y A2"), expected: [a1.id, a2.id] },
  { id: "e4", org: orgB, account: accountB, to: [address("uno")], subject: SUBJECT("E4 para B1"), expected: [b1.id] },
  { id: "e5", org: orgB, account: accountB, to: [address("dos")], subject: SUBJECT("E5 sin cliente en B"), expected: [] }
];
const emailIds = new Map<string, string>();
for (const scenario of scenarios) {
  messages.set(scenario.id, mail(scenario.id, scenario.to, scenario.subject));
  const before = signals.length;
  const outcome = await processEmail({ organizationId: scenario.org, emailAccountId: scenario.account, provider: "GMAIL", providerMessageId: scenario.id }, processDeps);
  const owner = scenario.org === orgA ? ownerA : ownerB;
  const email = (await userDb(owner.token).from("emails").select("id").eq("email_account_id", scenario.account).eq("provider_message_id", scenario.id).maybeSingle()).data;
  emailIds.set(scenario.id, must(email?.id as string | undefined, `email ${scenario.id}`));
  const delivered = ((await userDb(owner.token).from("email_deliveries").select("customer_id").eq("email_id", email?.id ?? "")).data ?? []).map((row) => row.customer_id as string);
  check(outcome.status === "processed" && sameSet(delivered, scenario.expected), `pipeline ${scenario.id}: delivered to exactly the expected customers`, `${delivered.length}`);
  const signal = signals.slice(before);
  check(
    scenario.expected.length === 0 ? signal.length === 0 : signal.length === 1 && signal[0]?.organizationId === scenario.org && sameSet(signal[0].customerIds, scenario.expected),
    `realtime ${scenario.id}: portal signal only for the delivered customers of the same organization`
  );
}

/* ------------------------------------------------------------------ database: RLS as each user */

{
  const deliveriesAs = async (token: string) =>
    ((await userDb(token).from("email_deliveries").select("organization_id,customer_id")).data ?? []) as Array<{ organization_id: string; customer_id: string }>;
  const ownA = await deliveriesAs(ownerA.token);
  const ownB = await deliveriesAs(ownerB.token);
  check(ownA.length === 4 && ownA.every((row) => row.organization_id === orgA), "RLS: owner A reads only organization A deliveries", `${ownA.length}`);
  check(ownB.length === 1 && ownB.every((row) => row.organization_id === orgB && row.customer_id === b1.id), "RLS: owner B reads only organization B deliveries");
  const crossEmails = (await userDb(ownerA.token).from("emails").select("id").in("id", [emailIds.get("e4") ?? "", emailIds.get("e5") ?? ""])).data ?? [];
  check(crossEmails.length === 0, "RLS: owner A cannot read organization B emails by id");
  const crossCustomers = (await userDb(ownerB.token).from("customers").select("id").in("id", [a1.id, a2.id])).data ?? [];
  check(crossCustomers.length === 0, "RLS: owner B cannot read organization A customers by id");
  const anonClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const anonRead = await anonClient.from("email_deliveries").select("id");
  check(anonRead.error !== null || (anonRead.data ?? []).length === 0, "anon reads no deliveries");
  const operatorCrossInsert = await userDb(operatorA.token)
    .from("email_deliveries")
    .insert({ organization_id: orgB, email_id: emailIds.get("e4"), customer_id: b1.id, bot_id: botB, resolution: "MANUAL" });
  check(operatorCrossInsert.error !== null, "RLS: an operator of A cannot insert a delivery into organization B");
}

/* ------------------------------------------------------------------ panel API */

{
  const listA = await call("GET", "/api/emails?pageSize=100", ownerA.token, orgA);
  const subjectsA: string[] = (listA.json?.items ?? []).map((item: { subject: string }) => item.subject);
  check(listA.status === 200 && !subjectsA.some((subject) => subject.includes("E4") || subject.includes("E5")), "API: organization A inbox has no organization B emails");
  check((await call("GET", `/api/emails/${emailIds.get("e4")}`, ownerA.token, orgA)).status === 404, "API: organization B email by id from A -> 404");
  check((await call("GET", `/api/emails/${emailIds.get("e1")}`, ownerA.token, orgB)).status === 403, "API: owner A with X-Organization-Id of B -> 403 (not a member)");
  const customersA = await call("GET", "/api/customers?pageSize=100", ownerA.token, orgA);
  check(!JSON.stringify(customersA.json).includes(b1.id), "API: organization B customer not listed in A");
  check(
    (await call("POST", `/api/emails/${emailIds.get("e4")}/deliveries`, operatorA.token, orgA, { customerId: a1.id })).status === 404,
    "API: manual delivery of an organization B email from A -> 404"
  );
  check(
    (await call("POST", `/api/emails/${emailIds.get("e1")}/deliveries`, operatorA.token, orgA, { customerId: b1.id })).status === 404,
    "API: manual delivery to an organization B customer from A -> 404"
  );
}

/* ------------------------------------------------------------------ customer portal */

{
  const cookieA1 = await portalLogin(a1.accessId);
  const cookieA2 = await portalLogin(a2.accessId);
  const cookieB1 = await portalLogin(b1.accessId);
  const inbox = async (cookie: string) => {
    const response = await portal("/api/portal/inbox?limit=50", cookie);
    return { response, subjects: (response.json?.items ?? []).map((item: { subject: string }) => item.subject) as string[], deliveries: (response.json?.items ?? []).map((item: { deliveryId: string }) => item.deliveryId) as string[] };
  };
  const inboxA1 = await inbox(cookieA1);
  const inboxA2 = await inbox(cookieA2);
  const inboxB1 = await inbox(cookieB1);
  check(sameSet(inboxA1.subjects, [SUBJECT("E1 para A1"), SUBJECT("E3 para A1 y A2")]), "portal A1 sees exactly E1 and E3", inboxA1.subjects.join(" | "));
  check(sameSet(inboxA2.subjects, [SUBJECT("E2 para A2"), SUBJECT("E3 para A1 y A2")]), "portal A2 sees exactly E2 and E3", inboxA2.subjects.join(" | "));
  check(sameSet(inboxB1.subjects, [SUBJECT("E4 para B1")]), "portal B1 sees exactly E4 (A1's identifier does not leak across organizations)", inboxB1.subjects.join(" | "));

  const e2ForA2 = inboxA2.deliveries.find((_, index) => inboxA2.subjects[index] === SUBJECT("E2 para A2"));
  check((await portal(`/api/portal/email/${e2ForA2}`, cookieA1)).status === 404, "portal A1 cannot open A2's delivery by id");
  check((await portal(`/api/portal/email/${inboxB1.deliveries[0]}`, cookieA1)).status === 404, "portal A1 cannot open B1's delivery by id");
  check((await portal(`/api/portal/email/${inboxA1.deliveries[0]}`, cookieB1)).status === 404, "portal B1 cannot open A1's delivery by id");
  const own = await portal(`/api/portal/email/${inboxA1.deliveries[0]}`, cookieA1);
  check(
    own.status === 200 && inboxA1.subjects.includes(own.json?.email?.subject) && typeof own.json?.email?.body?.text === "string",
    "portal A1 opens its own delivery (with the body the bot allows)"
  );
  const everything = [inboxA1.response.raw, own.raw].join("\n");
  check(!everything.includes("E4") && !everything.includes(b1.id) && !everything.includes(orgB), "portal A1 responses contain nothing from organization B");
  const searchB = await portal(`/api/portal/inbox?search=${encodeURIComponent("E4")}`, cookieA1);
  check(searchB.status === 200 && (searchB.json?.items ?? []).length === 0, "portal A1 search cannot reach organization B content");

  // Suspending A2 ends A2's access only.
  check((await call("PATCH", `/api/customers/${a2.id}`, ownerA.token, orgA, { status: "SUSPENDED" })).status === 200, "setup: customer A2 suspended");
  check((await portal("/api/portal/inbox", cookieA2)).status === 401, "suspended A2: portal session rejected");
  check((await portal("/api/portal/inbox", cookieA1)).status === 200, "A1 is unaffected by A2's suspension");
}

await app.close();
console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
