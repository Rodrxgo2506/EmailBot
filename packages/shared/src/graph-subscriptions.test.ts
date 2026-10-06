import { describe, expect, it } from "vitest";
import {
  clientStateMatches,
  generateClientState,
  graphLifecycleUrl,
  graphSubscriptionUrl,
  hashClientState,
  isGraphSubscriptionId,
  readMicrosoftSubscription,
  subscriptionLogId,
  withMicrosoftSubscription
} from "./graph-subscriptions.js";

const SUB = "11111111-2222-4333-8444-555555555555";

describe("Graph subscription helpers (F9)", () => {
  it("clientState: random, 256-bit, URL-safe; only its hash is compared (constant time)", () => {
    const a = generateClientState();
    const b = generateClientState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = hashClientState(a);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(clientStateMatches(a, stored)).toBe(true);
    expect(clientStateMatches(b, stored)).toBe(false);
    expect(clientStateMatches(undefined, stored)).toBe(false);
    expect(clientStateMatches("", stored)).toBe(false);
    expect(clientStateMatches(a, null)).toBe(false);
    expect(clientStateMatches(a, a)).toBe(false);
  });

  it("subscription ids must be GUIDs before they reach a URL", () => {
    expect(isGraphSubscriptionId(SUB)).toBe(true);
    expect(isGraphSubscriptionId("../me/messages")).toBe(false);
    expect(graphSubscriptionUrl(SUB)).toBe(`https://graph.microsoft.com/v1.0/subscriptions/${SUB}`);
    expect(() => graphSubscriptionUrl("x/y")).toThrow();
  });

  it("lifecycle URL = notification URL + /lifecycle", () => {
    expect(graphLifecycleUrl("https://api.example.test/webhooks/microsoft")).toBe("https://api.example.test/webhooks/microsoft/lifecycle");
    expect(graphLifecycleUrl("https://api.example.test/webhooks/microsoft/")).toBe("https://api.example.test/webhooks/microsoft/lifecycle");
  });

  it("provider_metadata: subscription keys set / removed, other keys kept", () => {
    const stored = withMicrosoftSubscription({ keep: 1 }, { id: SUB, clientStateHash: hashClientState("s") });
    expect(stored).toEqual({ keep: 1, subscriptionId: SUB, subscriptionClientStateHash: hashClientState("s") });
    expect(readMicrosoftSubscription(stored)).toEqual({ id: SUB, clientStateHash: hashClientState("s") });
    expect(withMicrosoftSubscription(stored, null)).toEqual({ keep: 1 });
    expect(readMicrosoftSubscription({ subscriptionId: "not-a-guid", subscriptionClientStateHash: "h" })).toBeNull();
    expect(readMicrosoftSubscription(null)).toBeNull();
  });

  it("log label is a short non-reversible hash", () => {
    expect(subscriptionLogId(SUB)).toMatch(/^[0-9a-f]{12}$/);
    expect(subscriptionLogId(SUB)).not.toContain(SUB.slice(0, 8));
  });
});
