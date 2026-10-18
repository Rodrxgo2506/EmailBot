import { describe, expect, it } from "vitest";
import { IMAP_TRIAL_ORGANIZATION_IDS, imapAllowedForOrganization, imapOrganizationAllowlist } from "./imap-activation.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("IMAP trial allowlist", () => {
  it("is empty and frozen until the test organization is confirmed in code", () => {
    expect(IMAP_TRIAL_ORGANIZATION_IDS).toEqual([]);
    expect(Object.isFrozen(IMAP_TRIAL_ORGANIZATION_IDS)).toBe(true);
    expect(imapOrganizationAllowlist(IMAP_TRIAL_ORGANIZATION_IDS)).toEqual([]);
  });

  it("validation: lower-case organization UUIDs only, no duplicates; the result is a frozen copy", () => {
    const list = imapOrganizationAllowlist([A, B]);
    expect(list).toEqual([A, B]);
    expect(Object.isFrozen(list)).toBe(true);
    for (const bad of [[B.toUpperCase()], ["not-a-uuid"], [""], [` ${A}`], [`${A},${B}`], ["*"], [A, A]]) {
      expect(() => imapOrganizationAllowlist(bad), JSON.stringify(bad)).toThrow(/IMAP organization allowlist/);
    }
  });

  it("decision: IMAP on (exactly true) AND a listed, well-formed organization; everything else is false", () => {
    expect(imapAllowedForOrganization(true, [A], A)).toBe(true);
    const refused: Array<[unknown, unknown, unknown]> = [
      [false, [A], A],
      [undefined, [A], A],
      ["true", [A], A],
      [1, [A], A],
      [true, [], A],
      [true, undefined, A],
      [true, [A], B],
      [true, [A], null],
      [true, [A], undefined],
      [true, [A], ""],
      [true, [A], 42],
      [true, [B], B.toUpperCase()],
      [true, ["*"], A]
    ];
    for (const [enabled, list, organization] of refused) {
      expect(
        imapAllowedForOrganization(enabled as boolean | undefined, list as readonly string[] | undefined, organization),
        JSON.stringify([enabled, list, organization])
      ).toBe(false);
    }
  });
});
