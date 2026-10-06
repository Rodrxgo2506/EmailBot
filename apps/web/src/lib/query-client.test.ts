import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api-client";
import { createQueryClient, LEGAL_ACCEPTANCE_REQUIRED } from "./query-client";

describe("query client: API legal barrier", () => {
  it("a LEGAL_ACCEPTANCE_REQUIRED refusal re-reads /api/me (query or mutation), so the acceptance screen appears", async () => {
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const refusal = new ApiError(403, LEGAL_ACCEPTANCE_REQUIRED, "Accept the current Terms and Conditions and Privacy Policy to continue");

    await expect(client.fetchQuery({ queryKey: ["org", "rules"], queryFn: async () => Promise.reject(refusal) })).rejects.toBe(refusal);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["me"] });

    invalidate.mockClear();
    await expect(client.getMutationCache().build(client, { mutationFn: async () => Promise.reject(refusal) }).execute(undefined)).rejects.toBe(refusal);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["me"] });
  });

  it("other errors do not touch /api/me", async () => {
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const forbidden = new ApiError(403, "NOT_A_MEMBER", "You are not a member of this organization");
    await expect(client.fetchQuery({ queryKey: ["org", "rules"], queryFn: async () => Promise.reject(forbidden) })).rejects.toBe(forbidden);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
