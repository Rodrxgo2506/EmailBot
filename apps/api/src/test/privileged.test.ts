import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { privilegedOperations, withDownloadName } from "../repositories/supabase/privileged.js";

/*
 * Regression: the download name of a signed URL was percent-encoded twice
 * (storage-js encodes `download` and then runs encodeURI on the whole URL),
 * so Unicode attachments were saved as "Cotizaci%C3%B3n.xlsx".
 */

const SIGNED = "http://127.0.0.1:54321/storage/v1/object/sign/email-attachments/org/e/a/Cotizacion-0123456789ab.xlsx?token=abc.def";

function fakeService(signedUrl = SIGNED) {
  const createSignedUrl = vi.fn(async () => ({ data: { signedUrl }, error: null }));
  const from = vi.fn(() => ({ createSignedUrl }));
  return { client: { storage: { from } } as unknown as SupabaseClient, createSignedUrl, from };
}

describe("signed download URLs", () => {
  it.each(["Cotización.xlsx", "Factura ñ.pdf", "résumé.docx", "报告.pdf", "📎 informe ✅.pdf", "a&b (1) #2 %3 [x].pdf", "factura.pdf"])(
    "%s: the download name is encoded exactly once",
    async (filename) => {
      const { client, createSignedUrl } = fakeService();
      const url = await privilegedOperations(client).createSignedDownloadUrl("email-attachments", "org/e/a/x", 60, filename);

      // storage-js must not receive the name (it would double-encode it).
      expect(createSignedUrl).toHaveBeenCalledWith("org/e/a/x", 60);
      const parsed = new URL(url);
      expect(parsed.searchParams.get("token")).toBe("abc.def");
      expect(parsed.searchParams.get("download")).toBe(filename);
      // A literal "%" in the name is the only legitimate "%25".
      if (!filename.includes("%")) expect(url).not.toContain("%25");
    }
  );

  it("adds a query string when the signed URL has none", () => {
    expect(withDownloadName("https://x.test/object/sign/b/p", "ñ.pdf")).toBe("https://x.test/object/sign/b/p?download=%C3%B1.pdf");
  });

  it("maps storage failures to a 502 without leaking details", async () => {
    const createSignedUrl = vi.fn(async () => ({ data: null, error: { message: "Object not found" } }));
    const client = { storage: { from: () => ({ createSignedUrl }) } } as unknown as SupabaseClient;
    await expect(privilegedOperations(client).createSignedDownloadUrl("b", "p", 60, "f.pdf")).rejects.toMatchObject({
      statusCode: 502,
      code: "STORAGE_ERROR"
    });
  });
});
