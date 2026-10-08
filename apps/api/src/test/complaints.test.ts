import { createHash, randomBytes } from "node:crypto";
import { HttpTimeoutError } from "@emailbot/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComplaintBookEntry } from "@emailbot/types";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/env.js";
import type { OutgoingEmail, TransactionalMailer } from "../deps.js";
import { createResendMailer } from "../infrastructure/resend-mailer.js";
import { complaintCopyEmail, complaintResponseEmail } from "../modules/complaints/emails.js";
import type { ComplaintCopy, ComplaintResponseTarget } from "../repositories/types.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

/*
 * Libro de Reclamaciones:
 * - POST /api/complaints-book (public, rate limited, validated server-side): the sheet is recorded first; the
 *   consumer's copy is e-mailed afterwards and never decides the answer.
 * - GET /api/admin/complaints-book, POST /api/admin/complaints-book/:id/response and
 *   /:id/confirmation-email (platform administrators only).
 * - The Resend client and its configuration.
 */

const owner = makeUser({ [ORG_A]: "OWNER" });
const otherOwner = makeUser({ [ORG_B]: "OWNER" });
const platformAdmin = makeUser({});

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";

const SHEET = {
  kind: "RECLAMO",
  firstNames: "Ana María",
  lastNames: "Quispe Rojas",
  documentType: "DNI",
  documentNumber: "45678912",
  email: "Ana.Quispe@Example.com",
  phone: "987654321",
  address: "Av. Siempre Viva 123, Lima",
  isMinor: false,
  guardianName: "",
  goodType: "SERVICIO",
  goodDescription: "Plan Pro mensual",
  claimedAmount: "39.90",
  detail: "Se realizó un cobro que no reconozco.",
  consumerRequest: "Solicito la revisión del cobro.",
  confirmTruth: true,
  website: ""
};

const SUBMITTED = {
  id: ENTRY_ID,
  code: "LR-2026-000001",
  number: 1,
  kind: "RECLAMO",
  createdAt: "2026-10-07T20:00:00.000Z",
  confirmationEmailStatus: "PENDING",
  replayed: false
};

const COPY: ComplaintCopy = {
  id: ENTRY_ID,
  number: 1,
  code: "LR-2026-000001",
  kind: "RECLAMO",
  consumer: {
    firstNames: "Ana María",
    lastNames: "Quispe Rojas",
    documentType: "DNI",
    documentNumber: "45678912",
    email: "ana.quispe@example.com",
    phone: "987654321",
    address: "Av. Siempre Viva 123, Lima",
    isMinor: false,
    guardianName: null
  },
  good: { type: "SERVICIO", description: "Plan Pro mensual", claimedAmountCents: 3990 },
  detail: "Se realizó un cobro que no reconozco.",
  consumerRequest: "Solicito la revisión del cobro.",
  createdAt: "2026-10-07T20:00:00.000Z",
  idempotencyKey: `complaint-confirmation/${ENTRY_ID}/0`
};

const ANSWER = "Revisamos tu caso y procederemos con la devolución del cobro duplicado.";

const TARGET: ComplaintResponseTarget = {
  id: ENTRY_ID,
  code: "LR-2026-000001",
  kind: "RECLAMO",
  firstNames: "Ana María",
  lastNames: "Quispe Rojas",
  email: "ana.quispe@example.com",
  createdAt: "2026-10-07T20:00:00.000Z",
  response: ANSWER,
  preparedAt: "2026-10-08T15:00:00.000Z",
  idempotencyKey: `complaint-response/${ENTRY_ID}/1`
};

const PII = ["ana.quispe", "Ana.Quispe", "45678912", "Quispe Rojas", "987654321", "Siempre Viva", "no reconozco", "revisión del cobro", "devolución del cobro"];

type MailResult = Awaited<ReturnType<TransactionalMailer["send"]>>;

function fakeMailer(result: MailResult = { outcome: "SENT", providerMessageId: "re_123" }) {
  return { send: vi.fn(async (_email: OutgoingEmail): Promise<MailResult> => result) };
}

let current: Awaited<ReturnType<typeof createTestApp>> | null = null;
afterEach(async () => {
  await current?.app.close();
  current = null;
});

async function setup(options: { mailer?: ReturnType<typeof fakeMailer> | null } = {}) {
  const mailer = options.mailer === undefined ? fakeMailer() : options.mailer;
  current = await createTestApp({ users: [owner, otherOwner, platformAdmin], platformAdmins: [platformAdmin.id], ...(mailer ? { mailer } : {}) });
  current.privileged.submitComplaintBookEntry.mockResolvedValue(SUBMITTED);
  current.privileged.claimComplaintConfirmationEmail.mockResolvedValue(COPY);
  current.privileged.recordComplaintConfirmationEmail.mockImplementation(async (_id: string, record: { outcome: string }) =>
    record.outcome === "SENT" ? "SENT" : record.outcome === "UNKNOWN" ? "UNKNOWN" : "FAILED"
  );
  return { ...current, mailer };
}

type Context = Awaited<ReturnType<typeof setup>>;

const submit = (context: Context, payload: unknown, headers: Record<string, string> = {}) =>
  context.app.inject({ method: "POST", url: "/api/complaints-book", payload: payload as object, headers });

const sentEmail = (mailer: ReturnType<typeof fakeMailer> | null, call = 0) => mailer!.send.mock.calls[call]![0];

