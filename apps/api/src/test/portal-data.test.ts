import { randomUUID } from "node:crypto";
import type { EmailDelivery, PortalEmailDetail, PortalInboxItem } from "@emailbot/types";
import { describe, expect, it } from "vitest";
import { generateSessionToken, hashSessionToken } from "../lib/customer-access.js";
import { decodeCursor, encodeCursor } from "../modules/portal/data-routes.js";
import { PORTAL_SESSION_COOKIE } from "../modules/portal/session.js";
import type { PortalAttachmentLocation, PortalInboxFilters, PortalSessionContext } from "../repositories/types.js";
import { authHeaders, createTestApp, makeUser, ORG_A, ORG_B } from "./helpers.js";

/*
 * EmailBot V2 phase 5: portal inbox / detail / attachments and manual
 * deliveries (API layer). The portal.* functions are faked here by token
 * hash; their SQL is covered in packages/database and the local integration.
 */

const CUSTOMER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const CUSTOMER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const EMAIL_A = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const DELIVERY_A = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const DELIVERY_B = "dddddddd-dddd-4ddd-8ddd-ddddddddddd2";
const ATTACHMENT_A = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";

function item(deliveryId: string, deliveredAt: string): PortalInboxItem {
  return {
    deliveryId,
    deliveredAt,
    receivedAt: deliveredAt,
    subject: "Tu código",
    sender: { email: "info@netflix.example", name: null },
    bot: { name: "Netflix", slug: "netflix" },
    category: null,
    important: false,
    read: false,
    hasAttachments: true,
    fields: [{ key: "verification_code", label: "Código", value: "4821" }]
  };
}

async function setup() {
  const context = await createTestApp();
  const { privileged, app } = context;
  /** token hash -> customer / organization (the session is the only authority). */
  const sessions = new Map<string, { customerId: string; organizationId: string }>();
  const cookieFor = (customerId: string, organizationId: string) => {
    const token = generateSessionToken();
    sessions.set(hashSessionToken(token), { customerId, organizationId });
    return `${PORTAL_SESSION_COOKIE}=${token}`;
  };
  const deliveries = new Map<string, { customerId: string; detail: PortalEmailDetail; attachment: PortalAttachmentLocation }>([
    [
      DELIVERY_A,
      {
        customerId: CUSTOMER_A,
        detail: { ...item(DELIVERY_A, "2026-10-05T10:00:00.000Z"), body: null, attachments: [] },
        attachment: {
          id: ATTACHMENT_A,
          emailId: EMAIL_A,
          organizationId: ORG_A,
          filename: "factura.pdf",
          contentType: "application/pdf",
          storageBucket: "email-attachments",
          storagePath: `${ORG_A}/${EMAIL_A}/${ATTACHMENT_A}/factura.pdf`
        }
      }
    ],
    [
      DELIVERY_B,
      {
        customerId: CUSTOMER_B,
        detail: { ...item(DELIVERY_B, "2026-10-05T11:00:00.000Z"), body: null, attachments: [] },
        attachment: {
          id: randomUUID(),
          emailId: randomUUID(),
          organizationId: ORG_B,
          filename: "b.pdf",
          contentType: null,
          storageBucket: "email-attachments",
          storagePath: "x"
        }
      }
    ]
  ]);

  privileged.validatePortalSession.mockImplementation(async (tokenHash: string): Promise<PortalSessionContext | null> => {
    const session = sessions.get(tokenHash);
    return session
      ? {
          sessionId: randomUUID(),
          ...session,
          profile: {
            customer: { displayName: "Juan", status: "ACTIVE" },
            organization: { name: "Org" },
            bots: [],
            session: { idleExpiresAt: "", absoluteExpiresAt: "" }
          }
        }
      : null;
  });
  const owned = (tokenHash: string, deliveryId: string) => {
    const delivery = deliveries.get(deliveryId);
    return delivery && sessions.get(tokenHash)?.customerId === delivery.customerId ? delivery : null;
  };
  privileged.listPortalInbox.mockImplementation(async (tokenHash: string, filters: PortalInboxFilters) =>
    [...deliveries.entries()]
      .filter(([, delivery]) => delivery.customerId === sessions.get(tokenHash)?.customerId)
      .map(([id, delivery]) => item(id, delivery.detail.deliveredAt))
      .slice(0, filters.limit)
  );
  privileged.getPortalEmail.mockImplementation(async (tokenHash: string, deliveryId: string) => owned(tokenHash, deliveryId)?.detail ?? null);
  privileged.getPortalAttachment.mockImplementation(async (tokenHash: string, deliveryId: string, attachmentId: string) => {
    const delivery = owned(tokenHash, deliveryId);
    return delivery && delivery.attachment.id === attachmentId ? delivery.attachment : null;
  });
  privileged.createSignedDownloadUrl.mockImplementation(async (_bucket: string, path: string) => `https://storage.local/sign/${path}?token=t`);

  const get = (url: string, cookie?: string) => app.inject({ method: "GET", url, headers: cookie ? { cookie } : {} });
  return { ...context, sessions, cookieFor, get };
}

