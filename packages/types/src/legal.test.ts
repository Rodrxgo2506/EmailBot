import { describe, expect, it } from "vitest";
import { CURRENT_LEGAL_VERSIONS, legalAcceptanceStatus } from "./legal.js";

describe("legalAcceptanceStatus", () => {
  const current = { terms: "2.0", privacy: "2.0" };

  it("accepted only when BOTH current versions are recorded", () => {
    expect(legalAcceptanceStatus([{ document: "terms", version: "2.0" }, { document: "privacy", version: "2.0" }], current).accepted).toBe(true);
    expect(legalAcceptanceStatus([{ document: "terms", version: "2.0" }], current).accepted).toBe(false);
    expect(legalAcceptanceStatus([], current).accepted).toBe(false);
  });

  it("an older version does not count (1.0 accepted, 2.0 current)", () => {
    expect(legalAcceptanceStatus([{ document: "terms", version: "1.0" }, { document: "privacy", version: "1.0" }], current).accepted).toBe(false);
  });

  it("publishing 2.1 asks users who accepted 2.0 again; once 2.1 is accepted they continue", () => {
    const records = [
      { document: "terms", version: "2.0" },
      { document: "privacy", version: "2.0" }
    ] as const;
    const next = { terms: "2.1", privacy: "2.0" };
    expect(legalAcceptanceStatus(records, next)).toEqual({ termsVersion: "2.1", privacyVersion: "2.0", accepted: false });
    expect(legalAcceptanceStatus([...records, { document: "terms", version: "2.1" }], next).accepted).toBe(true);
  });

  it("a version of the other document never counts", () => {
    expect(legalAcceptanceStatus([{ document: "terms", version: "2.0" }, { document: "terms", version: "2.0" }], current).accepted).toBe(false);
  });

  it("defaults to the current versions, which use the database's version format", () => {
    expect(legalAcceptanceStatus([]).termsVersion).toBe(CURRENT_LEGAL_VERSIONS.terms);
    for (const version of Object.values(CURRENT_LEGAL_VERSIONS)) expect(version).toMatch(/^[0-9]{1,3}\.[0-9]{1,3}$/);
    expect(Object.isFrozen(CURRENT_LEGAL_VERSIONS)).toBe(true);
  });
});
