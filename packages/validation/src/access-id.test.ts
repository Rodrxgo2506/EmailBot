import { describe, expect, it } from "vitest";
import {
  ACCESS_ID_SECRET_LENGTH,
  CROCKFORD_ALPHABET,
  customerAccessIssueSchema,
  formatAccessId,
  maskAccessId,
  normalizeAccessId,
  portalLoginSchema
} from "./index.js";

/* EmailBot V2 phase 4: THE Access ID normalizer (API login, admin UI, tests). */

describe("normalizeAccessId", () => {
  it.each([
    ["SP-7KQ9X82MP4Z7", "7KQ9X82MP4Z7"],
    ["sp-7kq9x82mp4z7", "7KQ9X82MP4Z7"],
    ["  SP 7KQ9 X82M P4Z7 ", "7KQ9X82MP4Z7"],
    ["7KQ9-X82M-P4Z7", "7KQ9X82MP4Z7"],
    ["7kq9x82mp4z7", "7KQ9X82MP4Z7"],
    ["ACME1-7KQ9X82MP4Z7", "7KQ9X82MP4Z7"],
    ["SP7KQ9X82MP4Z7", "7KQ9X82MP4Z7"],
    ["SP-ABCD-EFGH-JKMN", "ABCDEFGHJKMN"]
  ])("%j -> %s (case, spaces, hyphens and prefix removed)", (input, expected) => {
    expect(normalizeAccessId(input)).toBe(expected);
  });

  it("maps Crockford confusions: O -> 0, I and L -> 1 (only in the secret)", () => {
    expect(normalizeAccessId("SP-OKQ9X82MPIZL")).toBe("0KQ9X82MP1Z1");
    expect(normalizeAccessId("sp-7kq9x82mp4l7")).toBe("7KQ9X82MP417");
  });

  it("the prefix is cosmetic: any valid prefix (or none) gives the same secret", () => {
    const secrets = ["SP-7KQ9X82MP4Z7", "XY-7KQ9X82MP4Z7", "7KQ9X82MP4Z7"].map(normalizeAccessId);
    expect(new Set(secrets).size).toBe(1);
  });

  it("composed and full-width characters are normalized (NFKC)", () => {
    expect(normalizeAccessId("ＳＰ－７ＫＱ９Ｘ８２ＭＰ４Ｚ７")).toBe("7KQ9X82MP4Z7");
  });

  it.each([
    [""],
    ["SP-"],
    ["SP-7KQ9X82MP4Z"], // 11 characters: never re-split into another secret
    ["SP-7KQ9X82MP4Z77"], // 13 characters
    ["SP-7KQ9X82MP4ZU"], // U is not Crockford
    ["SP-7KQ9X82MP4Z!"],
    ["1SP-7KQ9X82MP4Z7"], // prefix must start with a letter
    ["TOOLONGPREFIX-7KQ9X82MP4Z7"],
    ["x".repeat(65)]
  ])("%j is rejected", (input) => {
    expect(normalizeAccessId(input)).toBeNull();
  });
});

describe("Access ID display and request schemas", () => {
  it("formats and masks", () => {
    expect(formatAccessId("SP", "7KQ9X82MP4Z7")).toBe("SP-7KQ9X82MP4Z7");
    expect(maskAccessId("SP", "P4Z7")).toBe("SP-••••••••P4Z7");
  });

  it("alphabet: 32 Crockford symbols, 12 characters = 60 bits", () => {
    expect(CROCKFORD_ALPHABET).toHaveLength(32);
    expect(CROCKFORD_ALPHABET).not.toMatch(/[ILOU]/);
    expect(ACCESS_ID_SECRET_LENGTH * Math.log2(CROCKFORD_ALPHABET.length)).toBe(60);
  });

  it("the login body accepts only the Access ID (no customer / organization authority)", () => {
    expect(portalLoginSchema.safeParse({ accessId: "SP-7KQ9X82MP4Z7" }).success).toBe(true);
    expect(portalLoginSchema.safeParse({ accessId: "SP-7KQ9X82MP4Z7", customerId: "x" }).success).toBe(false);
    expect(portalLoginSchema.safeParse({ accessId: "SP-7KQ9X82MP4Z7", organizationId: "x" }).success).toBe(false);
  });

  it("issue body: optional ISO expiration only", () => {
    expect(customerAccessIssueSchema.safeParse({}).success).toBe(true);
    expect(customerAccessIssueSchema.safeParse({ expiresAt: null }).success).toBe(true);
    expect(customerAccessIssueSchema.safeParse({ expiresAt: "2027-01-01T00:00:00Z" }).success).toBe(true);
    expect(customerAccessIssueSchema.safeParse({ expiresAt: "tomorrow" }).success).toBe(false);
    expect(customerAccessIssueSchema.safeParse({ secretHash: "x" }).success).toBe(false);
  });
});
