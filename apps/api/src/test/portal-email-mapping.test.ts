import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { portalDataOperations } from "../repositories/supabase/delivery-repositories.js";

/*
 * portal.get_email -> PortalEmailDetail: the body built by the database
 * function (only when the bot's showBody is on) reaches the API untouched.
 */

const DELIVERY = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";

function serviceReturning(detail: Record<string, unknown> | null) {
  const rpc = vi.fn(async () => ({ data: detail, error: null }));
  const schema = vi.fn(() => ({ rpc }));
  return { service: { schema } as unknown as SupabaseClient, schema, rpc };
}

function detail(body: unknown) {
  return {
    deliveryId: DELIVERY,
    deliveredAt: "2026-10-05T10:00:00.000Z",
    receivedAt: "2026-10-05T09:59:00.000Z",
    subject: "Tu código de acceso",
    sender: { email: "info@netflix.example", name: "Netflix" },
    bot: { name: "Netflix", slug: "netflix" },
    category: null,
    important: false,
    read: true,
    fields: [],
    body,
    attachments: null
  };
}

describe("portal email detail mapping", () => {
  it("calls portal.get_email with the token hash and delivery id only", async () => {
    const { service, schema, rpc } = serviceReturning(detail(null));
    await portalDataOperations(service).getPortalEmail("hash", DELIVERY);
    expect(schema).toHaveBeenCalledWith("portal");
    expect(rpc).toHaveBeenCalledWith("get_email", { p_token_hash: "hash", p_delivery_id: DELIVERY });
  });

  it("HTML and text bodies are passed through verbatim", async () => {
    const html = "<table><tr><td style=\"color:red\">Código <b>482913</b></td></tr></table>";
    const { service } = serviceReturning(detail({ text: "Código 482913", html }));
    const email = await portalDataOperations(service).getPortalEmail("hash", DELIVERY);
    expect(email?.body).toEqual({ text: "Código 482913", html });
  });

  it("text-only, empty and hidden bodies keep their meaning", async () => {
    const map = async (body: unknown) => (await portalDataOperations(serviceReturning(detail(body)).service).getPortalEmail("hash", DELIVERY))?.body;
    expect(await map({ text: "Hola", html: null })).toEqual({ text: "Hola", html: null });
    expect(await map({ text: null })).toEqual({ text: null, html: null });
    expect(await map(null)).toBeNull();
  });

  it("no detail (not the customer's delivery) is null", async () => {
    const { service } = serviceReturning(null);
    expect(await portalDataOperations(service).getPortalEmail("hash", DELIVERY)).toBeNull();
  });
});
