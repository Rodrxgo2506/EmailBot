import { describe, expect, it, vi } from "vitest";
import { ApiError, buildQuery, createApiClient } from "./api-client";

describe("buildQuery", () => {
  it("skips empty values", () => {
    expect(buildQuery({ page: 1, search: "", isRead: false, categoryId: undefined })).toBe("?page=1&isRead=false");
    expect(buildQuery({})).toBe("");
  });
});

describe("createApiClient", () => {
  it("sends the bearer token and organization header, never in the URL", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = createApiClient({
      baseUrl: "https://api.example.com",
      getAccessToken: async () => "jwt",
      getOrganizationId: () => "org-1",
      fetch: fetchMock as unknown as typeof fetch
    });

    await client.get("/api/rules");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.com/api/rules");
    expect(init.headers).toMatchObject({ authorization: "Bearer jwt", "x-organization-id": "org-1" });
  });

  it("raises ApiError with the server error code", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: "INSUFFICIENT_ROLE", message: "nope" } }), { status: 403 })
    );
    const client = createApiClient({
      baseUrl: "",
      getAccessToken: async () => null,
      getOrganizationId: () => null,
      fetch: fetchMock as unknown as typeof fetch
    });

    await expect(client.post("/api/rules", {})).rejects.toMatchObject({ status: 403, code: "INSUFFICIENT_ROLE" });
    await expect(client.post("/api/rules", {})).rejects.toBeInstanceOf(ApiError);
  });

  it("returns undefined on 204", async () => {
    const client = createApiClient({
      baseUrl: "",
      getAccessToken: async () => null,
      getOrganizationId: () => null,
      fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch
    });
    await expect(client.delete("/api/rules/1")).resolves.toBeUndefined();
  });
});
