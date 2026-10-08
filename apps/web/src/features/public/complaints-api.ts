import type { ComplaintBookReceipt } from "@emailbot/types";
import type { ComplaintBookSubmission } from "@emailbot/validation";
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api";

/** Libro de Reclamaciones: POST /api/complaints-book (public, no session needed). */
export function useSubmitComplaint() {
  return useMutation({
    mutationFn: (input: ComplaintBookSubmission) => api.post<ComplaintBookReceipt>("/api/complaints-book", input)
  });
}

/**
 * One id per filled-in form: if the request is retried (double click, network error after the sheet was
 * recorded), the API returns the same sheet instead of a second number. Without crypto.randomUUID the API
 * generates the id.
 */
export function newSubmissionId(): string | undefined {
  try {
    return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : undefined;
  } catch {
    return undefined;
  }
}
