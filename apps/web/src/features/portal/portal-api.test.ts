import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api-client";
import { createPortalApi, portalErrorMessage } from "./portal-api";
import { EMPTY_FILTERS, hasActiveFilters, toInboxParams } from "./portal-inbox-model";

describe("portal API client", () => {
  const ok = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends the session cookie (credentials: include) and never a bearer token, organization header or id", async () => {
    const fetch = vi.fn(async () => ok({ items: [], nextCursor: null }));
    const api = createPortalApi({ baseUrl: "https://api.example", fetch });
    await api.inbox({ unread: true, bot: "netflix", cursor: "opaque", limit: 25 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example/api/portal/inbox?cursor=opaque&limit=25&unread=true&bot=netflix");
    expect(init.credentials).toBe("include");
    expect(init.headers).toEqual({ accept: "application/json" });
    expect(JSON.stringify(init)).not.toMatch(/authorization|x-organization-id|customerId|organizationId|botId/i);
  });

  it("login posts only the Access ID; detail and download use the delivery id", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/session") ? ok({ customer: { displayName: "Juan" }, session: {} }) : url.includes("/attachments/") ? ok({ url: "https://signed", expiresIn: 60 }) : ok({ email: { deliveryId: "d1" } })
    );
    const api = createPortalApi({ baseUrl: "", fetch: fetch as unknown as typeof globalThis.fetch });
    await api.login("SP-7KQ9X82MP4Z7");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ accessId: "SP-7KQ9X82MP4Z7" }) });
    expect(await api.email("d1")).toEqual({ deliveryId: "d1" });
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/portal/email/d1");
    await api.attachmentUrl("d1", "a1");
    expect(fetch.mock.calls[2]?.[0]).toBe("/api/portal/email/d1/attachments/a1");
  });

  it("errors become ApiError with the status; network failures are status 0", async () => {
    const api = createPortalApi({ baseUrl: "", fetch: vi.fn(async () => ok({ error: { code: "NOT_FOUND", message: "Email not found" } }, 404)) });
    await expect(api.email("x")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    const offline = createPortalApi({ baseUrl: "", fetch: vi.fn(async () => Promise.reject(new TypeError("offline"))) });
    await expect(offline.me()).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
  });

  it("friendly messages never reveal internal details", () => {
    const err = (status: number, message = "Customer is suspended in organization 1111") => new ApiError(status, "X", message);
    expect(portalErrorMessage(err(401), "login")).toBe("Access ID o credenciales no válidas.");
    expect(portalErrorMessage(err(429), "login")).toMatch(/demasiadas solicitudes/);
    expect(portalErrorMessage(err(404), "email")).toBe("El correo no está disponible.");
    expect(portalErrorMessage(err(500), "inbox")).toBe("No pudimos cargar tus correos. Inténtalo nuevamente.");
    expect(portalErrorMessage(new ApiError(0, "NETWORK_ERROR", "x"), "email")).toBe("No pudimos cargar el correo. Inténtalo nuevamente.");
    for (const status of [400, 401, 403, 404, 429, 500]) {
      for (const context of ["inbox", "email", "login", "download"] as const) {
        expect(portalErrorMessage(err(status), context)).not.toMatch(/organization|1111|suspended/i);
      }
    }
  });
});

describe("portal inbox filters -> query parameters", () => {
  it("maps the view, slugs, trimmed search and an inclusive local date range", () => {
    const params = toInboxParams({ ...EMPTY_FILTERS, view: "unread", bot: "netflix", category: "codigos", search: "  código ", from: "2026-10-01", to: "2026-10-03" });
    expect(params).toMatchObject({ unread: true, important: undefined, bot: "netflix", category: "codigos", search: "código" });
    expect(new Date(params.from as string).getDate()).toBe(1);
    expect(new Date(params.to as string).getDate()).toBe(4); // exclusive upper bound = next day
    expect(toInboxParams({ ...EMPTY_FILTERS, view: "important" })).toMatchObject({ important: true, unread: undefined });
    expect(toInboxParams({ ...EMPTY_FILTERS, from: "not-a-date" }).from).toBeUndefined();
  });

  it("knows when any filter is active", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, search: " x " })).toBe(true);
    expect(hasActiveFilters({ ...EMPTY_FILTERS, view: "important" })).toBe(true);
  });
});
