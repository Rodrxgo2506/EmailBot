import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import { imapConnectionOptions, resolveImapDestination, type ImapResolver } from "@emailbot/shared";
import type { EmailProcessingJob } from "@emailbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { processEmail, type ProcessEmailDeps } from "../pipeline/process-email.js";
import { syncAccount, type HandleEventDeps } from "../pipeline/handle-email-event.js";
import { createImapSyncAdapter } from "../providers/imap/adapter.js";
import { createImapConnector, openImapClient, type ImapClient } from "../providers/imap/connection.js";
import { ImapConnectionPool } from "../providers/imap/pool.js";
import { ProviderAuthError, ProviderSecurityError, ProviderTransientError, type ProviderContext, type WorkerAccount } from "../providers/types.js";
import { integrationScriptCommand } from "./imap-integration-paths.js";
import { IMAP_TEST_ORGANIZATION_IDS, makeAccount, makeAccountStore, makeAdapter, makeAudit, makeProducer, makeRealtime, makeRuleRow, MemoryEmailStore, MemoryRoutingStore, silentLogger } from "./fakes.js";

/*
 * IMAP E2 - REAL integration tests against a local, throwaway Dovecot 2.4.5
 * (apps/worker/scripts/imap-integration-dovecot.sh, published on 127.0.0.1 only;
 * see docs/imap.md). Opt-in: every test here is SKIPPED (never reported as passed)
 * unless IMAP_INTEGRATION_SCENARIO is set (A: valid certificate, B: untrusted
 * certificate, C: no STARTTLS). CI never sets it. Never a real mailbox.
 *
 * The PRODUCTION connector is used unchanged (E1 SSRF checks, validated IP
 * literal, servername = DNS name, certificate verification). The test DNS
 * answer is a public IP (TEST_IP), which is what the client really dials:
 * a socket-level hook RECORDS every TCP destination requested by ImapFlow and
 * only then redirects TEST_IP to 127.0.0.1 (the authorized "host change" for
 * protocol tests). The test CA is trusted through NODE_EXTRA_CA_CERTS, set by
 * the runner for this process only (never through connection options).
 */

const SCENARIO = process.env.IMAP_INTEGRATION_SCENARIO ?? "";
const PASSWORD = process.env.IMAP_TEST_PASSWORD ?? "";
const HOST = "imap.emailbot-e2-integration.com";
const TEST_IP = "93.184.216.34";
const CLOSED_IP = "93.184.216.35";
if (SCENARIO !== "" && (!["A", "B", "C"].includes(SCENARIO) || PASSWORD.length === 0)) {
  // Asked for an integration run that cannot happen: fail loudly instead of skipping everything.
  throw new Error("IMAP_INTEGRATION_SCENARIO must be A, B or C, with IMAP_TEST_PASSWORD set (see docs/imap.md)");
}
const run = (scenario: string) => SCENARIO === scenario;

/* ---------------------------------------------------------------- *
 * Socket-level observation (real destinations, plaintext bytes)
 * ---------------------------------------------------------------- */

interface Dialed {
  host: string;
  port: number;
}
const dialed: Dialed[] = [];
const plaintextWrites: string[] = [];
const dnsLookups: string[] = [];
const originalConnect = net.Socket.prototype.connect;
const originalWrite = net.Socket.prototype.write;
const originalLookup = dns.lookup;

function installHooks() {
  net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]) {
    const options = (Array.isArray(args[0]) ? args[0][0] : args[0]) as { host?: string; port?: number } | undefined;
    if (options && typeof options === "object" && typeof options.host === "string") {
      dialed.push({ host: options.host, port: Number(options.port) });
      if (options.host === TEST_IP) options.host = "127.0.0.1";
      if (options.host === CLOSED_IP) {
        options.host = "127.0.0.1";
        options.port = 9; // nothing listens there: a real ECONNREFUSED
      }
    }
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  net.Socket.prototype.write = function patched(this: net.Socket, chunk: unknown, ...rest: unknown[]) {
    // Bytes handed to a socket that is NOT TLS-encrypted (plain TCP before / without STARTTLS).
    if (!(this as unknown as { encrypted?: boolean }).encrypted) plaintextWrites.push(Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk));
    return (originalWrite as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
  } as typeof net.Socket.prototype.write;
  dns.lookup = function patched(hostname: string, ...rest: unknown[]) {
    dnsLookups.push(hostname);
    return (originalLookup as (...a: unknown[]) => void).call(dns, hostname, ...rest);
  } as typeof dns.lookup;
}