describe("POST /api/complaints-book (public)", () => {
  it("a visitor without a session files a sheet: 201 with the code; data normalized, amount in céntimos", async () => {
    const context = await setup();
    const response = await submit(context, SHEET);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ code: "LR-2026-000001", number: 1, kind: "RECLAMO", createdAt: "2026-10-07T20:00:00.000Z", confirmationEmail: "SENT" });
    expect(context.privileged.submitComplaintBookEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "RECLAMO",
        email: "ana.quispe@example.com",
        claimedAmountCents: 3990,
        guardianName: null,
        isMinor: false,
        submissionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        requestId: expect.any(String)
      })
    );
    // The receipt carries the code to keep, never the consumer's data.
    expect(response.body).not.toContain("45678912");
  });

  it("e-mails the copy of the sheet to the address on the sheet, with the number, kind, date, deadline and support address", async () => {
    const context = await setup();
    await submit(context, SHEET);
    expect(context.privileged.claimComplaintConfirmationEmail).toHaveBeenCalledWith(ENTRY_ID);
    const email = sentEmail(context.mailer);
    expect(email.to).toBe("ana.quispe@example.com");
    expect(email.idempotencyKey).toBe(`complaint-confirmation/${ENTRY_ID}/0`);
    expect(email.subject).toBe("Constancia de tu reclamo LR-2026-000001 · Libro de Reclamaciones de EmailBot");
    for (const part of [email.text, email.html]) {
      expect(part).toContain("EmailBot");
      expect(part).toContain("LR-2026-000001");
      expect(part).toContain("Reclamo");
      expect(part).toContain("7 de octubre de 2026");
      expect(part).toMatch(/quince \(15\) días hábiles/);
      expect(part).toContain("soporte@emailbot.app");
      expect(part).toMatch(/Conserva el número de registro/);
      // Full copy of the sheet: provider, consumer, good, detail and request.
      for (const field of ["10733272231", "Jr Manco Cápac 653", "45678912", "Av. Siempre Viva 123, Lima", "987654321", "Plan Pro mensual", "S/ 39.90", "Se realizó un cobro que no reconozco.", "Solicito la revisión del cobro."]) {
        expect(part).toContain(field);
      }
      expect(part).toMatch(/INDECOPI/);
    }
    expect(context.privileged.recordComplaintConfirmationEmail).toHaveBeenCalledWith(ENTRY_ID, { outcome: "SENT", providerMessageId: "re_123" });
  });

  it("a minor's sheet: the copy names the parent or guardian", async () => {
    const context = await setup();
    context.privileged.claimComplaintConfirmationEmail.mockResolvedValue({ ...COPY, consumer: { ...COPY.consumer, isMinor: true, guardianName: "Rosa Rojas" } });
    await submit(context, { ...SHEET, isMinor: true, guardianName: "Rosa Rojas" });
    expect(sentEmail(context.mailer).text).toContain("Padre, madre o apoderado (menor de edad): Rosa Rojas");
  });

  it("the provider rejects the copy: the sheet stays recorded, 201 with the number and confirmationEmail FAILED (error code recorded)", async () => {
    const context = await setup({ mailer: fakeMailer({ outcome: "REJECTED", errorCode: "PROVIDER_REJECTED" }) });
    const response = await submit(context, SHEET);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ code: "LR-2026-000001", confirmationEmail: "FAILED" });
    expect(context.privileged.recordComplaintConfirmationEmail).toHaveBeenCalledWith(ENTRY_ID, { outcome: "REJECTED", errorCode: "PROVIDER_REJECTED" });
  });

  it("the provider throws, the claim fails or the outcome cannot be recorded: still 201 with the number", async () => {
    const throwing = { send: vi.fn(async () => Promise.reject(new Error("socket hang up"))) };
    const context = await setup({ mailer: throwing as unknown as ReturnType<typeof fakeMailer> });
    const failed = await submit(context, SHEET);
    expect(failed.statusCode).toBe(201);
    // Nothing is known about that e-mail: never reported as failed (same key on the next attempt).
    expect(failed.json()).toMatchObject({ code: "LR-2026-000001", confirmationEmail: "PENDING" });
    expect(context.privileged.recordComplaintConfirmationEmail).toHaveBeenLastCalledWith(ENTRY_ID, { outcome: "UNKNOWN", errorCode: "PROVIDER_ERROR" });

    context.privileged.claimComplaintConfirmationEmail.mockRejectedValueOnce(new Error("database unavailable"));
    const unclaimed = await submit(context, SHEET);
    expect(unclaimed.statusCode).toBe(201);
    expect(unclaimed.json()).toMatchObject({ code: "LR-2026-000001", confirmationEmail: "PENDING" });

    const okContext = await setup();
    okContext.privileged.recordComplaintConfirmationEmail.mockRejectedValueOnce(new Error("database unavailable"));
    const unrecorded = await submit(okContext, SHEET);
    expect(unrecorded.statusCode).toBe(201);
    expect(unrecorded.json()).toMatchObject({ confirmationEmail: "SENT" });
  });

  it("without transactional e-mail configured the sheet is recorded and its copy stays PENDING (nothing claimed)", async () => {
    const context = await setup({ mailer: null });
    const response = await submit(context, SHEET);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ code: "LR-2026-000001", confirmationEmail: "PENDING" });
    expect(context.privileged.claimComplaintConfirmationEmail).not.toHaveBeenCalled();
  });

  it("if the sheet cannot be recorded, nothing is e-mailed and the consumer gets an error (no number)", async () => {
    const context = await setup();
    context.privileged.submitComplaintBookEntry.mockRejectedValue(new Error("database unavailable"));
    const response = await submit(context, SHEET);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("LR-");
    expect(context.mailer!.send).not.toHaveBeenCalled();
  });

  it("a retried submission returns the same number and never e-mails twice", async () => {
    const context = await setup();
    const submissionId = "6f2b8c1e-3d4a-4b5c-8d9e-0f1a2b3c4d5e";
    expect((await submit(context, { ...SHEET, submissionId })).statusCode).toBe(201);
    expect(context.privileged.submitComplaintBookEntry).toHaveBeenLastCalledWith(expect.objectContaining({ submissionId }));

    // Retry after the copy was sent: the database says SENT, nothing is claimed or sent.
    context.privileged.submitComplaintBookEntry.mockResolvedValue({ ...SUBMITTED, replayed: true, confirmationEmailStatus: "SENT" });
    const replay = await submit(context, { ...SHEET, submissionId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ code: "LR-2026-000001", number: 1, confirmationEmail: "SENT" });
    expect(context.privileged.claimComplaintConfirmationEmail).toHaveBeenCalledTimes(1);
    expect(context.mailer!.send).toHaveBeenCalledTimes(1);

    // Retry while another request is sending it: the claim returns nothing, so nothing is sent.
    context.privileged.submitComplaintBookEntry.mockResolvedValue({ ...SUBMITTED, replayed: true, confirmationEmailStatus: "SENDING" });
    context.privileged.claimComplaintConfirmationEmail.mockResolvedValue(null);
    expect((await submit(context, { ...SHEET, submissionId })).json()).toMatchObject({ confirmationEmail: "PENDING" });
    expect(context.mailer!.send).toHaveBeenCalledTimes(1);
  });

  it("QUEJA without an amount; a minor's sheet keeps the parent or guardian", async () => {
    const context = await setup();
    context.privileged.submitComplaintBookEntry.mockResolvedValue({ ...SUBMITTED, kind: "QUEJA" });
    expect((await submit(context, { ...SHEET, kind: "QUEJA", claimedAmount: "" })).statusCode).toBe(201);
    expect(context.privileged.submitComplaintBookEntry).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "QUEJA", claimedAmountCents: null }));
    expect((await submit(context, { ...SHEET, isMinor: true, guardianName: "Rosa Rojas" })).statusCode).toBe(201);
    expect(context.privileged.submitComplaintBookEntry).toHaveBeenLastCalledWith(expect.objectContaining({ isMinor: true, guardianName: "Rosa Rojas" }));
  });

  it.each([
    ["an unknown kind", { kind: "SUGERENCIA" }],
    ["an invalid email", { email: "no" }],
    ["an invalid DNI", { documentNumber: "12" }],
    ["a too short detail", { detail: "corto" }],
    ["no truth confirmation", { confirmTruth: false }],
    ["a filled honeypot", { website: "http://spam" }],
    ["a minor without guardian", { isMinor: true, guardianName: "" }],
    ["markup-only injection attempt in the amount", { claimedAmount: "<script>" }],
    ["a submission id that is not a UUID", { submissionId: "1; drop table" }]
  ])("rejects %s with 400, stores nothing and sends nothing", async (_label, override) => {
    const context = await setup();
    const response = await submit(context, { ...SHEET, ...override });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
    expect(context.privileged.submitComplaintBookEntry).not.toHaveBeenCalled();
    expect(context.mailer!.send).not.toHaveBeenCalled();
  });

  it("markup typed by the consumer is stored as text and escaped in the e-mail (never rendered as HTML)", async () => {
    const context = await setup();
    const detail = "<img src=x onerror=alert(1)> cobro <script>alert(2)</script>";
    context.privileged.claimComplaintConfirmationEmail.mockResolvedValue({ ...COPY, detail, consumer: { ...COPY.consumer, firstNames: '"><b>Ana</b>' } });
    expect((await submit(context, { ...SHEET, detail })).statusCode).toBe(201);
    expect(context.privileged.submitComplaintBookEntry).toHaveBeenLastCalledWith(expect.objectContaining({ detail }));
    const email = sentEmail(context.mailer);
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).not.toContain("<b>Ana</b>");
    expect(email.html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(email.html).toContain("&quot;&gt;&lt;b&gt;Ana&lt;/b&gt;");
    expect(email.text).toContain(detail);
  });

  it("is rate limited per client (5 sheets per 10 minutes)", async () => {
    const context = await setup();
    const statuses: number[] = [];
    for (let index = 0; index < 6; index += 1) statuses.push((await submit(context, SHEET)).statusCode);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("logs carry the code and the e-mail outcome, never the consumer's data or the sheet", async () => {
    const lines: string[] = [];
    const context = await setup({ mailer: fakeMailer({ outcome: "REJECTED", errorCode: "PROVIDER_REJECTED" }) });
    const app = await buildApp(context.deps, { logger: { level: "debug", stream: { write: (line: string) => void lines.push(line) } } });
    await app.inject({ method: "POST", url: "/api/complaints-book", payload: SHEET });
    await app.close();
    const output = lines.join("\n");
    expect(output).toContain("complaints_book.submitted");
    expect(output).toContain("complaints_book.copy_failed");
    expect(output).toContain("LR-2026-000001");
    for (const value of PII) expect(output).not.toContain(value);
  });
});