describe("portal inbox", () => {
  it("requires a portal session", async () => {
    const { get, privileged } = await setup();
    expect((await get("/api/portal/inbox")).statusCode).toBe(401);
    expect((await get("/api/portal/inbox", `${PORTAL_SESSION_COOKIE}=${generateSessionToken()}`)).statusCode).toBe(401);
    expect(privileged.listPortalInbox).not.toHaveBeenCalled();
  });

  it("lists only the session customer's deliveries; the function receives the token hash, never ids", async () => {
    const { get, cookieFor, privileged } = await setup();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    const response = await get(`/api/portal/inbox?customerId=${CUSTOMER_B}&organizationId=${ORG_B}&botId=${randomUUID()}`, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((entry: PortalInboxItem) => entry.deliveryId)).toEqual([DELIVERY_A]);
    const [tokenHash, filters] = privileged.listPortalInbox.mock.calls[0] as [string, PortalInboxFilters];
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(filters)).not.toContain(CUSTOMER_B);
    expect(JSON.stringify(filters)).not.toContain(ORG_B);
    expect(Object.keys(filters).sort()).toEqual(["before", "bot", "category", "from", "important", "limit", "search", "to", "unread"].sort());
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("filters are parsed and validated; they never carry authority", async () => {
    const { get, cookieFor, privileged } = await setup();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    await get("/api/portal/inbox?bot=netflix&category=codes&unread=true&important=false&search=c%C3%B3digo&from=2026-10-01T00:00:00Z&limit=10", cookie);
    expect(privileged.listPortalInbox.mock.calls[0]?.[1]).toEqual({
      limit: 11,
      before: null,
      bot: "netflix",
      category: "codes",
      unread: true,
      important: false,
      from: "2026-10-01T00:00:00Z",
      to: undefined,
      search: "código"
    });
    for (const query of ["bot=Not%20A%20Slug", "unread=yes", "limit=51", "limit=0", "from=yesterday", `search=${"x".repeat(101)}`]) {
      expect((await get(`/api/portal/inbox?${query}`, cookie)).statusCode, query).toBe(400);
    }
  });

  it("keyset pagination: asks for limit + 1, returns an opaque nextCursor and decodes it back", async () => {
    const { get, cookieFor, privileged } = await setup();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    privileged.listPortalInbox.mockResolvedValueOnce([item(DELIVERY_A, "2026-10-05T10:00:00.000Z"), item(DELIVERY_B, "2026-10-05T09:00:00.000Z")]);
    const first = await get("/api/portal/inbox?limit=1", cookie);
    expect(first.json().items).toHaveLength(1);
    const cursor = first.json().nextCursor as string;
    expect(decodeCursor(cursor)).toEqual({ receivedAt: "2026-10-05T10:00:00.000Z", deliveryId: DELIVERY_A });
    expect(cursor).not.toContain(DELIVERY_A);

    await get(`/api/portal/inbox?limit=1&cursor=${cursor}`, cookie);
    expect(privileged.listPortalInbox.mock.calls[1]?.[1]).toMatchObject({ limit: 2, before: { receivedAt: "2026-10-05T10:00:00.000Z", deliveryId: DELIVERY_A } });
    expect((await get("/api/portal/inbox?cursor=garbage", cookie)).json().error.code).toBe("INVALID_CURSOR");
    const forged = Buffer.from(JSON.stringify({ d: "x", i: "y" })).toString("base64url");
    expect((await get(`/api/portal/inbox?cursor=${forged}`, cookie)).statusCode).toBe(400);
    expect(encodeCursor("2026-10-05T10:00:00.000Z", DELIVERY_A)).toBe(cursor);
  });
});

describe("portal filters", () => {
  it("returns the session customer's bots and categories (names and slugs only); 401 without a session", async () => {
    const { get, cookieFor, privileged } = await setup();
    privileged.listPortalFilters.mockResolvedValue({ bots: [{ name: "Netflix", slug: "netflix" }], categories: [{ name: "Códigos", slug: "codigos" }] });
    expect((await get("/api/portal/filters")).statusCode).toBe(401);
    const response = await get(`/api/portal/filters?customerId=${CUSTOMER_B}`, cookieFor(CUSTOMER_A, ORG_A));
    expect(response.json()).toEqual({ bots: [{ name: "Netflix", slug: "netflix" }], categories: [{ name: "Códigos", slug: "codigos" }] });
    expect(privileged.listPortalFilters).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
  });
});

describe("portal email detail and attachments", () => {
  it("detail by delivery id; another customer's delivery is a generic 404", async () => {
    const { get, cookieFor } = await setup();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    const own = await get(`/api/portal/email/${DELIVERY_A}`, cookie);
    expect(own.statusCode).toBe(200);
    expect(own.json().email.deliveryId).toBe(DELIVERY_A);
    const foreign = await get(`/api/portal/email/${DELIVERY_B}`, cookie);
    const missing = await get(`/api/portal/email/${randomUUID()}`, cookie);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.message).toBe(missing.json().error.message);
    expect((await get(`/api/portal/email/${EMAIL_A}`, cookie)).statusCode).toBe(404);
    expect((await get("/api/portal/email/not-a-uuid", cookie)).statusCode).toBe(400);
  });

  it("signed URL only for the authorized attachment, at the expected location, short-lived", async () => {
    const { get, cookieFor, privileged } = await setup();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    const response = await get(`/api/portal/email/${DELIVERY_A}/attachments/${ATTACHMENT_A}`, cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: expect.stringContaining(`${ORG_A}/${EMAIL_A}/${ATTACHMENT_A}/factura.pdf`), expiresIn: expect.any(Number) });
    expect(response.json().expiresIn).toBeLessThanOrEqual(300);
    expect(privileged.createSignedDownloadUrl).toHaveBeenCalledWith("email-attachments", `${ORG_A}/${EMAIL_A}/${ATTACHMENT_A}/factura.pdf`, expect.any(Number), "factura.pdf");

    expect((await get(`/api/portal/email/${DELIVERY_B}/attachments/${ATTACHMENT_A}`, cookie)).statusCode).toBe(404);
    expect((await get(`/api/portal/email/${DELIVERY_A}/attachments/${randomUUID()}`, cookie)).statusCode).toBe(404);
    expect(privileged.createSignedDownloadUrl).toHaveBeenCalledTimes(1);
  });

  it("refuses to sign a location that is not the worker's path for that attachment", async () => {
    const { get, cookieFor, privileged } = await setup();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    privileged.getPortalAttachment.mockResolvedValueOnce({
      id: ATTACHMENT_A,
      emailId: EMAIL_A,
      organizationId: ORG_A,
      filename: "x.pdf",
      contentType: null,
      storageBucket: "email-attachments",
      storagePath: `${ORG_B}/other/${ATTACHMENT_A}/x.pdf`
    });
    expect((await get(`/api/portal/email/${DELIVERY_A}/attachments/${ATTACHMENT_A}`, cookie)).statusCode).toBe(404);
    expect(privileged.createSignedDownloadUrl).not.toHaveBeenCalled();
  });

  it("suspended customer / organization or a revoked session: every portal data endpoint is 401", async () => {
    const { get, cookieFor, sessions, privileged } = await setup();
    const cookie = cookieFor(CUSTOMER_A, ORG_A);
    sessions.clear(); // validate_session returns nothing for suspended / revoked / expired
    for (const url of ["/api/portal/inbox", `/api/portal/email/${DELIVERY_A}`, `/api/portal/email/${DELIVERY_A}/attachments/${ATTACHMENT_A}`]) {
      expect((await get(url, cookie)).statusCode, url).toBe(401);
    }
    expect(privileged.listPortalInbox).not.toHaveBeenCalled();
    expect(privileged.getPortalEmail).not.toHaveBeenCalled();
    expect(privileged.getPortalAttachment).not.toHaveBeenCalled();
  });
});

