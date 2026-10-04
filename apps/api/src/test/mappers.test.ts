import { describe, expect, it } from "vitest";
import { EMAIL_SUMMARY_COLUMNS, toEmailDetail, toEmailSummary } from "../repositories/supabase/mappers.js";

const row = {
  id: "e1",
  organization_id: "o1",
  email_account_id: "a1",
  category_id: null,
  matched_rule_id: null,
  direction: "INBOUND",
  processing_status: "PROCESSED",
  sender_email: "x@example.com",
  sender_name: null,
  to_emails: ["me@example.com"],
  subject: "Hi",
  snippet: null,
  received_at: "2026-10-02T00:00:00Z",
  extracted_data: {},
  is_read: false,
  is_important: false,
  is_archived: false,
  created_at: "2026-10-02T00:00:00Z"
};

describe("email mappers", () => {
  it("requests the attachment count with the summary columns", () => {
    expect(EMAIL_SUMMARY_COLUMNS).toContain("attachment_count:email_attachments(count)");
  });

  it("maps the PostgREST embedded count", () => {
    expect(toEmailSummary({ ...row, attachment_count: [{ count: 3 }] }).attachmentCount).toBe(3);
    expect(toEmailSummary(row).attachmentCount).toBe(0);
  });

  it("never exposes the raw embed and keeps detail attachments", () => {
    const detail = toEmailDetail({
      ...row,
      attachment_count: [{ count: 1 }],
      cc_emails: [],
      text_body: "t",
      html_body: null,
      sent_at: null,
      processed_at: null,
      email_attachments: [
        {
          id: "att",
          email_id: "e1",
          filename: "f.pdf",
          content_type: "application/pdf",
          file_size: "10",
          is_inline: false,
          storage_uploaded: true,
          created_at: "2026-10-02T00:00:00Z"
        }
      ]
    });
    expect(detail.attachmentCount).toBe(1);
    expect(detail.attachments[0]).toMatchObject({ id: "att", fileSize: 10 });
    expect("attachment_count" in detail).toBe(false);
  });
});