describe("GET /api/admin/complaints-book (platform administrators)", () => {
  const ENTRY: ComplaintBookEntry = {
    id: ENTRY_ID,
    number: 1,
    code: "LR-2026-000001",
    kind: "RECLAMO",
    status: "PENDING",
    consumer: COPY.consumer,
    good: COPY.good,
    detail: COPY.detail,
    consumerRequest: COPY.consumerRequest,
    confirmationEmail: { status: "SENT", sentAt: "2026-10-07T20:00:01.000Z", errorCode: null, decisionRequired: false },
    response: { text: null, emailStatus: null, errorCode: null, respondedAt: null, respondedByEmail: null, decisionRequired: false },
    createdAt: "2026-10-07T20:00:00.000Z"
  };

  it("without a session: 401; a regular member (even OWNER): 403; nothing is read", async () => {
    const context = await setup();
    expect((await context.app.inject({ method: "GET", url: "/api/admin/complaints-book" })).statusCode).toBe(401);
    const asOwner = await context.app.inject({ method: "GET", url: "/api/admin/complaints-book", headers: authHeaders(owner, ORG_A) });
    expect(asOwner.statusCode).toBe(403);
    expect(context.admin.listComplaintBookEntries).not.toHaveBeenCalled();
  });

  it("a platform administrator lists the sheets (paginated, actor from the token)", async () => {
    const context = await setup();
    context.admin.listComplaintBookEntries.mockResolvedValue([ENTRY, { ...ENTRY, number: 2 }]);
    const response = await context.app.inject({ method: "GET", url: "/api/admin/complaints-book?page=1&pageSize=1", headers: authHeaders(platformAdmin) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [ENTRY], page: 1, pageSize: 1, hasMore: true });
    expect(context.admin.listComplaintBookEntries).toHaveBeenCalledWith(platformAdmin.id, { limit: 2, offset: 0 });
  });
});

