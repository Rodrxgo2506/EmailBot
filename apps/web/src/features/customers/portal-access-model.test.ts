import type { CustomerAccessCredential } from "@emailbot/types";
import { describe, expect, it } from "vitest";
import { accessState, expirationFromDays, generateLabel } from "./portal-access-model";

const credential = (overrides: Partial<CustomerAccessCredential> = {}): CustomerAccessCredential => ({
  id: "c1",
  customerId: "u1",
  displayPrefix: "SP",
  last4: "P4Z7",
  maskedAccessId: "SP-••••••••P4Z7",
  status: "ACTIVE",
  expiresAt: null,
  createdBy: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  revokedAt: null,
  revokedReason: null,
  ...overrides
});

describe("portal access model", () => {
  it("state: none, active, expired", () => {
    const now = Date.parse("2026-10-10T00:00:00.000Z");
    expect(accessState(null, now)).toBe("NONE");
    expect(accessState(credential({ status: "REVOKED" }), now)).toBe("NONE");
    expect(accessState(credential(), now)).toBe("ACTIVE");
    expect(accessState(credential({ expiresAt: "2026-10-11T00:00:00.000Z" }), now)).toBe("ACTIVE");
    expect(accessState(credential({ expiresAt: "2026-10-09T00:00:00.000Z" }), now)).toBe("EXPIRED");
  });

  it("generating again is labelled as a regeneration", () => {
    expect(generateLabel(null)).toBe("Generar Access ID");
    expect(generateLabel(credential())).toBe("Regenerar Access ID");
  });

  it("expiration in days (empty / invalid = never expires)", () => {
    const now = Date.parse("2026-10-04T00:00:00.000Z");
    expect(expirationFromDays("", now)).toBeNull();
    expect(expirationFromDays("0", now)).toBeNull();
    expect(expirationFromDays("1.5", now)).toBeNull();
    expect(expirationFromDays("30", now)).toBe("2026-11-03T00:00:00.000Z");
  });
});
