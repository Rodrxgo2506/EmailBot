import { afterEach, describe, expect, it } from "vitest";
import { toRule } from "../repositories/supabase/mappers.js";
import { authHeaders, createTestApp, makeUser, ORG_A } from "./helpers.js";

/* EmailBot V2 phase 7: the never-implemented "email" notification channel is not accepted by the rules API. */

const admin = makeUser({ [ORG_A]: "ADMIN" });
const rule = (actions: unknown[]) => ({
  name: "Codes",
  conditions: [{ field: "sender", operator: "contains", value: "example.com" }],
  actions
});

let ctx: Awaited<ReturnType<typeof createTestApp>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  ctx = undefined;
});

describe("rules API: notification channel", () => {
  it("rejects an email NOTIFY on create and on update; nothing is written", async () => {
    ctx = await createTestApp({ users: [admin] });
    const headers = authHeaders(admin, ORG_A);
    const created = await ctx.app.inject({ method: "POST", url: "/api/rules", headers, payload: rule([{ type: "NOTIFY", channel: "email" }]) });
    expect(created.statusCode).toBe(400);
    expect(created.json().error.code).toBe("VALIDATION_ERROR");
    const updated = await ctx.app.inject({
      method: "PATCH",
      url: "/api/rules/11111111-2222-4333-8444-555555555555",
      headers,
      payload: { actions: [{ type: "NOTIFY", channel: "email" }] }
    });
    expect(updated.statusCode).toBe(400);
    expect(ctx.repos.rules.create).not.toHaveBeenCalled();
    expect(ctx.repos.rules.update).not.toHaveBeenCalled();
  });

  it("accepts an in-app NOTIFY (the default channel)", async () => {
    ctx = await createTestApp({ users: [admin] });
    ctx.repos.rules.create.mockResolvedValue({ id: "r1", name: "Codes" });
    const response = await ctx.app.inject({ method: "POST", url: "/api/rules", headers: authHeaders(admin, ORG_A), payload: rule([{ type: "NOTIFY" }]) });
    expect(response.statusCode).toBe(201);
    expect(ctx.repos.rules.create.mock.calls[0]?.[2]).toMatchObject({ actions: [{ type: "NOTIFY", channel: "in_app" }] });
  });

  it("a rule stored with the removed channel is returned without that action (the rest is kept)", () => {
    const stored = toRule({
      id: "r1",
      organization_id: ORG_A,
      category_id: null,
      bot_id: null,
      name: "Legacy",
      description: null,
      enabled: true,
      priority: 10,
      stop_processing: false,
      match_mode: "AND",
      conditions: { conditions: [{ field: "sender", operator: "contains", value: "example.com" }] },
      actions: { actions: [{ type: "MARK_IMPORTANT" }, { type: "NOTIFY", channel: "email" }] },
      created_by: null,
      updated_by: null,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: "2026-10-01T00:00:00.000Z"
    });
    expect(stored.actions).toEqual([{ type: "MARK_IMPORTANT" }]);
    expect(stored.conditions).toHaveLength(1);
  });
});