describe("POST /api/admin/complaints-book/:id/response (platform administrators)", () => {
  const respond = (context: Context, body: unknown, headers: Record<string, string> = authHeaders(platformAdmin), id = ENTRY_ID) =>
    context.app.inject({ method: "POST", url: `/api/admin/complaints-book/${id}/response`, payload: body as object, headers });

  async function ready(mailer?: ReturnType<typeof fakeMailer> | null) {
    const context = await setup(mailer === undefined ? {} : { mailer });
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "READY", target: TARGET });
    context.admin.recordComplaintResponse.mockImplementation(async (_actor: string, _id: string, record: { outcome: string }) =>
      record.outcome === "SENT" ? { status: "RESPONDED", respondedAt: "2026-10-08T15:00:00.000Z" } : { status: "PENDING", respondedAt: null }
    );
    return context;
  }

  it("an administrator answers: the e-mail goes to the address on the sheet, the case is RESPONDED and the outcome recorded with the request id", async () => {
    const context = await ready();
    const response = await respond(context, { response: `  ${ANSWER}  ` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "RESPONDED", respondedAt: "2026-10-08T15:00:00.000Z" });
    expect(context.admin.beginComplaintResponse).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, ANSWER, false);
    expect(sentEmail(context.mailer).text).toContain("Fecha de respuesta: 8 de octubre de 2026 a las 10:00");

    const email = sentEmail(context.mailer);
    expect(email.to).toBe("ana.quispe@example.com");
    expect(email.idempotencyKey).toBe(TARGET.idempotencyKey);
    expect(email.subject).toBe("Respuesta a tu reclamo LR-2026-000001 · Libro de Reclamaciones de EmailBot");
    for (const part of [email.text, email.html]) {
      expect(part).toContain("EmailBot");
      expect(part).toContain("LR-2026-000001");
      expect(part).toContain(ANSWER);
      expect(part).toContain("Fecha de respuesta");
      expect(part).toContain("soporte@emailbot.app");
      expect(part).toMatch(/quince \(15\) días hábiles/);
    }
    const [actor, id, outcome, requestId] = context.admin.recordComplaintResponse.mock.calls[0]!;
    expect([actor, id, outcome]).toEqual([platformAdmin.id, ENTRY_ID, { outcome: "SENT", providerMessageId: "re_123" }]);
    expect(requestId).toEqual(expect.any(String));
  });

  it("the provider rejects the answer: 502 EMAIL_NOT_SENT, the failure is recorded and the case is not RESPONDED", async () => {
    const context = await ready(fakeMailer({ outcome: "REJECTED", errorCode: "PROVIDER_REJECTED" }));
    const response = await respond(context, { response: ANSWER });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("EMAIL_NOT_SENT");
    expect(response.body).not.toContain("RESPONDED");
    expect(context.admin.recordComplaintResponse).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, { outcome: "REJECTED", errorCode: "PROVIDER_REJECTED" }, expect.any(String));
  });

  it("sent but not recorded: 500 asking to send the same text again (the idempotency key prevents a second e-mail)", async () => {
    const context = await ready();
    context.admin.recordComplaintResponse.mockRejectedValue(new Error("database unavailable"));
    const response = await respond(context, { response: ANSWER });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("COMPLAINT_RESPONSE_NOT_RECORDED");
  });

  it("markup in the answer is escaped in the e-mail", async () => {
    const context = await ready();
    const answer = "Hola <script>alert(1)</script> <a href=javascript:alert(2)>aquí</a> ya revisamos el cobro.";
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "READY", target: { ...TARGET, response: answer } });
    expect((await respond(context, { response: answer })).statusCode).toBe(200);
    const email = sentEmail(context.mailer);
    expect(email.html).not.toContain("<script>");
    expect(email.html).not.toContain("<a href=javascript");
    expect(email.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(email.text).toContain(answer);
  });

  it.each([
    ["too short", { response: "corta" }],
    ["too long", { response: "x".repeat(5001) }],
    ["missing", {}],
    ["not a string", { response: 42 }]
  ])("rejects an answer %s with 400 (nothing claimed or sent)", async (_label, body) => {
    const context = await ready();
    const response = await respond(context, body);
    expect(response.statusCode).toBe(400);
    expect(context.admin.beginComplaintResponse).not.toHaveBeenCalled();
    expect(context.mailer!.send).not.toHaveBeenCalled();
  });

  it("an invalid id is 400; an unknown sheet 404; an answered one or one being answered 409; nothing is sent", async () => {
    const context = await ready();
    expect((await respond(context, { response: ANSWER }, authHeaders(platformAdmin), "not-a-uuid")).statusCode).toBe(400);
    context.admin.beginComplaintResponse.mockResolvedValueOnce({ outcome: "NOT_FOUND" });
    expect((await respond(context, { response: ANSWER })).statusCode).toBe(404);
    context.admin.beginComplaintResponse.mockResolvedValueOnce({ outcome: "ALREADY_RESPONDED" });
    const answered = await respond(context, { response: ANSWER });
    expect([answered.statusCode, answered.json().error.code]).toEqual([409, "COMPLAINT_ALREADY_RESPONDED"]);
    context.admin.beginComplaintResponse.mockResolvedValueOnce({ outcome: "IN_PROGRESS" });
    const inProgress = await respond(context, { response: ANSWER });
    expect([inProgress.statusCode, inProgress.json().error.code]).toEqual([409, "COMPLAINT_RESPONSE_IN_PROGRESS"]);
    expect(context.mailer!.send).not.toHaveBeenCalled();
    expect(context.admin.recordComplaintResponse).not.toHaveBeenCalled();
  });

  it("only platform administrators: no session 401; organization owners (any organization) 403; nothing claimed or sent", async () => {
    const context = await ready();
    expect((await respond(context, { response: ANSWER }, {})).statusCode).toBe(401);
    expect((await respond(context, { response: ANSWER }, authHeaders(owner, ORG_A))).statusCode).toBe(403);
    expect((await respond(context, { response: ANSWER }, authHeaders(otherOwner, ORG_B))).statusCode).toBe(403);
    expect(context.admin.beginComplaintResponse).not.toHaveBeenCalled();
    expect(context.mailer!.send).not.toHaveBeenCalled();
  });

  it("without transactional e-mail configured: 503 and nothing is claimed", async () => {
    const context = await ready(null);
    const response = await respond(context, { response: ANSWER });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("EMAIL_NOT_CONFIGURED");
    expect(context.admin.beginComplaintResponse).not.toHaveBeenCalled();
  });

  it("logs never contain the answer or the consumer's address", async () => {
    const lines: string[] = [];
    const context = await ready(fakeMailer({ outcome: "REJECTED", errorCode: "PROVIDER_REJECTED" }));
    const app = await buildApp(context.deps, { logger: { level: "debug", stream: { write: (line: string) => void lines.push(line) } } });
    await app.inject({ method: "POST", url: `/api/admin/complaints-book/${ENTRY_ID}/response`, payload: { response: ANSWER }, headers: authHeaders(platformAdmin) });
    await app.close();
    const output = lines.join("\n");
    expect(output).toContain("complaints_book.response_failed");
    for (const value of PII) expect(output).not.toContain(value);
  });
});