function removeHooks() {
  net.Socket.prototype.connect = originalConnect;
  net.Socket.prototype.write = originalWrite;
  dns.lookup = originalLookup;
}

const resetObservations = () => {
  dialed.length = 0;
  plaintextWrites.length = 0;
  dnsLookups.length = 0;
};

const answer = (...addresses: string[]): ImapResolver => vi.fn(async () => addresses.map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 })));
const credentials = (user = "tester@emailbot-e2-integration.com", password = PASSWORD) => ({ username: user, password });
const TLS_993 = { host: HOST, port: 993, security: "TLS" as const };
const STARTTLS_143 = { host: HOST, port: 143, security: "STARTTLS" as const };

function script(...args: string[]): string {
  const { command, args: prefix } = integrationScriptCommand(process.env, { platform: process.platform, cwd: process.cwd() });
  const result = spawnSync(command, [...prefix, ...args], { encoding: "utf8", env: process.env });
  if (result.status !== 0) throw new Error(`script ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

/** Setup-only client (APPEND / read flags) on the same checked connection path. */
async function setupClient(user: string): Promise<ImapClient & { append: (path: string, content: Buffer) => Promise<unknown>; fetchAll: (...args: unknown[]) => Promise<Array<{ uid: number; flags: Set<string> }>> }> {
  const options = imapConnectionOptions(await resolveImapDestination(TLS_993, { resolver: answer(TEST_IP) }));
  return (await openImapClient(options, credentials(user))) as never;
}

function accountFor(user: string, overrides: Partial<WorkerAccount> = {}): WorkerAccount {
  return makeAccount({
    id: `acc-${user}`,
    provider: "IMAP",
    emailAddress: user,
    syncCursor: null,
    providerMetadata: { imap: { host: HOST, port: 993, security: "TLS", username: user } },
    accessTokenEncrypted: "v2.integration",
    ...overrides
  });
}
const contextFor = (account: WorkerAccount, user: string): ProviderContext => ({
  account,
  getAccessToken: () => Promise.reject(new Error("not OAuth")),
  getImapCredentials: async () => credentials(user)
});
const uniqueUser = (label: string) => `${label}-${randomBytes(4).toString("hex")}@emailbot-e2-integration.com`;
const crlf = (text: string) => Buffer.from(text.replace(/\r?\n/g, "\r\n"));
const simple = (n: number, extra = "") =>
  crlf(`From: Streaming <info@account.streaming.example>
To: me@empresa-correo.com
Subject: =?UTF-8?Q?Tu_c=C3=B3digo_temporal_${n}?=
Message-ID: <it-${n}-${randomBytes(3).toString("hex")}@streaming.example>
Date: Tue, 14 Oct 2026 09:00:00 +0000

Tu codigo es 4821 ${extra}
`);

beforeAll(() => installHooks());
afterAll(() => removeHooks());
afterEach(() => resetObservations());

/* ================================================================ *
 * Scenario A: valid certificate (test CA), TLS 993 + STARTTLS 143
 * ================================================================ */

describe.runIf(run("A"))("A - valid certificate", () => {
  it("1. TLS on 993: connected to the validated IP, certificate verified for the DNS name, no DNS at connect time", async () => {
    const client = await createImapConnector({ resolver: answer(TEST_IP) })(TLS_993, credentials());
    const socket = (client as unknown as { socket: import("node:tls").TLSSocket }).socket;
    expect(client.usable).toBe(true);
    expect(socket.encrypted).toBe(true);
    expect(socket.authorized).toBe(true);
    expect(socket.getPeerCertificate().subjectaltname).toBe(`DNS:${HOST}`);
    expect(socket.getProtocol()).toMatch(/^TLSv1\.[23]$/);
    expect(dialed).toEqual([{ host: TEST_IP, port: 993 }]);
    expect(dnsLookups).toEqual([]);
    await client.logout();
  });

  it("3. STARTTLS on 143 is negotiated (encrypted, verified) before the login", async () => {
    const client = await createImapConnector({ resolver: answer(TEST_IP) })(STARTTLS_143, credentials());
    const socket = (client as unknown as { socket: import("node:tls").TLSSocket }).socket;
    expect(socket.encrypted).toBe(true);
    expect(socket.authorized).toBe(true);
    expect(dialed).toEqual([{ host: TEST_IP, port: 143 }]);
    const plain = plaintextWrites.join("");
    expect(plain).toMatch(/STARTTLS/);
    expect(plain).not.toContain(PASSWORD);
    expect(plain).not.toMatch(/\bLOGIN\b|AUTHENTICATE/);
    await client.logout();
  });

  it("2b. the certificate is checked against the ORIGINAL name: another name is refused", async () => {
    const error = await createImapConnector({ resolver: answer(TEST_IP) })({ ...TLS_993, host: "imap.other-e2-integration.com" }, credentials()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSecurityError);
    expect((error as ProviderSecurityError).code).toBe("IMAP_TLS_FAILED");
  });

  it("5. private / internal / metadata destinations are refused before any socket is opened", async () => {
    for (const address of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1"]) {
      await expect(createImapConnector({ resolver: answer(address) })(TLS_993, credentials())).rejects.toBeInstanceOf(ProviderSecurityError);
    }
    await expect(createImapConnector({ resolver: answer(TEST_IP) })({ ...TLS_993, host: "mail.internal" }, credentials())).rejects.toBeInstanceOf(ProviderSecurityError);
    await expect(createImapConnector({ resolver: answer(TEST_IP, "192.168.1.9") })(TLS_993, credentials())).rejects.toBeInstanceOf(ProviderSecurityError);
    expect(dialed).toEqual([]);
  });

  it("6. DNS rebinding: the TCP destination is the validated IP; a later rebinding answer is refused, never dialed", async () => {
    let calls = 0;
    const rebinding: ImapResolver = vi.fn(async () => {
      calls += 1;
      return [{ address: calls === 1 ? TEST_IP : "127.0.0.1", family: 4 as const }];
    });
    const connect = createImapConnector({ resolver: rebinding });
    const client = await connect(TLS_993, credentials());
    expect(dialed).toEqual([{ host: TEST_IP, port: 993 }]); // the real dial target, recorded before the test redirect
    expect(dialed.some((entry) => entry.host === HOST)).toBe(false); // the name is never handed to the OS
    expect(dnsLookups).toEqual([]);
    await client.logout();
    resetObservations();
    await expect(connect(TLS_993, credentials())).rejects.toBeInstanceOf(ProviderSecurityError);
    expect(dialed).toEqual([]);
  });

  it("7. wrong password: ProviderAuthError (not retried)", async () => {
    await expect(createImapConnector({ resolver: answer(TEST_IP) })(TLS_993, credentials("tester@emailbot-e2-integration.com", "wrong-password"))).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("11b. network errors are transient (unreachable validated address)", async () => {
    await expect(createImapConnector({ resolver: answer(CLOSED_IP) })(TLS_993, credentials())).rejects.toBeInstanceOf(ProviderTransientError);
  });

  it("12. empty mailbox with no cursor: nothing imported, cursor at UID 0", async () => {
    const user = uniqueUser("empty");
    const pool = new ImapConnectionPool<ImapClient>();
    const adapter = createImapSyncAdapter({ pool, connect: createImapConnector({ resolver: answer(TEST_IP) }) });
    const changes = await adapter.listNewMessageIds(contextFor(accountFor(user), user), { maxMessages: 200 });
    expect(changes.messageIds).toEqual([]);
    expect(changes.nextCursor).toMatch(/^imap:v1:[1-9][0-9]*:0$/);
    await pool.closeAll();
  });

  it("8. cursor: no history imported, new messages after the cursor, 200 per run, UIDVALIDITY change -> historyGap", async () => {
    const user = "cursor-" + randomBytes(4).toString("hex") + "@emailbot-e2-integration.com";
    const setup = await setupClient(user);
    for (let n = 1; n <= 3; n++) await setup.append("INBOX", simple(n));
    const pool = new ImapConnectionPool<ImapClient>();
    const adapter = createImapSyncAdapter({ pool, connect: createImapConnector({ resolver: answer(TEST_IP) }) });
    const account = accountFor(user);

    // First run: only the position (3 old messages are NOT imported).
    const first = await adapter.listNewMessageIds(contextFor(account, user), { maxMessages: 200 });
    expect(first.messageIds).toEqual([]);
    const uidValidity = (first.nextCursor as string).split(":")[2];
    expect(first.nextCursor).toBe(`imap:v1:${uidValidity}:3`);
    account.syncCursor = first.nextCursor;

    for (let n = 4; n <= 208; n++) await setup.append("INBOX", simple(n));
    const batch = await adapter.listNewMessageIds(contextFor(account, user), { maxMessages: 200 });
    expect(batch.messageIds).toHaveLength(200);
    expect(batch.messageIds[0]).toBe(`${uidValidity}:4`);
    expect(batch).toMatchObject({ hasMore: true, nextCursor: `imap:v1:${uidValidity}:203` });
    account.syncCursor = batch.nextCursor;
    const rest = await adapter.listNewMessageIds(contextFor(account, user), { maxMessages: 200 });
    expect(rest.messageIds).toHaveLength(5);
    expect(rest).toMatchObject({ hasMore: false, nextCursor: `imap:v1:${uidValidity}:208` });
    await setup.logout();
    await pool.closeAll();

    // UIDVALIDITY changed on the server (doveadm): the stored cursor means nothing any more.
    script("uidvalidity", String(Number(uidValidity) + 1000), user);
    const pool2 = new ImapConnectionPool<ImapClient>();
    const adapter2 = createImapSyncAdapter({ pool: pool2, connect: createImapConnector({ resolver: answer(TEST_IP) }) });
    account.syncCursor = rest.nextCursor;
    expect(await adapter2.listNewMessageIds(contextFor(account, user))).toEqual({ messageIds: [], nextCursor: null, historyGap: true });
    const recovery = await adapter2.recoverMessageIds?.(contextFor(account, user), { since: new Date(Date.now() - 24 * 3600 * 1000), maxMessages: 300 });
    expect(recovery?.nextCursor).toBe(`imap:v1:${Number(uidValidity) + 1000}:208`);
    expect(recovery?.messageIds.length).toBeLessThanOrEqual(300);
    await pool2.closeAll();
  });

  it("10 + 11a + 14. MIME (text, HTML, alternative, attachments), malformed message, nothing marked \\Seen", async () => {
    const user = uniqueUser("mime");
    const setup = await setupClient(user);
    const pdf = Buffer.from("%PDF-1.4 integration").toString("base64");
    await setup.append("INBOX", crlf(`From: shop@store.example
To: me@empresa-correo.com
Subject: Factura
Message-ID: <mime-1@store.example>
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="mix"

--mix
Content-Type: multipart/alternative; boundary="alt"

--alt
Content-Type: text/plain; charset=utf-8

Total 10 soles
--alt
Content-Type: text/html; charset=utf-8

<p>Total <b>10 soles</b></p>
--alt--
--mix
Content-Type: application/pdf
Content-Disposition: attachment; filename="factura.pdf"
Content-Transfer-Encoding: base64

${pdf}
--mix--
`));
    await setup.append("INBOX", Buffer.concat([Buffer.from("Subject: broken\r\nContent-Type: multipart/mixed; boundary=\"b\"\r\n\r\n"), randomBytes(2048)]));
    const pool = new ImapConnectionPool<ImapClient>();
    const adapter = createImapSyncAdapter({ pool, connect: createImapConnector({ resolver: answer(TEST_IP) }) });
    const account = accountFor(user, { syncCursor: null });
    const position = await adapter.listNewMessageIds(contextFor(account, user));
    const uidValidity = (position.nextCursor as string).split(":")[2];

    const email = await adapter.fetchMessage(contextFor(account, user), `${uidValidity}:1`);
    expect(email).toMatchObject({ provider: "IMAP", subject: "Factura", internetMessageId: "<mime-1@store.example>" });
    expect(email.textBody).toContain("Total 10 soles");
    expect(email.htmlBody).toContain("<b>10 soles</b>");
    expect(email.attachments).toEqual([expect.objectContaining({ providerAttachmentId: "part-0", filename: "factura.pdf", contentType: "application/pdf", isInline: false })]);
    expect(Buffer.from(await adapter.downloadAttachment(contextFor(account, user), `${uidValidity}:1`, "part-0")).toString()).toBe("%PDF-1.4 integration");

    const broken = await adapter.fetchMessage(contextFor(account, user), `${uidValidity}:2`);
    expect(broken.provider).toBe("IMAP");
    expect(broken.subject).toBe("broken");

    const lock = await setup.getMailboxLock("INBOX", { readOnly: true });
    const flags = await setup.fetchAll("1:*", { uid: true, flags: true });
    lock.release();
    expect(flags.map((message) => [...message.flags])).toEqual([[], []]);
    await setup.logout();
    await pool.closeAll();
  });

  it("13. pool: at most 2 connections per mailbox under load, idle ones closed, all closed at shutdown", async () => {
    const user = uniqueUser("pool");
    const setup = await setupClient(user);
    for (let n = 1; n <= 6; n++) await setup.append("INBOX", simple(n));
    await setup.logout();
    resetObservations();
    const pool = new ImapConnectionPool<ImapClient>({ idleMs: 300 });
    const adapter = createImapSyncAdapter({ pool, connect: createImapConnector({ resolver: answer(TEST_IP) }) });
    const account = accountFor(user, { syncCursor: null });
    const position = await adapter.listNewMessageIds(contextFor(account, user));
    const uidValidity = (position.nextCursor as string).split(":")[2];
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, pool.stats().open + pool.stats().opening)), 1);
    await Promise.all([1, 2, 3, 4, 5, 6].map((uid) => adapter.fetchMessage(contextFor(account, user), `${uidValidity}:${uid}`)));
    clearInterval(watch);
    expect(peak).toBeLessThanOrEqual(2);
    expect(dialed.length).toBeLessThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(pool.stats().open).toBe(0);
    await adapter.listNewMessageIds(contextFor(account, user));
    expect(pool.stats().open).toBe(1);
    await pool.closeAll();
    expect(pool.stats().open).toBe(0);
  });

  it("9. real pipeline: rules, bot, customer and delivery; a failed run and a restart duplicate nothing", async () => {
    const user = uniqueUser("pipeline");
    const setup = await setupClient(user);
    const pool = new ImapConnectionPool<ImapClient>();
    const adapter = createImapSyncAdapter({ pool, connect: createImapConnector({ resolver: answer(TEST_IP) }) });
    const account = accountFor(user, { syncCursor: null });
    const position = await adapter.listNewMessageIds(contextFor(account, user));
    account.syncCursor = position.nextCursor;
    for (let n = 1; n <= 3; n++) await setup.append("INBOX", simple(n));
    await setup.logout();

    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow({ id: "codes", bot_id: "bot-codes", bot: { status: "ACTIVE" } })];
    const routing = new MemoryRoutingStore(emails);
    routing.addBot("bot-codes", { source: "RECIPIENT", onMultipleMatches: "LEAVE_UNASSIGNED" });
    // The test messages are addressed to me@empresa-correo.com (resolution by RECIPIENT).
    routing.addCustomer("juan", { normalizedValue: "me@empresa-correo.com" }, { bots: ["bot-codes"] });
    const accounts = makeAccountStore([account]);
    const providers = { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: adapter };
    const processDeps: ProcessEmailDeps = {
      accounts,
      emails,
      routing,
      audit: makeAudit(),
      storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers,
      createContext: (acc) => contextFor(acc, user),
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1000,
      logger: silentLogger,
      storageRetryDelayMs: 0,
      imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS
    };
    const outcomes: string[] = [];
    let crashOnce = true;
    const deps: HandleEventDeps = {
      accounts,
      emails,
      producer: makeProducer(),
      providers,
      createContext: (acc) => contextFor(acc, user),
      enqueueSync: vi.fn(async () => undefined),
      processMessage: async (job: EmailProcessingJob) => {
        // The worker dies while the 2nd message is being processed (the 1st one is already stored).
        if (crashOnce && job.providerMessageId.endsWith(":2")) {
          crashOnce = false;
          throw new ProviderTransientError("worker restarted", null);
        }
        const outcome = await processEmail(job, processDeps);
        outcomes.push(`${job.providerMessageId}:${outcome.status}${"reason" in outcome ? ":" + outcome.reason : ""}`);
        return outcome;
      },
      lock: { acquire: vi.fn(async () => "token"), release: vi.fn(async () => undefined) },
      logger: silentLogger,
      imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS
    };
    const start = account.syncCursor;
    const startUid = Number(String(start).split(":")[3]);
    await expect(syncAccount(account, deps, "POLL")).rejects.toBeInstanceOf(ProviderTransientError);
    // Never advanced past an unprocessed message. A2: it moves past the contiguous prefix only, i.e. exactly to
    // message 1 (stored), never to message 2 (failed) or 3.
    expect(account.syncCursor).toBe(String(start).replace(/:\d+$/, `:${startUid + 1}`));
    const result = await syncAccount(account, deps, "POLL");
    expect(result.cursorAdvanced).toBe(true);
    expect(emails.rows, outcomes.join(" ")).toHaveLength(3);
    expect(routing.deliveries).toHaveLength(3);
    // Restart from the old cursor (lost write / replay): nothing is stored or delivered twice.
    account.syncCursor = start;
    await syncAccount(account, deps, "POLL");
    expect(emails.rows).toHaveLength(3);
    expect(routing.deliveries).toHaveLength(3);
    await pool.closeAll();
  });

  it("15. M1: paused mid-batch keeps the cursor; the resume imports the rest exactly once; mail older than 7 days is not imported", async () => {
    const user = uniqueUser("m1");
    const setup = await setupClient(user);
    const pool = new ImapConnectionPool<ImapClient>();
    const adapter = createImapSyncAdapter({ pool, connect: createImapConnector({ resolver: answer(TEST_IP) }) });
    const account = accountFor(user, { syncCursor: null });
    const position = await adapter.listNewMessageIds(contextFor(account, user));
    account.syncCursor = position.nextCursor;
    const start = account.syncCursor;
    // Real INTERNALDATE through APPEND: two messages received 10 days ago, interleaved with six new ones.
    const appendAt = setup.append as unknown as (path: string, content: Buffer, flags: string[], date: Date) => Promise<unknown>;
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await appendAt.call(setup, "INBOX", simple(100), [], old);
    for (let n = 1; n <= 6; n++) await setup.append("INBOX", simple(n));
    await appendAt.call(setup, "INBOX", simple(101), [], old);
    await setup.logout();

    const emails = new MemoryEmailStore();
    emails.rules = [makeRuleRow()];
    const accounts = makeAccountStore([account]);
    const providers = { GMAIL: makeAdapter(), MICROSOFT: makeAdapter(), IMAP: adapter };
    const processDeps: ProcessEmailDeps = {
      accounts,
      emails,
      routing: new MemoryRoutingStore(emails),
      audit: makeAudit(),
      storage: { upload: vi.fn(async () => undefined), exists: vi.fn(async () => false) },
      realtime: makeRealtime(),
      producer: makeProducer(),
      providers,
      createContext: (acc) => contextFor(acc, user),
      attachmentsBucket: "email-attachments",
      maxAttachmentBytes: 1000,
      logger: silentLogger,
      storageRetryDelayMs: 0,
      imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS
    };
    let stored = 0;
    const deps: HandleEventDeps = {
      accounts,
      emails,
      producer: makeProducer(),
      providers,
      createContext: (acc) => contextFor(acc, user),
      enqueueSync: vi.fn(async () => undefined),
      processMessage: async (job: EmailProcessingJob) => {
        const outcome = await processEmail(job, processDeps);
        // The user pauses the mailbox while the batch runs (after the 2nd stored message).
        if (outcome.status === "processed" && ++stored === 2) account.status = "PAUSED";
        return outcome;
      },
      lock: { acquire: vi.fn(async () => "token"), release: vi.fn(async () => undefined) },
      audit: makeAudit(),
      logger: silentLogger,
      imapSyncEnabled: true, imapOrganizationIds: IMAP_TEST_ORGANIZATION_IDS
    };

    const first = await syncAccount(account, deps, "POLL");
    expect(first.cursorAdvanced).toBe(false);
    expect(account.syncCursor).toBe(start); // nothing pending was skipped
    expect(emails.rows.length).toBeLessThan(6);

    account.status = "ACTIVE";
    const second = await syncAccount(account, deps, "POLL");
    expect(second.cursorAdvanced).toBe(true);
    const subjects = emails.rows.map((row) => String(row.subject)).sort();
    expect(subjects).toEqual([1, 2, 3, 4, 5, 6].map((n) => `Tu código temporal ${n}`).sort());
    expect(new Set(emails.rows.map((row) => row.provider_message_id)).size).toBe(6); // no duplicates

    // BODY.PEEK / EXAMINE only: nothing marked \Seen on the real server.
    const check = await setupClient(user);
    const lock = await check.getMailboxLock("INBOX", { readOnly: true });
    const flags = await check.fetchAll("1:*", { uid: true, flags: true });
    lock.release();
    await check.logout();
    expect(flags).toHaveLength(8);
    expect(flags.every((message) => !message.flags.has("\\Seen"))).toBe(true);
    await pool.closeAll();
  });
});

/* ================================================================ *
 * Scenario B: untrusted (self-signed) certificate
 * ================================================================ */

describe.runIf(run("B"))("B - untrusted certificate", () => {
  it("2. TLS on 993: refused (even with the test CA trusted), no login sent", async () => {
    const error = await createImapConnector({ resolver: answer(TEST_IP) })(TLS_993, credentials()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSecurityError);
    expect((error as ProviderSecurityError).code).toBe("IMAP_TLS_FAILED");
    expect(dialed).toEqual([{ host: TEST_IP, port: 993 }]);
  });

  it("2. STARTTLS on 143 with the untrusted certificate: refused; the password never travels in clear", async () => {
    const error = await createImapConnector({ resolver: answer(TEST_IP) })(STARTTLS_143, credentials()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSecurityError);
    expect((error as ProviderSecurityError).code).toBe("IMAP_TLS_FAILED");
    const plain = plaintextWrites.join("");
    expect(plain).not.toContain(PASSWORD);
    expect(plain).not.toMatch(/\bLOGIN\b|AUTHENTICATE/);
  });
});

/* ================================================================ *
 * Scenario C: server without STARTTLS (would accept a plaintext login)
 * ================================================================ */

describe.runIf(run("C"))("C - no STARTTLS", () => {
  it("4. STARTTLS is mandatory: refused, and NO credential is written on the plaintext socket", async () => {
    const error = await createImapConnector({ resolver: answer(TEST_IP) })(STARTTLS_143, credentials()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSecurityError);
    expect((error as ProviderSecurityError).code).toBe("IMAP_STARTTLS_UNAVAILABLE");
    expect(dialed).toEqual([{ host: TEST_IP, port: 143 }]);
    const plain = plaintextWrites.join("");
    expect(plain).not.toContain(PASSWORD);
    expect(plain).not.toContain("tester@emailbot-e2-integration.com");
    expect(plain).not.toMatch(/\bLOGIN\b|AUTHENTICATE/);
  });
});
