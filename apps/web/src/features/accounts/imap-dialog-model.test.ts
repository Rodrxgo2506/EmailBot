import { imapAccountCreateSchema } from "@emailbot/validation";
import { describe, expect, it } from "vitest";
import { imapAccountPayload, imapSecurityForPort, type ImapDialogValues } from "./imap-dialog-model";

/*
 * IMAP M1.7 (D1): the dialog's body against the REAL schema of the API route (imapAccountCreateSchema,
 * @emailbot/validation, strict: unknown keys are refused). Test-only values, never a real login.
 */

const values = (overrides: Partial<ImapDialogValues> = {}): ImapDialogValues => ({
  emailAddress: "ventas@acme-mail.com",
  displayName: "",
  host: "imap.acme-mail.com",
  port: 993,
  username: "ventas@acme-mail.com",
  password: "clave-de-prueba-m17",
  ...overrides
});

describe("imapAccountPayload against the API's real imapAccountCreateSchema", () => {
  it.each([
    ["new account", 993, "TLS"],
    ["new account", 143, "STARTTLS"],
    ["reconnection (same address)", 993, "TLS"],
    ["reconnection (same address)", 143, "STARTTLS"]
  ] as const)("%s, port %i: security %s, accepted by the real schema", (_mode, port, security) => {
    const payload = imapAccountPayload(values({ port }));
    expect(payload.security).toBe(security);
    expect(payload).not.toHaveProperty("secure");
    const parsed = imapAccountCreateSchema.safeParse(JSON.parse(JSON.stringify(payload)));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data).toMatchObject({ emailAddress: "ventas@acme-mail.com", port, security });
  });

  it("sends exactly the schema's fields: nothing unknown, no empty display name", () => {
    expect(Object.keys(imapAccountPayload(values())).sort()).toEqual(["emailAddress", "host", "password", "port", "security", "username"]);
    const named = imapAccountPayload(values({ displayName: "  Ventas  " }));
    expect(Object.keys(named).sort()).toEqual(["displayName", "emailAddress", "host", "password", "port", "security", "username"]);
    expect(named.displayName).toBe("Ventas");
    expect(imapAccountCreateSchema.safeParse(named).success).toBe(true);
  });

  it("the old body (secure: true, no security) is refused by the strict schema", () => {
    const old = { emailAddress: "ventas@acme-mail.com", host: "imap.acme-mail.com", port: 993, secure: true, username: "ventas@acme-mail.com", password: "clave-de-prueba-m17" };
    const parsed = imapAccountCreateSchema.safeParse(old);
    expect(parsed.success).toBe(false);
    const issues = parsed.error!.issues.map((issue) => issue.code);
    expect(issues).toContain("unrecognized_keys");
    expect(issues).toContain("invalid_value");
  });

  it("only 993 -> TLS and 143 -> STARTTLS: any other port has no transport (never plaintext) and builds nothing", () => {
    expect(imapSecurityForPort(993)).toBe("TLS");
    expect(imapSecurityForPort(143)).toBe("STARTTLS");
    for (const port of [0, 110, 465, 587, 995, 1143, 65535]) {
      expect(imapSecurityForPort(port)).toBeNull();
      expect(() => imapAccountPayload(values({ port }))).toThrow(/993.*143/);
    }
    // The schema agrees: a mismatched port / security pair is refused too.
    expect(imapAccountCreateSchema.safeParse({ ...imapAccountPayload(values()), port: 143 }).success).toBe(false);
  });
});