describe("POST /api/admin/complaints-book/:id/confirmation-email (platform administrators)", () => {
  const resend = (context: Context, headers: Record<string, string> = authHeaders(platformAdmin)) =>
    context.app.inject({ method: "POST", url: `/api/admin/complaints-book/${ENTRY_ID}/confirmation-email`, headers });

  it("sends the copy again to the address on the sheet and records the outcome (audited in the database)", async () => {
    const context = await setup();
    context.admin.claimComplaintConfirmationEmail.mockResolvedValue({ ...COPY, idempotencyKey: `complaint-confirmation/${ENTRY_ID}/1` });
    context.admin.recordComplaintConfirmationEmail.mockResolvedValue("SENT");
    const response = await resend(context);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ confirmationEmail: "SENT" });
    expect(context.admin.claimComplaintConfirmationEmail).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, false);
    expect(sentEmail(context.mailer)).toMatchObject({ to: "ana.quispe@example.com", idempotencyKey: `complaint-confirmation/${ENTRY_ID}/1` });
    expect(context.admin.recordComplaintConfirmationEmail).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, { outcome: "SENT", providerMessageId: "re_123" }, expect.any(String));
  });

  it("already sent or being sent: 409 and nothing is sent; an unknown outcome: 502 EMAIL_OUTCOME_UNKNOWN recorded as UNKNOWN", async () => {
    const context = await setup({ mailer: fakeMailer({ outcome: "UNKNOWN", errorCode: "PROVIDER_UNAVAILABLE" }) });
    context.admin.claimComplaintConfirmationEmail.mockResolvedValueOnce(null);
    const notPending = await resend(context);
    expect([notPending.statusCode, notPending.json().error.code]).toEqual([409, "COMPLAINT_COPY_NOT_PENDING"]);
    expect(context.mailer!.send).not.toHaveBeenCalled();

    context.admin.claimComplaintConfirmationEmail.mockResolvedValueOnce(COPY);
    context.admin.recordComplaintConfirmationEmail.mockResolvedValue("UNKNOWN");
    const uncertain = await resend(context);
    expect([uncertain.statusCode, uncertain.json().error.code]).toEqual([502, "EMAIL_OUTCOME_UNKNOWN"]);
    expect(context.admin.recordComplaintConfirmationEmail).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, { outcome: "UNKNOWN", errorCode: "PROVIDER_UNAVAILABLE" }, expect.any(String));

    context.admin.claimComplaintConfirmationEmail.mockResolvedValueOnce(COPY);
    context.mailer!.send.mockResolvedValueOnce({ outcome: "REJECTED", errorCode: "PROVIDER_REJECTED" });
    const rejected = await resend(context);
    expect([rejected.statusCode, rejected.json().error.code]).toEqual([502, "EMAIL_NOT_SENT"]);
  });

  it("members are refused (403) and nothing is claimed", async () => {
    const context = await setup();
    expect((await resend(context, authHeaders(owner, ORG_A))).statusCode).toBe(403);
    expect(context.admin.claimComplaintConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe("Resend client", () => {
  const EMAIL: OutgoingEmail = { to: "ana@example.com", subject: "Asunto", html: "<p>x</p>", text: "x", idempotencyKey: "complaint-confirmation/abc/0", category: "complaint_copy" };
  const client = (response: Response | Error) => {
    const fetch = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    return { fetch, mailer: createResendMailer({ apiKey: "re_test_key_value", from: "EmailBot <no-reply@emailbot.app>", replyTo: "soporte@emailbot.app", fetch: fetch as unknown as typeof globalThis.fetch }) };
  };

  it("posts the e-mail with the idempotency key, the sender and reply-to the support mailbox", async () => {
    const { fetch, mailer } = client(new Response(JSON.stringify({ id: "re_abc" }), { status: 200 }));
    expect(await mailer.send(EMAIL)).toEqual({ outcome: "SENT", providerMessageId: "re_abc" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer re_test_key_value", "idempotency-key": "complaint-confirmation/abc/0" });
    expect(JSON.parse(init.body as string)).toEqual({
      from: "EmailBot <no-reply@emailbot.app>",
      to: ["ana@example.com"],
      reply_to: "soporte@emailbot.app",
      subject: "Asunto",
      html: "<p>x</p>",
      text: "x",
      tags: [{ name: "category", value: "complaint_copy" }]
    });
  });

  it.each([
    [422, "REJECTED", "PROVIDER_REJECTED"],
    [400, "REJECTED", "PROVIDER_REJECTED"],
    [401, "REJECTED", "PROVIDER_AUTH"],
    [403, "REJECTED", "PROVIDER_AUTH"],
    [429, "REJECTED", "PROVIDER_RATE_LIMITED"],
    // The provider may have accepted it: never a confirmed failure.
    [409, "UNKNOWN", "PROVIDER_CONFLICT"],
    [500, "UNKNOWN", "PROVIDER_UNAVAILABLE"],
    [502, "UNKNOWN", "PROVIDER_UNAVAILABLE"],
    [503, "UNKNOWN", "PROVIDER_UNAVAILABLE"]
  ])("HTTP %i is %s (%s), never sent", async (status, outcome, errorCode) => {
    const { mailer } = client(new Response(JSON.stringify({ message: "secret detail ana@example.com" }), { status }));
    expect(await mailer.send(EMAIL)).toEqual({ outcome, errorCode });
  });

  it("a timeout or a network error is UNKNOWN (the request may have reached Resend); a 2xx without a readable id is still sent", async () => {
    expect(await client(new HttpTimeoutError("api.resend.com", 20_000)).mailer.send(EMAIL)).toEqual({ outcome: "UNKNOWN", errorCode: "PROVIDER_TIMEOUT" });
    expect(await client(new DOMException("The operation timed out.", "TimeoutError")).mailer.send(EMAIL)).toEqual({ outcome: "UNKNOWN", errorCode: "PROVIDER_TIMEOUT" });
    expect(await client(new TypeError("fetch failed")).mailer.send(EMAIL)).toEqual({ outcome: "UNKNOWN", errorCode: "PROVIDER_NETWORK" });
    expect(await client(new Response("not json", { status: 200 })).mailer.send(EMAIL)).toEqual({ outcome: "SENT", providerMessageId: null });
  });
});

describe("transactional e-mail configuration", () => {
  const base = {
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
    OAUTH_STATE_SECRET: "x".repeat(40),
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64")
  };

  it("is optional; when set, both variables go together and replies go to the support mailbox", () => {
    expect(loadConfig(base).transactionalEmail).toBeNull();
    expect(loadConfig({ ...base, RESEND_API_KEY: "re_test_key_value", TRANSACTIONAL_EMAIL_FROM: "EmailBot <no-reply@emailbot.app>" }).transactionalEmail).toEqual({
      resendApiKey: "re_test_key_value",
      from: "EmailBot <no-reply@emailbot.app>",
      replyTo: "soporte@emailbot.app"
    });
    expect(() => loadConfig({ ...base, RESEND_API_KEY: "re_test_key_value" })).toThrow(/RESEND_API_KEY and TRANSACTIONAL_EMAIL_FROM must be set together/);
    expect(() => loadConfig({ ...base, TRANSACTIONAL_EMAIL_FROM: "no-reply@emailbot.app" })).toThrow(/must be set together/);
    expect(() => loadConfig({ ...base, RESEND_API_KEY: "re_test_key_value", TRANSACTIONAL_EMAIL_FROM: "EmailBot" })).toThrow(/TRANSACTIONAL_EMAIL_FROM/);
  });

  it("errors never echo the key", () => {
    try {
      loadConfig({ ...base, RESEND_API_KEY: "re_test_key_value" });
    } catch (error) {
      expect(String(error)).not.toContain("re_test_key_value");
    }
  });
});

describe("idempotent answer e-mails", () => {
  it("the answer e-mail is built only from the stored operation: identical bytes on every generation, whatever the clock says", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-08T15:00:30Z"));
      const first = complaintResponseEmail(TARGET);
      vi.setSystemTime(new Date("2026-10-09T23:59:59Z"));
      const second = complaintResponseEmail(structuredClone(TARGET));
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first.idempotencyKey).toBe(TARGET.idempotencyKey);
      // The date printed is the operation's (fixed when it started), not the current one.
      expect(first.text).toContain("Fecha de respuesta: 8 de octubre de 2026 a las 10:00");
      expect(first.text).not.toContain("9 de octubre");
      // The copy of the sheet is deterministic too.
      expect(JSON.stringify(complaintCopyEmail(COPY))).toBe(JSON.stringify(complaintCopyEmail(structuredClone(COPY))));
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a timeout", "PROVIDER_TIMEOUT"],
    ["a network error", "PROVIDER_NETWORK"],
    ["a provider 5xx", "PROVIDER_UNAVAILABLE"],
    ["a 409 (concurrent request / key already used)", "PROVIDER_CONFLICT"]
  ] as const)("%s is UNKNOWN: 502 EMAIL_OUTCOME_UNKNOWN, recorded as UNKNOWN (no new key), never RESPONDED", async (_label, errorCode) => {
    const context = await setup({ mailer: fakeMailer({ outcome: "UNKNOWN", errorCode }) });
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "READY", target: TARGET });
    context.admin.recordComplaintResponse.mockResolvedValue({ status: "PENDING", respondedAt: null });
    const response = await context.app.inject({
      method: "POST",
      url: `/api/admin/complaints-book/${ENTRY_ID}/response`,
      payload: { response: ANSWER },
      headers: authHeaders(platformAdmin)
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe("EMAIL_OUTCOME_UNKNOWN");
    expect(response.body).not.toContain("RESPONDED");
    expect(context.admin.recordComplaintResponse).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, { outcome: "UNKNOWN", errorCode }, expect.any(String));
  });

  it("while the outcome is unknown another text is refused (409 COMPLAINT_RESPONSE_TEXT_LOCKED), nothing is sent", async () => {
    const context = await setup();
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "TEXT_LOCKED" });
    const response = await context.app.inject({
      method: "POST",
      url: `/api/admin/complaints-book/${ENTRY_ID}/response`,
      payload: { response: "Otra respuesta distinta al caso." },
      headers: authHeaders(platformAdmin)
    });
    expect([response.statusCode, response.json().error.code]).toEqual([409, "COMPLAINT_RESPONSE_TEXT_LOCKED"]);
    expect(context.mailer!.send).not.toHaveBeenCalled();
  });

  it("the public copy with an unknown outcome: 201 with the number, copy PENDING, recorded as UNKNOWN", async () => {
    const context = await setup({ mailer: fakeMailer({ outcome: "UNKNOWN", errorCode: "PROVIDER_TIMEOUT" }) });
    const response = await context.app.inject({ method: "POST", url: "/api/complaints-book", payload: SHEET });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ code: "LR-2026-000001", confirmationEmail: "PENDING" });
    expect(context.privileged.recordComplaintConfirmationEmail).toHaveBeenCalledWith(ENTRY_ID, { outcome: "UNKNOWN", errorCode: "PROVIDER_TIMEOUT" });
  });

  /**
   * Resend's documented idempotency (24 h): the same key + same payload returns the first result without sending;
   * the same key + another payload answers 409 invalid_idempotent_request. Here the first request is accepted
   * but its answer is lost (timeout); the retry repeats the stored operation (the database hands back the same
   * operation once the claim expired: modeled by beginComplaintResponse returning the same target).
   */
  function fakeResend() {
    const keys = new Map<string, { payload: string; id: string }>();
    const delivered: string[] = [];
    let loseNextAnswer = false;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const key = (init!.headers as Record<string, string>)["idempotency-key"]!;
      const payload = createHash("sha256").update(String(init!.body)).digest("hex");
      const known = keys.get(key);
      if (known && known.payload !== payload) return new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 });
      if (!known) {
        const id = `re_${keys.size + 1}`;
        keys.set(key, { payload, id });
        delivered.push(id);
      }
      if (loseNextAnswer) {
        loseNextAnswer = false;
        throw new HttpTimeoutError("api.resend.com", 20_000);
      }
      return new Response(JSON.stringify({ id: keys.get(key)!.id }), { status: 200 });
    });
    return {
      delivered,
      loseNextAnswer: () => {
        loseNextAnswer = true;
      },
      mailer: createResendMailer({ apiKey: "re_test_key_value", from: "EmailBot <no-reply@emailbot.app>", replyTo: "soporte@emailbot.app", fetch: fetch as unknown as typeof globalThis.fetch })
    };
  }

  it("Resend accepts but the answer is lost (timeout): the retry of the same operation sends nothing new, the consumer gets ONE e-mail", async () => {
    const resend = fakeResend();
    const context = await setup({ mailer: resend.mailer as unknown as ReturnType<typeof fakeMailer> });
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "READY", target: TARGET });
    context.admin.recordComplaintResponse.mockImplementation(async (_actor: string, _id: string, record: { outcome: string }) =>
      record.outcome === "SENT" ? { status: "RESPONDED", respondedAt: TARGET.preparedAt } : { status: "PENDING", respondedAt: null }
    );
    const answer = () =>
      context.app.inject({ method: "POST", url: `/api/admin/complaints-book/${ENTRY_ID}/response`, payload: { response: ANSWER }, headers: authHeaders(platformAdmin) });

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-08T15:00:30Z"));
      resend.loseNextAnswer();
      const first = await answer();
      expect([first.statusCode, first.json().error.code]).toEqual([502, "EMAIL_OUTCOME_UNKNOWN"]);
      expect(context.admin.recordComplaintResponse).toHaveBeenLastCalledWith(platformAdmin.id, ENTRY_ID, { outcome: "UNKNOWN", errorCode: "PROVIDER_TIMEOUT" }, expect.any(String));

      // Minutes later (the claim expired): same operation, same key, same bytes.
      vi.setSystemTime(new Date("2026-10-08T15:04:10Z"));
      const second = await answer();
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ status: "RESPONDED", respondedAt: TARGET.preparedAt });
    } finally {
      vi.useRealTimers();
    }
    expect(resend.delivered).toEqual(["re_1"]);
    expect(context.admin.recordComplaintResponse).toHaveBeenLastCalledWith(platformAdmin.id, ENTRY_ID, { outcome: "SENT", providerMessageId: "re_1" }, expect.any(String));
  });

  it("two administrators: only the one whose claim won sends; the other gets 409 and nothing is sent", async () => {
    // The database lets one claim win (admin.begin_complaint_response locks the row): READY, then IN_PROGRESS.
    const mailer = fakeMailer();
    const otherAdmin = makeUser({});
    current = await createTestApp({ users: [platformAdmin, otherAdmin], platformAdmins: [platformAdmin.id, otherAdmin.id], mailer });
    current.admin.beginComplaintResponse.mockResolvedValueOnce({ outcome: "READY", target: TARGET }).mockResolvedValueOnce({ outcome: "IN_PROGRESS" });
    current.admin.recordComplaintResponse.mockResolvedValue({ status: "RESPONDED", respondedAt: TARGET.preparedAt });
    const send = (user: typeof platformAdmin) =>
      current!.app.inject({ method: "POST", url: `/api/admin/complaints-book/${ENTRY_ID}/response`, payload: { response: ANSWER }, headers: authHeaders(user) });
    const results = await Promise.all([send(platformAdmin), send(otherAdmin)]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 409]);
    expect(mailer.send).toHaveBeenCalledTimes(1);
  });
});

