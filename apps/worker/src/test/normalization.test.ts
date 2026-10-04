import { describe, expect, it } from "vitest";
import { isStorableAddress, parseAddressList } from "../providers/address.js";
import { normalizeGmailMessage } from "../providers/gmail/normalize.js";
import { normalizeGraphMessage } from "../providers/microsoft/normalize.js";

const b64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");

describe("address parsing", () => {
  it("handles quoted names with commas, bare addresses and case", () => {
    expect(parseAddressList('"Doe, John" <John@Example.com>, other@y.com, Team <team@z.io>')).toEqual([
      { address: "john@example.com", name: "Doe, John" },
      { address: "other@y.com", name: null },
      { address: "team@z.io", name: "Team" }
    ]);
    expect(parseAddressList(undefined)).toEqual([]);
  });

  it("validates addresses like the database constraint", () => {
    expect(isStorableAddress("a@b.co")).toBe(true);
    expect(isStorableAddress("MAILER-DAEMON")).toBe(false);
  });
});

describe("Gmail normalization", () => {
  const message = {
    id: "18c0ffee",
    threadId: "thread-1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Tu código es 4821",
    internalDate: "1790000000000",
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: "Servicio Streaming <Info@Account.Streaming.example>" },
        { name: "To", value: "me@gmail.com" },
        { name: "Cc", value: '"Boss, The" <boss@example.com>' },
        { name: "Subject", value: "Tu código temporal" },
        { name: "Message-ID", value: "<abc@mail.example>" },
        { name: "Date", value: "Wed, 23 Sep 2026 10:00:00 +0000" },
        { name: "Received", value: "hop 1" },
        { name: "Received", value: "hop 2" }
      ],
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Tu código es 4821 ✓") } },
            { mimeType: "text/html", body: { data: b64url("<p>Tu código es <b>4821</b></p>") } }
          ]
        },
        {
          mimeType: "application/pdf",
          filename: "factura.pdf",
          headers: [{ name: "Content-Disposition", value: "attachment; filename=factura.pdf" }],
          body: { size: 1234, attachmentId: "att-1" }
        },
        {
          mimeType: "image/png",
          filename: "logo.png",
          headers: [
            { name: "Content-Disposition", value: "inline" },
            { name: "Content-ID", value: "<logo@x>" }
          ],
          body: { size: 50, attachmentId: "att-2" }
        }
      ]
    }
  };

  it("maps headers, bodies, recipients and attachments", () => {
    const email = normalizeGmailMessage(message, "account-1");

    expect(email).toMatchObject({
      provider: "GMAIL",
      providerMessageId: "18c0ffee",
      threadId: "thread-1",
      internetMessageId: "<abc@mail.example>",
      accountId: "account-1",
      direction: "INBOUND",
      sender: { address: "info@account.streaming.example", name: "Servicio Streaming" },
      recipients: [{ address: "me@gmail.com", name: null }],
      cc: [{ address: "boss@example.com", name: "Boss, The" }],
      subject: "Tu código temporal",
      textBody: "Tu código es 4821 ✓",
      htmlBody: "<p>Tu código es <b>4821</b></p>",
      receivedAt: new Date(1790000000000).toISOString(),
      sentAt: "2026-09-23T10:00:00.000Z"
    });
    expect(email.headers.received).toBe("hop 1, hop 2");
    expect(email.attachments).toEqual([
      {
        providerAttachmentId: "att-1",
        filename: "factura.pdf",
        contentType: "application/pdf",
        size: 1234,
        contentId: null,
        isInline: false
      },
      {
        providerAttachmentId: "att-2",
        filename: "logo.png",
        contentType: "image/png",
        size: 50,
        contentId: "logo@x",
        isInline: true
      }
    ]);
  });

  it("marks sent mail as outbound and rejects malformed payloads", () => {
    expect(normalizeGmailMessage({ ...message, labelIds: ["SENT"] }, "a").direction).toBe("OUTBOUND");
    expect(() => normalizeGmailMessage({ nope: true }, "a")).toThrow();
  });
});

describe("Microsoft Graph normalization", () => {
  it("maps the Graph message resource into the same structure", () => {
    const email = normalizeGraphMessage(
      {
        id: "AAMkAD=",
        conversationId: "conv-1",
        internetMessageId: "<x@outlook.com>",
        subject: "Your security code",
        bodyPreview: "Use 123456",
        body: { contentType: "html", content: "<p>Use <b>123456</b></p>" },
        from: { emailAddress: { address: "No-Reply@Bank.example", name: "Bank" } },
        toRecipients: [{ emailAddress: { address: "me@outlook.com", name: "Me" } }],
        ccRecipients: [],
        receivedDateTime: "2026-10-02T12:00:00Z",
        sentDateTime: "2026-10-02T11:59:58Z",
        internetMessageHeaders: [{ name: "List-Id", value: "bank" }],
        attachments: [{ id: "att", name: "statement.pdf", contentType: "application/pdf", size: 10, isInline: false }]
      },
      "account-2"
    );

    expect(email).toMatchObject({
      provider: "MICROSOFT",
      providerMessageId: "AAMkAD=",
      threadId: "conv-1",
      sender: { address: "no-reply@bank.example", name: "Bank" },
      recipients: [{ address: "me@outlook.com", name: "Me" }],
      textBody: null,
      htmlBody: "<p>Use <b>123456</b></p>",
      receivedAt: "2026-10-02T12:00:00.000Z",
      headers: { "list-id": "bank" }
    });
    expect(email.attachments[0]).toMatchObject({ providerAttachmentId: "att", filename: "statement.pdf" });
  });
});
