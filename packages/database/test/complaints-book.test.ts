import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../src/harness.js";
import { one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Libro de Reclamaciones (migration 20261007170000_complaints_book.sql):
 * public.submit_complaint_book_entry (service_role, the API's public form) with an
 * atomic correlative number and an idempotent submission id; the state of the
 * consumer's copy e-mail (claim / record, one sender at a time); answers by platform
 * admins as operations with a fixed key, date and text (RESPONDED only when the
 * provider accepted the e-mail) with audit rows; e-mail outcomes SENT / REJECTED /
 * UNKNOWN (unknown = same key and same content on the next attempt); no direct
 * table access for anyone.
 */

let t: TestDatabase;
let f: Fixtures;
let platformAdmin: string;
let otherAdmin: string;

interface Receipt {
  id: string;
  number: string | number;
  code: string;
  kind: string;
  created_at: string;
  confirmation_email_status: string;
  replayed: boolean;
}

const VALID = {
  submissionId: "" as string,
  kind: "RECLAMO",
  firstNames: "Ana María",
  lastNames: "Quispe Rojas",
  documentType: "DNI",
  documentNumber: "45678912",
  email: "Ana.Quispe@Example.com",
  phone: "987654321",
  address: "Av. Siempre Viva 123, Lima",
  isMinor: false,
  guardianName: null as string | null,
  goodType: "SERVICIO",
  goodDescription: "Plan Pro mensual",
  claimedAmountCents: 3990 as number | null,
  detail: "Se realizó un cobro que no reconozco en mi tarjeta.",
  request: "Solicito la revisión del cobro.",
  requestId: "req-1"
};

const submit = (overrides: Partial<typeof VALID> = {}) => {
  const v = { ...VALID, submissionId: randomUUID(), ...overrides };
  return t.asService((tx) =>
    one<Receipt>(
      tx,
      "select * from public.submit_complaint_book_entry($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)",
      [v.submissionId, v.kind, v.firstNames, v.lastNames, v.documentType, v.documentNumber, v.email, v.phone, v.address, v.isMinor, v.guardianName, v.goodType, v.goodDescription, v.claimedAmountCents, v.detail, v.request, v.requestId]
    )
  );
};

type Outcome = "SENT" | "REJECTED" | "UNKNOWN";

const row = (id: string) => t.asAdmin((tx) => one<Record<string, unknown>>(tx, "select * from public.complaint_book_entries where id = $1", [id]));
const auditFor = (id: string) =>
  t.asAdmin(async (tx) => (await tx.query<Record<string, unknown>>("select * from public.platform_audit_logs where target_id = $1 order by created_at, id", [id])).rows);
/** Simulates the passage of time: the current claim (and optionally the answer operation) becomes old. */
const age = (id: string, columns: string[], interval: string) =>
  t.asAdmin((tx) => tx.query(`update public.complaint_book_entries set ${columns.map((c) => `${c} = ${c} - interval '${interval}'`).join(", ")} where id = $1`, [id]));

const list = (actorId: string, limit = 50, offset = 0) =>
  t.asService(async (tx) => (await tx.query<Record<string, unknown>>("select * from admin.list_complaint_book_entries($1, $2, $3)", [actorId, limit, offset])).rows);

const claim = (id: string) =>
  t.asService(async (tx) => (await tx.query<Record<string, unknown>>("select * from public.claim_complaint_confirmation_email($1)", [id])).rows);
const record = (id: string, outcome: Outcome, providerId: string | null, error: string | null) =>
  t.asService((tx) => one<{ status: string | null }>(tx, "select public.record_complaint_confirmation_email($1, $2, $3, $4) as status", [id, outcome, providerId, error]));

const begin = (actor: string, id: string, text: string) =>
  t.asService(async (tx) => (await tx.query<Record<string, unknown>>("select * from admin.begin_complaint_response($1, $2, $3)", [actor, id, text])).rows);
const recordResponse = (actor: string, id: string, outcome: Outcome, providerId: string | null, error: string | null) =>
  t.asService(async (tx) => (await tx.query<Record<string, unknown>>("select * from admin.record_complaint_response($1, $2, $3, $4, $5, 'req-r')", [actor, id, outcome, providerId, error])).rows);

const ANSWER = "Revisamos tu caso y procederemos con la devolución del cobro duplicado.";

beforeAll(async () => {
  t = await createTestDatabase({ defaultPrivileges: "production" });
  f = await seedTwoTenants(t);
  platformAdmin = await t.createUser("root@emailbot.test");
  otherAdmin = await t.createUser("ops@emailbot.test");
  await t.asAdmin((tx) => tx.query("insert into public.platform_admins (user_id) values ($1), ($2)", [platformAdmin, otherAdmin]));
});
afterAll(async () => t?.close());

describe("submission", () => {
  it("stores the sheet and returns its correlative code (LR-<year>-<6 digits>), PENDING with its copy still to send", async () => {
    const receipt = await submit();
    expect(receipt.kind).toBe("RECLAMO");
    expect(receipt.code).toMatch(/^LR-\d{4}-\d{6}$/);
    expect(receipt.code.endsWith(String(receipt.number).padStart(6, "0"))).toBe(true);
    expect(receipt).toMatchObject({ confirmation_email_status: "PENDING", replayed: false });
    expect(await row(receipt.id)).toMatchObject({
      email: "ana.quispe@example.com",
      status: "PENDING",
      document_number: "45678912",
      is_minor: false,
      guardian_name: null,
      confirmation_email_status: "PENDING"
    });
  });

  it("QUEJA is accepted; a minor needs a parent or guardian", async () => {
    expect((await submit({ kind: "QUEJA", claimedAmountCents: null })).kind).toBe("QUEJA");
    await expect(submit({ isMinor: true, guardianName: null })).rejects.toThrow(/guardian/);
    expect((await submit({ isMinor: true, guardianName: "Rosa Rojas" })).code).toMatch(/^LR-/);
  });

  it.each([
    ["unknown kind", { kind: "SUGERENCIA" }, /kind/],
    ["unknown document type", { documentType: "LICENCIA" }, /document type/],
    ["unknown good type", { goodType: "OTRO" }, /good type/],
    ["invalid email", { email: "no-es-correo" }, /email/],
    ["detail too short", { detail: "corto" }, /complaint_book_entries_lengths/],
    ["detail too long", { detail: "x".repeat(5001) }, /complaint_book_entries_lengths/],
    ["negative amount", { claimedAmountCents: -1 }, /complaint_book_entries_amount/]
  ])("rejects %s (nothing stored)", async (_label, overrides, error) => {
    const before = await t.asAdmin((tx) => one<{ n: number }>(tx, "select count(*)::int as n from public.complaint_book_entries"));
    await expect(submit(overrides as Partial<typeof VALID>)).rejects.toThrow(error);
    const after = await t.asAdmin((tx) => one<{ n: number }>(tx, "select count(*)::int as n from public.complaint_book_entries"));
    expect(after.n).toBe(before.n);
  });

  it("numbers never repeat (sequence; 20 submissions started together)", async () => {
    const receipts = await Promise.all(Array.from({ length: 20 }, (_, index) => submit({ requestId: `burst-${index}` })));
    const numbers = receipts.map((r) => Number(r.number));
    expect(new Set(numbers).size).toBe(20);
    expect(new Set(receipts.map((r) => r.code)).size).toBe(20);
    const all = await t.asAdmin(async (tx) => (await tx.query<{ number: number }>("select number from public.complaint_book_entries")).rows.map((r) => Number(r.number)));
    expect(new Set(all).size).toBe(all.length);
  });

  it("a retried submission id returns the same sheet (no second number); another e-mail cannot reuse it", async () => {
    const submissionId = randomUUID();
    const first = await submit({ submissionId });
    const again = await submit({ submissionId, email: "ana.quispe@example.com " });
    expect(again).toMatchObject({ id: first.id, code: first.code, replayed: true });
    expect(Number(again.number)).toBe(Number(first.number));
    const count = await t.asAdmin((tx) => one<{ n: number }>(tx, "select count(*)::int as n from public.complaint_book_entries where submission_id = $1", [submissionId]));
    expect(count.n).toBe(1);
    await expect(submit({ submissionId, email: "otra@example.com" })).rejects.toThrow(/already registered/);
    await expect(submit({ submissionId: null as unknown as string })).rejects.toThrow(/submission id/);
  });
});

describe("consumer's copy e-mail", () => {
  it("one claim at a time returns the whole sheet; SENT is final", async () => {
    const receipt = await submit();
    const [claimed] = await claim(receipt.id);
    expect(claimed).toMatchObject({ id: receipt.id, code: receipt.code, email: "ana.quispe@example.com", document_number: "45678912", detail: VALID.detail });
    expect(claimed!.idempotency_key).toBe(`complaint-confirmation/${receipt.id}/1`);
    // Another sender (a retried request) gets nothing while the first one sends.
    expect(await claim(receipt.id)).toHaveLength(0);

    expect((await record(receipt.id, "SENT", "re_123", null)).status).toBe("SENT");
    expect(await row(receipt.id)).toMatchObject({ confirmation_email_status: "SENT", confirmation_email_provider_id: "re_123", confirmation_email_error: null });
    expect(await claim(receipt.id)).toHaveLength(0);
    // Recording again is a no-op.
    expect((await record(receipt.id, "REJECTED", null, "PROVIDER_REJECTED")).status).toBeNull();
    expect((await row(receipt.id)).confirmation_email_status).toBe("SENT");
  });

  it("a confirmed rejection keeps the sheet, stores only an error code, and can be retried with a new idempotency key", async () => {
    const receipt = await submit();
    await claim(receipt.id);
    expect((await record(receipt.id, "REJECTED", null, "PROVIDER_REJECTED")).status).toBe("FAILED");
    expect(await row(receipt.id)).toMatchObject({ code: receipt.code, status: "PENDING", confirmation_email_status: "FAILED", confirmation_email_error: "PROVIDER_REJECTED", confirmation_email_failures: 1 });
    const [retry] = await claim(receipt.id);
    expect(retry!.idempotency_key).toBe(`complaint-confirmation/${receipt.id}/2`);
    // Free text never lands in the error column.
    expect((await record(receipt.id, "REJECTED", null, "smtp said: ana.quispe@example.com bounced")).status).toBe("FAILED");
    expect((await row(receipt.id)).confirmation_email_error).toBe("UNKNOWN");
  });

  it("an UNKNOWN outcome (timeout, network, 5xx, 409) keeps the claim and the key: retried later with the same key", async () => {
    const receipt = await submit();
    const [first] = await claim(receipt.id);
    expect((await record(receipt.id, "UNKNOWN", null, "PROVIDER_TIMEOUT")).status).toBe("UNKNOWN");
    expect(await row(receipt.id)).toMatchObject({ confirmation_email_status: "SENDING", confirmation_email_error: "PROVIDER_TIMEOUT", confirmation_email_failures: 0 });
    // The claim is still there: no new attempt until it expires.
    expect(await claim(receipt.id)).toHaveLength(0);
    await age(receipt.id, ["confirmation_email_claimed_at"], "3 minutes");
    const [again] = await claim(receipt.id);
    expect(again!.idempotency_key).toBe(first!.idempotency_key);
    expect(again).toEqual(first);
    expect((await row(receipt.id)).confirmation_email_error).toBeNull();
  });

  it("a crashed sender's claim can be taken again after 2 minutes, with the same key", async () => {
    const receipt = await submit();
    await claim(receipt.id);
    await age(receipt.id, ["confirmation_email_claimed_at"], "3 minutes");
    const [again] = await claim(receipt.id);
    expect(again!.idempotency_key).toBe(`complaint-confirmation/${receipt.id}/1`);
  });

  it("past the 23 h window an unknown copy is never claimed automatically; an admin forces it (new key, audited) or confirms it", async () => {
    const receipt = await submit();
    const [first] = await claim(receipt.id);
    await record(receipt.id, "UNKNOWN", null, "PROVIDER_TIMEOUT");
    await age(receipt.id, ["confirmation_email_claimed_at", "confirmation_email_key_used_at"], "23 hours 1 minute");

    // Public path (a retried submission) and an admin without force: nothing.
    expect(await claim(receipt.id)).toHaveLength(0);
    const adminClaim = (force: boolean) =>
      t.asService(async (tx) => (await tx.query<Record<string, unknown>>("select * from admin.claim_complaint_confirmation_email($1, $2, $3)", [platformAdmin, receipt.id, force])).rows);
    expect(await adminClaim(false)).toHaveLength(0);
    const [listed] = (await list(platformAdmin, 101)).filter((entry) => entry.id === receipt.id);
    expect(listed).toMatchObject({ confirmation_email_status: "SENDING", confirmation_decision_required: true });

    // Forced: a new attempt with a new key, audited.
    const [forced] = await adminClaim(true);
    expect(forced!.idempotency_key).toBe(`complaint-confirmation/${receipt.id}/2`);
    expect(forced!.idempotency_key).not.toBe(first!.idempotency_key);
    expect((await auditFor(receipt.id)).map((entry) => entry.action)).toEqual(["complaint_book.confirmation_resend_forced"]);
    expect((await auditFor(receipt.id))[0]).toMatchObject({ actor_user_id: platformAdmin, metadata: { code: receipt.code, previousAttempt: 1 } });
  });

  it("an admin records an uncertain copy as sent with the provider id (audited); never while a sender is on it", async () => {
    const receipt = await submit();
    await claim(receipt.id);
    const confirm = (id: string) =>
      t.asService((tx) => one<{ outcome: string }>(tx, "select admin.confirm_complaint_confirmation_email($1, $2, $3, 'req-c') as outcome", [platformAdmin, receipt.id, id]));
    // The claim is fresh: someone is sending it right now.
    expect((await confirm("0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e")).outcome).toBe("NOT_UNCERTAIN");
    await record(receipt.id, "UNKNOWN", null, "PROVIDER_NETWORK");
    await age(receipt.id, ["confirmation_email_claimed_at"], "3 minutes");
    await expect(confirm("bad id!")).rejects.toThrow(/Invalid provider message id/);
    expect((await confirm("0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e")).outcome).toBe("CONFIRMED");
    expect(await row(receipt.id)).toMatchObject({ confirmation_email_status: "SENT", confirmation_email_provider_id: "0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e", confirmation_email_error: null });
    expect((await auditFor(receipt.id))[0]).toMatchObject({ action: "complaint_book.confirmation_confirmed_manually", metadata: { code: receipt.code, result: "SENT" } });
    expect(await claim(receipt.id)).toHaveLength(0);
    expect((await confirm("0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e")).outcome).toBe("NOT_UNCERTAIN");
    await expect(
      t.asService((tx) => tx.query("select admin.confirm_complaint_confirmation_email($1, $2, 'x1234567', null)", [f.a.ownerId, receipt.id]))
    ).rejects.toThrow(/Platform administrator access required/);
  });

  it("an invalid outcome is refused", async () => {
    const receipt = await submit();
    await claim(receipt.id);
    await expect(record(receipt.id, "MAYBE" as Outcome, null, null)).rejects.toThrow(/Invalid e-mail outcome/);
  });

  it("admins resend the copy (audited, uncertain outcomes too); members cannot", async () => {
    const receipt = await submit();
    await claim(receipt.id);
    await record(receipt.id, "REJECTED", null, "PROVIDER_REJECTED");

    await expect(t.asService((tx) => tx.query("select * from admin.claim_complaint_confirmation_email($1, $2)", [f.a.ownerId, receipt.id]))).rejects.toThrow(
      /Platform administrator access required/
    );
    const adminRecord = (outcome: Outcome, providerId: string | null, error: string | null, requestId: string) =>
      t.asService((tx) =>
        one<{ status: string }>(tx, "select admin.record_complaint_confirmation_email($1, $2, $3, $4, $5, $6) as status", [platformAdmin, receipt.id, outcome, providerId, error, requestId])
      );

    expect(await t.asService(async (tx) => (await tx.query("select * from admin.claim_complaint_confirmation_email($1, $2)", [platformAdmin, receipt.id])).rows)).toHaveLength(1);
    expect((await adminRecord("UNKNOWN", null, "PROVIDER_UNAVAILABLE", "req-u")).status).toBe("UNKNOWN");
    await age(receipt.id, ["confirmation_email_claimed_at"], "3 minutes");
    expect(await t.asService(async (tx) => (await tx.query("select * from admin.claim_complaint_confirmation_email($1, $2)", [platformAdmin, receipt.id])).rows)).toHaveLength(1);
    expect((await adminRecord("SENT", "re_456", null, "req-x")).status).toBe("SENT");

    const audit = await auditFor(receipt.id);
    expect(audit.map((entry) => entry.action)).toEqual(["complaint_book.confirmation_uncertain", "complaint_book.confirmation_resent"]);
    expect(audit[0]).toMatchObject({ metadata: { code: receipt.code, result: "UNKNOWN", errorCode: "PROVIDER_UNAVAILABLE" } });
    expect(audit[1]).toMatchObject({
      actor_user_id: platformAdmin,
      target_type: "complaint_book_entry",
      request_id: "req-x",
      metadata: { code: receipt.code, result: "SENT", providerMessageId: "re_456" }
    });
    expect(JSON.stringify(audit)).not.toContain("ana.quispe");
  });
});

describe("answers by platform administrators", () => {
  it("RESPONDED only after the provider accepted the e-mail; the date is the one fixed for the operation; who is recorded and audited", async () => {
    const receipt = await submit();
    const [ready] = await begin(platformAdmin, receipt.id, `  ${ANSWER}  `);
    expect(ready).toMatchObject({ outcome: "READY", id: receipt.id, code: receipt.code, email: "ana.quispe@example.com", kind: "RECLAMO", response: ANSWER });
    expect(ready!.idempotency_key).toBe(`complaint-response/${receipt.id}/1`);
    expect(ready!.prepared_at).not.toBeNull();
    expect(await row(receipt.id)).toMatchObject({ status: "PENDING", provider_response: ANSWER, response_email_status: "SENDING", responded_at: null, response_operations: 1 });

    // A second administrator cannot answer at the same time.
    expect((await begin(otherAdmin, receipt.id, ANSWER))[0]).toMatchObject({ outcome: "IN_PROGRESS", id: null });

    const [result] = await recordResponse(platformAdmin, receipt.id, "SENT", "re_789", null);
    expect(result).toMatchObject({ status: "RESPONDED", response_email_status: "SENT" });
    expect(new Date(String(result!.responded_at)).toISOString()).toBe(new Date(String(ready!.prepared_at)).toISOString());
    expect(await row(receipt.id)).toMatchObject({ status: "RESPONDED", responded_by: platformAdmin, response_email_provider_id: "re_789" });

    const audit = await auditFor(receipt.id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: platformAdmin,
      action: "complaint_book.response_sent",
      target_type: "complaint_book_entry",
      request_id: "req-r",
      metadata: { code: receipt.code, result: "SENT", providerMessageId: "re_789" }
    });
    // The audit never carries the answer or the consumer's data.
    expect(JSON.stringify(audit)).not.toContain("devolución");
    expect(JSON.stringify(audit)).not.toContain("ana.quispe");

    expect((await begin(platformAdmin, receipt.id, ANSWER))[0]).toMatchObject({ outcome: "ALREADY_RESPONDED" });
    const [listed] = (await list(platformAdmin, 101)).filter((entry) => entry.id === receipt.id);
    expect(listed).toMatchObject({ status: "RESPONDED", provider_response: ANSWER, response_email_status: "SENT", responded_by_email: "root@emailbot.test" });
  });

  it("a confirmed rejection leaves the case PENDING (audited) and a new operation starts with a new key and date", async () => {
    const receipt = await submit();
    const [first] = await begin(platformAdmin, receipt.id, ANSWER);
    const [failed] = await recordResponse(platformAdmin, receipt.id, "REJECTED", null, "PROVIDER_REJECTED");
    expect(failed).toMatchObject({ status: "PENDING", response_email_status: "FAILED", responded_at: null });
    expect(await row(receipt.id)).toMatchObject({ status: "PENDING", responded_by: null, response_email_error: "PROVIDER_REJECTED", response_email_failures: 1 });
    expect((await auditFor(receipt.id))[0]).toMatchObject({ action: "complaint_book.response_failed", metadata: { code: receipt.code, result: "REJECTED", errorCode: "PROVIDER_REJECTED" } });

    // After a confirmed rejection another text may be sent: new operation.
    const [retry] = await begin(otherAdmin, receipt.id, `${ANSWER} Corregido.`);
    expect(retry).toMatchObject({ outcome: "READY", response: `${ANSWER} Corregido.` });
    expect(retry!.idempotency_key).toBe(`complaint-response/${receipt.id}/2`);
    expect(retry!.idempotency_key).not.toBe(first!.idempotency_key);
    expect((await recordResponse(otherAdmin, receipt.id, "SENT", "re_999", null))[0]).toMatchObject({ status: "RESPONDED" });
    expect((await row(receipt.id)).responded_by).toBe(otherAdmin);
    // Recording without a claim does nothing.
    expect(await recordResponse(otherAdmin, receipt.id, "REJECTED", null, "PROVIDER_REJECTED")).toHaveLength(0);
    expect((await row(receipt.id)).status).toBe("RESPONDED");
  });

  it("an UNKNOWN outcome keeps the operation: the claim expires and the retry reuses the same key, text and date", async () => {
    const receipt = await submit();
    const [first] = await begin(platformAdmin, receipt.id, ANSWER);
    const [uncertain] = await recordResponse(platformAdmin, receipt.id, "UNKNOWN", null, "PROVIDER_TIMEOUT");
    expect(uncertain).toMatchObject({ status: "PENDING", response_email_status: "SENDING", responded_at: null });
    expect(await row(receipt.id)).toMatchObject({ response_email_error: "PROVIDER_TIMEOUT", response_email_failures: 0, response_operations: 1 });
    expect((await auditFor(receipt.id))[0]).toMatchObject({ action: "complaint_book.response_uncertain", metadata: { result: "UNKNOWN", errorCode: "PROVIDER_TIMEOUT" } });

    // Until the claim expires nobody can try again.
    expect((await begin(otherAdmin, receipt.id, ANSWER))[0]).toMatchObject({ outcome: "IN_PROGRESS" });
    await age(receipt.id, ["response_email_claimed_at"], "3 minutes");
    // Another text could become a second answer: refused while the outcome is unknown.
    expect((await begin(otherAdmin, receipt.id, "Otra respuesta distinta al caso."))[0]).toMatchObject({ outcome: "TEXT_LOCKED", id: null });
    const [again] = await begin(otherAdmin, receipt.id, ANSWER);
    expect(again).toMatchObject({ outcome: "READY", response: ANSWER });
    expect(again!.idempotency_key).toBe(first!.idempotency_key);
    expect(new Date(String(again!.prepared_at)).toISOString()).toBe(new Date(String(first!.prepared_at)).toISOString());
    expect((await row(receipt.id)).response_email_error).toBeNull();
  });

  it("a crashed sender (nothing recorded) is retried as the same operation after the claim expires", async () => {
    const receipt = await submit();
    const [first] = await begin(platformAdmin, receipt.id, ANSWER);
    await age(receipt.id, ["response_email_claimed_at"], "3 minutes");
    const [again] = await begin(platformAdmin, receipt.id, ANSWER);
    expect(again).toMatchObject({ outcome: "READY", idempotency_key: first!.idempotency_key, response: ANSWER });
    expect(new Date(String(again!.prepared_at)).toISOString()).toBe(new Date(String(first!.prepared_at)).toISOString());
  });

  it("past the 23 h window an unknown answer is never resent automatically (same or other text): NEEDS_DECISION", async () => {
    const receipt = await submit();
    await begin(platformAdmin, receipt.id, ANSWER);
    await recordResponse(platformAdmin, receipt.id, "UNKNOWN", null, "PROVIDER_UNAVAILABLE");
    await age(receipt.id, ["response_email_claimed_at", "response_prepared_at"], "23 hours 1 minute");
    expect((await begin(platformAdmin, receipt.id, ANSWER))[0]).toMatchObject({ outcome: "NEEDS_DECISION", id: null });
    expect((await begin(otherAdmin, receipt.id, "Otra respuesta distinta al caso."))[0]).toMatchObject({ outcome: "NEEDS_DECISION" });
    expect(await row(receipt.id)).toMatchObject({ response_operations: 1, response_email_status: "SENDING" });
    const [listed] = (await list(platformAdmin, 101)).filter((entry) => entry.id === receipt.id);
    expect(listed).toMatchObject({ response_decision_required: true, status: "PENDING" });
  });

  it("just inside the window the same operation is still repeated (same key)", async () => {
    const receipt = await submit();
    const [first] = await begin(platformAdmin, receipt.id, ANSWER);
    await recordResponse(platformAdmin, receipt.id, "UNKNOWN", null, "PROVIDER_TIMEOUT");
    await age(receipt.id, ["response_email_claimed_at", "response_prepared_at"], "22 hours 59 minutes");
    expect((await begin(platformAdmin, receipt.id, ANSWER))[0]).toMatchObject({ outcome: "READY", idempotency_key: first!.idempotency_key });
  });

  it("an administrator may force a new operation past the window (new key and date, audited)", async () => {
    const receipt = await submit();
    const [first] = await begin(platformAdmin, receipt.id, ANSWER);
    await recordResponse(platformAdmin, receipt.id, "UNKNOWN", null, "PROVIDER_TIMEOUT");
    await age(receipt.id, ["response_email_claimed_at", "response_prepared_at"], "30 hours");
    const forceBegin = (text: string) =>
      t.asService(async (tx) => (await tx.query<Record<string, unknown>>("select * from admin.begin_complaint_response($1, $2, $3, true)", [otherAdmin, receipt.id, text])).rows);
    const [forced] = await forceBegin(`${ANSWER} Reenvío.`);
    expect(forced).toMatchObject({ outcome: "READY", idempotency_key: `complaint-response/${receipt.id}/2`, response: `${ANSWER} Reenvío.` });
    // The stored date of the first operation is now 30 h old; the forced one is a new date.
    expect(new Date(String(forced!.prepared_at)).getTime()).toBeGreaterThan(new Date(String(first!.prepared_at)).getTime() - 29 * 3600 * 1000);
    expect((await auditFor(receipt.id)).map((entry) => entry.action)).toEqual(["complaint_book.response_uncertain", "complaint_book.response_resend_forced"]);
    expect((await auditFor(receipt.id))[1]).toMatchObject({ actor_user_id: otherAdmin, metadata: { code: receipt.code, previousOperation: 1 } });
    // Force never bypasses a sender that is on it.
    expect((await forceBegin(ANSWER))[0]).toMatchObject({ outcome: "IN_PROGRESS" });
  });

  it("an administrator records an uncertain answer as sent with the provider id: RESPONDED, dated as printed, audited", async () => {
    const receipt = await submit();
    const [first] = await begin(platformAdmin, receipt.id, ANSWER);
    const confirm = (actor: string, id: string) =>
      t.asService(async (tx) => (await tx.query<Record<string, unknown>>("select * from admin.confirm_complaint_response($1, $2, $3, 'req-m')", [actor, receipt.id, id])).rows);
    // A sender is on it: no manual confirmation.
    expect((await confirm(platformAdmin, "0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e"))[0]).toMatchObject({ outcome: "NOT_UNCERTAIN" });
    await recordResponse(platformAdmin, receipt.id, "UNKNOWN", null, "PROVIDER_CONFLICT");
    await age(receipt.id, ["response_email_claimed_at"], "3 minutes");
    await expect(confirm(platformAdmin, "<script>")).rejects.toThrow(/Invalid provider message id/);
    await expect(confirm(f.a.ownerId, "0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e")).rejects.toThrow(/Platform administrator access required/);
    const [confirmed] = await confirm(otherAdmin, "0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e");
    expect(confirmed).toMatchObject({ outcome: "CONFIRMED", status: "RESPONDED" });
    expect(new Date(String(confirmed!.responded_at)).toISOString()).toBe(new Date(String(first!.prepared_at)).toISOString());
    expect(await row(receipt.id)).toMatchObject({ status: "RESPONDED", responded_by: otherAdmin, response_email_status: "SENT", response_email_provider_id: "0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e" });
    expect((await auditFor(receipt.id)).at(-1)).toMatchObject({ action: "complaint_book.response_confirmed_manually", request_id: "req-m", metadata: { result: "SENT" } });
    expect((await begin(platformAdmin, receipt.id, ANSWER))[0]).toMatchObject({ outcome: "ALREADY_RESPONDED" });
    expect((await confirm(otherAdmin, "0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e"))[0]).toMatchObject({ outcome: "NOT_UNCERTAIN" });
  });

  it("validates the answer, the outcome and the sheet", async () => {
    const receipt = await submit();
    await expect(begin(platformAdmin, receipt.id, "corta")).rejects.toThrow(/between 10 and 5000/);
    await expect(begin(platformAdmin, receipt.id, "x".repeat(5001))).rejects.toThrow(/between 10 and 5000/);
    expect((await begin(platformAdmin, randomUUID(), ANSWER))[0]).toMatchObject({ outcome: "NOT_FOUND" });
    expect((await row(receipt.id)).response_email_status).toBeNull();
    await begin(platformAdmin, receipt.id, ANSWER);
    await expect(recordResponse(platformAdmin, receipt.id, "MAYBE" as Outcome, null, null)).rejects.toThrow(/Invalid e-mail outcome/);
  });

  it("only platform administrators answer: members and other roles are refused", async () => {
    const receipt = await submit();
    await expect(begin(f.a.ownerId, receipt.id, ANSWER)).rejects.toThrow(/Platform administrator access required/);
    await expect(recordResponse(f.b.ownerId, receipt.id, "SENT", "re_x", null)).rejects.toThrow(/Platform administrator access required/);
    await expect(
      t.asUser(platformAdmin, (tx) => tx.query("select * from admin.begin_complaint_response($1, $2, $3)", [platformAdmin, receipt.id, ANSWER]))
    ).rejects.toThrow(/permission denied/);
    expect(await row(receipt.id)).toMatchObject({ status: "PENDING", provider_response: null });
  });
});

describe("access", () => {
  it("nobody reads or writes the table directly (anon, authenticated, service_role)", async () => {
    await expect(t.asAnon((tx) => tx.query("select * from public.complaint_book_entries"))).rejects.toThrow(/permission denied/);
    await expect(t.asUser(f.a.ownerId, (tx) => tx.query("select * from public.complaint_book_entries"))).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("select * from public.complaint_book_entries"))).rejects.toThrow(/permission denied/);
    await expect(
      t.asService((tx) => tx.query("insert into public.complaint_book_entries (number, code, kind) values (999, 'x', 'QUEJA')"))
    ).rejects.toThrow(/permission denied/);
    await expect(t.asService((tx) => tx.query("select nextval('public.complaint_book_number_seq')"))).rejects.toThrow(/permission denied/);
  });

  it("only service_role can submit or handle the copy e-mail (anon and members cannot call the functions)", async () => {
    const id = randomUUID();
    const calls: Array<[string, string]> = [
      [
        `select * from public.submit_complaint_book_entry('${id}','QUEJA','A','B','DNI','12345678','a@b.pe','987654321','Calle 1 123', false, null, 'SERVICIO','Plan','100','Detalle suficiente','Pedido claro', null)`,
        "submit_complaint_book_entry"
      ],
      [`select * from public.claim_complaint_confirmation_email('${id}')`, "claim_complaint_confirmation_email"],
      [`select public.record_complaint_confirmation_email('${id}', 'SENT', 're', null)`, "record_complaint_confirmation_email"],
      [`select private.claim_complaint_confirmation_email('${id}')`, "claim_complaint_confirmation_email"]
    ];
    for (const [sql, name] of calls) {
      await expect(t.asAnon((tx) => tx.query(sql))).rejects.toThrow(new RegExp(`permission denied for (function ${name}|schema private)`));
      await expect(t.asUser(f.a.ownerId, (tx) => tx.query(sql))).rejects.toThrow(new RegExp(`permission denied for (function ${name}|schema private)`));
    }
    await expect(t.asService((tx) => tx.query(`select private.claim_complaint_confirmation_email('${id}')`))).rejects.toThrow(/permission denied/);
  });

  it("platform admins list the sheets (newest first); anyone else is refused", async () => {
    const rows = await list(platformAdmin, 5);
    expect(rows.length).toBe(5);
    const numbers = rows.map((r) => Number(r.number));
    expect([...numbers].sort((a, b) => b - a)).toEqual(numbers);
    expect(rows[0]).toMatchObject({ good_type: "SERVICIO" });
    expect(rows[0]).toHaveProperty("confirmation_email_status");

    await expect(list(f.a.ownerId)).rejects.toThrow(/Platform administrator access required/);
    await expect(t.asUser(platformAdmin, (tx) => tx.query("select * from admin.list_complaint_book_entries($1, 5, 0)", [platformAdmin]))).rejects.toThrow(
      /permission denied/
    );
  });
});