describe("past the provider's idempotency window (unknown outcome older than 23 h)", () => {
  const PROVIDER_ID = "0b2c7a1e-5d3f-4c6a-9e8b-1f2a3b4c5d6e";
  const post = (context: Context, url: string, payload: object, headers: Record<string, string> = authHeaders(platformAdmin)) =>
    context.app.inject({ method: "POST", url: `/api/admin/complaints-book/${ENTRY_ID}${url}`, payload, headers });

  it("the answer is never resent automatically: 409 COMPLAINT_RESPONSE_DECISION_REQUIRED, nothing sent", async () => {
    const context = await setup();
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "NEEDS_DECISION" });
    const response = await post(context, "/response", { response: ANSWER });
    expect([response.statusCode, response.json().error.code]).toEqual([409, "COMPLAINT_RESPONSE_DECISION_REQUIRED"]);
    expect(context.admin.beginComplaintResponse).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, ANSWER, false);
    expect(context.mailer!.send).not.toHaveBeenCalled();
  });

  it("an administrator may force the resend explicitly (forceResend: true only)", async () => {
    const context = await setup();
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "READY", target: { ...TARGET, idempotencyKey: `complaint-response/${ENTRY_ID}/2` } });
    context.admin.recordComplaintResponse.mockResolvedValue({ status: "RESPONDED", respondedAt: TARGET.preparedAt });
    expect((await post(context, "/response", { response: ANSWER, forceResend: "true" })).statusCode).toBe(400);
    expect((await post(context, "/response", { response: ANSWER, forceResend: false })).statusCode).toBe(400);
    const forced = await post(context, "/response", { response: ANSWER, forceResend: true });
    expect(forced.statusCode).toBe(200);
    expect(context.admin.beginComplaintResponse).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, ANSWER, true);
    expect(sentEmail(context.mailer).idempotencyKey).toBe(`complaint-response/${ENTRY_ID}/2`);
  });

  it("an administrator records the answer as sent with the provider id: no e-mail is sent", async () => {
    const context = await setup();
    context.admin.confirmComplaintResponse.mockResolvedValue({ outcome: "CONFIRMED", status: "RESPONDED", respondedAt: TARGET.preparedAt });
    const response = await post(context, "/response/confirm", { providerMessageId: `  ${PROVIDER_ID}  ` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "RESPONDED", respondedAt: TARGET.preparedAt });
    expect(context.admin.confirmComplaintResponse).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, PROVIDER_ID, expect.any(String));
    expect(context.mailer!.send).not.toHaveBeenCalled();

    context.admin.confirmComplaintResponse.mockResolvedValue({ outcome: "NOT_UNCERTAIN" });
    const notUncertain = await post(context, "/response/confirm", { providerMessageId: PROVIDER_ID });
    expect([notUncertain.statusCode, notUncertain.json().error.code]).toEqual([409, "COMPLAINT_EMAIL_NOT_UNCERTAIN"]);
  });

  it.each([["<script>"], ["corto"], [""], ["id with spaces inside"]])("an invalid provider id (%j) is 400 and nothing is recorded", async (providerMessageId) => {
    const context = await setup();
    expect((await post(context, "/response/confirm", { providerMessageId })).statusCode).toBe(400);
    expect((await post(context, "/confirmation-email/confirm", { providerMessageId })).statusCode).toBe(400);
    expect(context.admin.confirmComplaintResponse).not.toHaveBeenCalled();
    expect(context.admin.confirmComplaintConfirmationEmail).not.toHaveBeenCalled();
  });

  it("manual confirmations and forced resends are for platform administrators only", async () => {
    const context = await setup();
    for (const [url, payload] of [
      ["/response/confirm", { providerMessageId: PROVIDER_ID }],
      ["/confirmation-email/confirm", { providerMessageId: PROVIDER_ID }],
      ["/confirmation-email", { forceResend: true }],
      ["/response", { response: ANSWER, forceResend: true }]
    ] as const) {
      expect((await post(context, url, payload, {})).statusCode).toBe(401);
      expect((await post(context, url, payload, authHeaders(owner, ORG_A))).statusCode).toBe(403);
    }
    expect(context.admin.confirmComplaintResponse).not.toHaveBeenCalled();
    expect(context.admin.confirmComplaintConfirmationEmail).not.toHaveBeenCalled();
    expect(context.admin.claimComplaintConfirmationEmail).not.toHaveBeenCalled();
    expect(context.admin.beginComplaintResponse).not.toHaveBeenCalled();
  });

  it("the copy: a forced resend passes force to the database; a manual confirmation records it without sending", async () => {
    const context = await setup();
    context.admin.claimComplaintConfirmationEmail.mockResolvedValue({ ...COPY, idempotencyKey: `complaint-confirmation/${ENTRY_ID}/2` });
    context.admin.recordComplaintConfirmationEmail.mockResolvedValue("SENT");
    expect((await post(context, "/confirmation-email", { forceResend: true })).statusCode).toBe(200);
    expect(context.admin.claimComplaintConfirmationEmail).toHaveBeenCalledWith(platformAdmin.id, ENTRY_ID, true);
    expect(context.mailer!.send).toHaveBeenCalledTimes(1);

    context.admin.confirmComplaintConfirmationEmail.mockResolvedValue("CONFIRMED");
    const confirmed = await post(context, "/confirmation-email/confirm", { providerMessageId: PROVIDER_ID });
    expect([confirmed.statusCode, confirmed.json()]).toEqual([200, { confirmationEmail: "SENT" }]);
    expect(context.mailer!.send).toHaveBeenCalledTimes(1);
    context.admin.confirmComplaintConfirmationEmail.mockResolvedValue("NOT_UNCERTAIN");
    expect((await post(context, "/confirmation-email/confirm", { providerMessageId: PROVIDER_ID })).json().error.code).toBe("COMPLAINT_EMAIL_NOT_UNCERTAIN");
  });
});