describe("manual deliveries (admin API)", () => {
  const EMAIL = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee9";
  const CUSTOMER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9";
  const DELIVERY = "dddddddd-dddd-4ddd-8ddd-ddddddddddd9";
  const BOT = "88888888-8888-4888-8888-888888888888";
  const delivery = (overrides: Partial<EmailDelivery> = {}): EmailDelivery => ({
    id: DELIVERY,
    emailId: EMAIL,
    customerId: CUSTOMER,
    botId: BOT,
    resolution: "MANUAL",
    createdBy: null,
    createdAt: "2026-10-05T00:00:00.000Z",
    removedAt: null,
    removedBy: null,
    customerReadAt: null,
    ...overrides
  });

  async function admin() {
    const operator = makeUser({ [ORG_A]: "OPERATOR" });
    const viewer = makeUser({ [ORG_A]: "VIEWER" });
    const ownerB = makeUser({ [ORG_B]: "OWNER" });
    const context = await createTestApp({ users: [operator, viewer, ownerB] });
    const { repos } = context;
    repos.emails.get.mockImplementation(async (organizationId: string, id: string) => (organizationId === ORG_A && id === EMAIL ? { id } : null));
    repos.customers.get.mockImplementation(async (organizationId: string, id: string) => (organizationId === ORG_A && id === CUSTOMER ? { id } : null));
    repos.emailDeliveries.get.mockImplementation(async (organizationId: string, emailId: string, id: string) =>
      organizationId === ORG_A && emailId === EMAIL && id === DELIVERY ? delivery() : null
    );
    repos.emailDeliveries.list.mockResolvedValue([delivery()]);
    repos.emailDeliveries.addManual.mockResolvedValue({ deliveryId: DELIVERY, outcome: "CREATED", botId: BOT, resolution: "MANUAL" });
    repos.emailDeliveries.removeManual.mockResolvedValue({ removed: true, emailId: EMAIL, customerId: CUSTOMER, botId: BOT });
    return { ...context, operator, viewer, ownerB };
  }

  it("OPERATOR adds a MANUAL delivery: organization from the session, audited with ids only", async () => {
    const { app, operator, repos, privileged } = await admin();
    const response = await app.inject({ method: "POST", url: `/api/emails/${EMAIL}/deliveries`, headers: authHeaders(operator, ORG_A), payload: { customerId: CUSTOMER } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ outcome: "CREATED", delivery: { id: DELIVERY, resolution: "MANUAL" } });
    expect(repos.emailDeliveries.addManual).toHaveBeenCalledWith(EMAIL, CUSTOMER);
    expect(privileged.insertAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_A,
        actorUserId: operator.id,
        action: "CREATE",
        entityType: "email_delivery",
        metadata: { event: "delivery.created.manual", emailId: EMAIL, deliveryId: DELIVERY, customerId: CUSTOMER, botId: BOT, reactivated: false }
      })
    );
  });

  it("an existing delivery is not duplicated (200, no audit); a reactivation is audited", async () => {
    const { app, operator, repos, privileged } = await admin();
    repos.emailDeliveries.addManual.mockResolvedValueOnce({ deliveryId: DELIVERY, outcome: "EXISTING", botId: BOT, resolution: "AUTOMATIC" });
    const existing = await app.inject({ method: "POST", url: `/api/emails/${EMAIL}/deliveries`, headers: authHeaders(operator, ORG_A), payload: { customerId: CUSTOMER } });
    expect(existing.statusCode).toBe(200);
    expect(privileged.insertAuditLog).not.toHaveBeenCalled();
    repos.emailDeliveries.addManual.mockResolvedValueOnce({ deliveryId: DELIVERY, outcome: "REACTIVATED", botId: BOT, resolution: "MANUAL" });
    await app.inject({ method: "POST", url: `/api/emails/${EMAIL}/deliveries`, headers: authHeaders(operator, ORG_A), payload: { customerId: CUSTOMER } });
    expect(privileged.insertAuditLog.mock.calls[0]?.[0]).toMatchObject({ metadata: { reactivated: true } });
  });

  it("removal: MANUAL soft removal audited; already removed is not audited again", async () => {
    const { app, operator, repos, privileged } = await admin();
    const removed = await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL}/deliveries/${DELIVERY}`, headers: authHeaders(operator, ORG_A) });
    expect(removed.json()).toEqual({ removed: true });
    expect(privileged.insertAuditLog.mock.calls[0]?.[0]).toMatchObject({ metadata: { event: "delivery.removed.manual", deliveryId: DELIVERY } });
    repos.emailDeliveries.removeManual.mockResolvedValueOnce({ removed: false, emailId: EMAIL, customerId: CUSTOMER, botId: BOT });
    await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL}/deliveries/${DELIVERY}`, headers: authHeaders(operator, ORG_A) });
    expect(privileged.insertAuditLog).toHaveBeenCalledTimes(1);
  });

  it("VIEWER reads the deliveries of an email but cannot add or remove", async () => {
    const { app, viewer, repos } = await admin();
    expect((await app.inject({ method: "GET", url: `/api/emails/${EMAIL}/deliveries`, headers: authHeaders(viewer, ORG_A) })).statusCode).toBe(200);
    const add = await app.inject({ method: "POST", url: `/api/emails/${EMAIL}/deliveries`, headers: authHeaders(viewer, ORG_A), payload: { customerId: CUSTOMER } });
    const remove = await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL}/deliveries/${DELIVERY}`, headers: authHeaders(viewer, ORG_A) });
    expect([add.json().error.code, remove.json().error.code]).toEqual(["INSUFFICIENT_ROLE", "INSUFFICIENT_ROLE"]);
    expect(repos.emailDeliveries.addManual).not.toHaveBeenCalled();
  });

  it("IDOR: email, customer and delivery of another organization are 404; organizationId in the body is rejected", async () => {
    const { app, operator, ownerB, repos } = await admin();
    const headers = authHeaders(operator, ORG_A);
    expect((await app.inject({ method: "POST", url: `/api/emails/${randomUUID()}/deliveries`, headers, payload: { customerId: CUSTOMER } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/emails/${EMAIL}/deliveries`, headers, payload: { customerId: CUSTOMER_B } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL}/deliveries/${randomUUID()}`, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/emails/${EMAIL}/deliveries`, headers, payload: { customerId: CUSTOMER, organizationId: ORG_B } })).statusCode).toBe(400);
    const fromB = authHeaders(ownerB, ORG_B);
    expect((await app.inject({ method: "GET", url: `/api/emails/${EMAIL}/deliveries`, headers: fromB })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/emails/${EMAIL}/deliveries`, headers: fromB, payload: { customerId: CUSTOMER } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/emails/${EMAIL}/deliveries/${DELIVERY}`, headers: fromB })).statusCode).toBe(404);
    expect(repos.emailDeliveries.addManual).not.toHaveBeenCalled();
    expect(repos.emailDeliveries.removeManual).not.toHaveBeenCalled();
  });

  it("database rule violations (bot paused, customer suspended, no assignment...) surface as 422 with the database message", async () => {
    const { app, operator, repos } = await admin();
    const { AppError } = await import("../lib/errors.js");
    repos.emailDeliveries.addManual.mockRejectedValueOnce(new AppError(422, "BUSINESS_RULE_VIOLATION", "Customer is not assigned to the bot"));
    const response = await app.inject({ method: "POST", url: `/api/emails/${EMAIL}/deliveries`, headers: authHeaders(operator, ORG_A), payload: { customerId: CUSTOMER } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toBe("Customer is not assigned to the bot");
  });

  it("the panel API keeps CORS without credentials", async () => {
    const { app } = await admin();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: `/api/emails/${EMAIL}/deliveries`,
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" }
    });
    expect(preflight.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});
