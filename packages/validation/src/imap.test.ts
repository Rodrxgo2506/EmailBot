import { describe, expect, it } from "vitest";
import { imapAccountCreateSchema, imapEndpointSchema } from "./index.js";

/* IMAP settings accepted by the API (E1): encrypted transports only, public host names only. */

const valid = {
  emailAddress: "ventas@example-mail.com",
  host: "imap.hostinger.com",
  port: 993,
  security: "TLS",
  username: "ventas@example-mail.com",
  password: "app-password"
};

describe("imapAccountCreateSchema", () => {
  it("993 + TLS and 143 + STARTTLS are accepted; the host is normalized", () => {
    expect(imapAccountCreateSchema.parse({ ...valid, host: "  IMAP.Hostinger.COM. " }).host).toBe("imap.hostinger.com");
    expect(imapAccountCreateSchema.safeParse({ ...valid, port: 143, security: "STARTTLS" }).success).toBe(true);
  });

  it.each([
    [{ port: 993, security: "STARTTLS" }],
    [{ port: 143, security: "TLS" }],
    [{ port: 995, security: "TLS" }],
    [{ port: 25, security: "STARTTLS" }],
    [{ port: 993, security: "NONE" }],
    [{ port: 143, security: "PLAIN" }],
    [{ port: "993", security: "TLS" }],
    [{ security: "TLS" }],
    [{ port: 993 }]
  ])("inconsistent or plaintext transport is refused: %j", (transport) => {
    const { port: _port, security: _security, ...rest } = valid;
    void _port;
    void _security;
    expect(imapAccountCreateSchema.safeParse({ ...rest, ...transport }).success).toBe(false);
  });

  it("the old boolean `secure` and any certificate option are refused (strict object)", () => {
    expect(imapAccountCreateSchema.safeParse({ ...valid, secure: false }).success).toBe(false);
    expect(imapAccountCreateSchema.safeParse({ ...valid, rejectUnauthorized: false }).success).toBe(false);
    expect(imapAccountCreateSchema.safeParse({ ...valid, tls: { rejectUnauthorized: false } }).success).toBe(false);
    expect(imapAccountCreateSchema.safeParse({ ...valid, proxy: "socks5://127.0.0.1:1080" }).success).toBe(false);
  });

  it.each(["localhost", "127.0.0.1", "10.0.0.2", "169.254.169.254", "[::1]", "::1", "mail", "mail.internal", "nas.local", "imap.exämple.com", "imap_x.example.com", ""])(
    "host %j is refused",
    (host) => {
      expect(imapAccountCreateSchema.safeParse({ ...valid, host }).success).toBe(false);
    }
  );

  it("the password is required and bounded", () => {
    expect(imapAccountCreateSchema.safeParse({ ...valid, password: "" }).success).toBe(false);
    expect(imapAccountCreateSchema.safeParse({ ...valid, password: "x".repeat(1001) }).success).toBe(false);
  });
});

describe("imapEndpointSchema", () => {
  it("same rules for an endpoint alone (future test-connection request)", () => {
    expect(imapEndpointSchema.safeParse({ host: "imappro.zoho.com", port: 993, security: "TLS" }).success).toBe(true);
    expect(imapEndpointSchema.safeParse({ host: "imappro.zoho.com", port: 143, security: "TLS" }).success).toBe(false);
    expect(imapEndpointSchema.safeParse({ host: "192.168.1.1", port: 993, security: "TLS" }).success).toBe(false);
  });
});