describe("recording an accepted e-mail survives a transient database error", () => {
  it("the answer's outcome is recorded on a retry: 200 RESPONDED, not 'sent but not recorded'", async () => {
    const context = await setup();
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "READY", target: TARGET });
    context.admin.recordComplaintResponse
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ status: "RESPONDED", respondedAt: TARGET.preparedAt });
    const response = await context.app.inject({
      method: "POST",
      url: `/api/admin/complaints-book/${ENTRY_ID}/response`,
      payload: { response: ANSWER },
      headers: authHeaders(platformAdmin)
    });
    expect(response.statusCode).toBe(200);
    expect(context.admin.recordComplaintResponse).toHaveBeenCalledTimes(2);
    expect(context.mailer!.send).toHaveBeenCalledTimes(1);
  });

  it("the public copy's outcome too (the consumer sees SENT; one e-mail)", async () => {
    const context = await setup();
    context.privileged.recordComplaintConfirmationEmail.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await context.app.inject({ method: "POST", url: "/api/complaints-book", payload: SHEET });
    expect(response.json()).toMatchObject({ confirmationEmail: "SENT" });
    expect(context.privileged.recordComplaintConfirmationEmail).toHaveBeenCalledTimes(2);
    expect(context.privileged.recordComplaintConfirmationEmail).toHaveBeenLastCalledWith(ENTRY_ID, { outcome: "SENT", providerMessageId: "re_123" });
  });

  it("an accepted e-mail always logs its provider id (what an administrator needs to confirm it manually)", async () => {
    const lines: string[] = [];
    const context = await setup();
    context.admin.beginComplaintResponse.mockResolvedValue({ outcome: "READY", target: TARGET });
    context.admin.recordComplaintResponse.mockRejectedValue(new Error("database unavailable"));
    const app = await buildApp(context.deps, { logger: { level: "info", stream: { write: (line: string) => void lines.push(line) } } });
    const response = await app.inject({
      method: "POST",
      url: `/api/admin/complaints-book/${ENTRY_ID}/response`,
      payload: { response: ANSWER },
      headers: authHeaders(platformAdmin)
    });
    await app.close();
    expect(response.json().error.code).toBe("COMPLAINT_RESPONSE_NOT_RECORDED");
    const sent = lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line.event === "complaints_book.response_sent");
    expect(sent).toMatchObject({ code: "LR-2026-000001", providerMessageId: "re_123" });
    for (const value of PII) expect(lines.join("\n")).not.toContain(value);
  });
});
