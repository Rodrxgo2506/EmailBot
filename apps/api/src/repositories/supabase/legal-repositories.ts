import { LEGAL_DOCUMENTS, type LegalDocument } from "@emailbot/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { unwrap } from "../../lib/errors.js";
import type { PrivilegedOperations } from "../types.js";
import type { Row } from "./mappers.js";

type LegalAcceptanceOperations = Pick<PrivilegedOperations, "listLegalAcceptances" | "recordLegalAcceptance">;

/**
 * EmailBot V2 phase 7: public.legal_acceptances through the service role,
 * which may only SELECT and INSERT (user_id, document, version, source):
 * accepted_at is always the database time and rows are never updated.
 */
export function legalAcceptanceOperations(service: SupabaseClient): LegalAcceptanceOperations {
  return {
    async listLegalAcceptances(userId) {
      const rows = unwrap(await service.from("legal_acceptances").select("document,version").eq("user_id", userId)) as Row[];
      return rows
        .filter((row) => (LEGAL_DOCUMENTS as readonly string[]).includes(row.document as string))
        .map((row) => ({ document: row.document as LegalDocument, version: String(row.version) }));
    },

    async recordLegalAcceptance(userId, versions) {
      unwrap(
        await service.from("legal_acceptances").upsert(
          LEGAL_DOCUMENTS.map((document) => ({ user_id: userId, document, version: versions[document], source: "reacceptance" })),
          { onConflict: "user_id,document,version", ignoreDuplicates: true }
        )
      );
    }
  };
}
