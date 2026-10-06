import { z } from "zod";

/** Same format as public.legal_acceptances.version. */
const legalVersion = z.string().regex(/^[0-9]{1,3}\.[0-9]{1,3}$/, "Use a version like 2.0");

/**
 * POST /api/me/legal-acceptance (EmailBot V2 phase 7): the versions the user
 * was shown. The API only checks that they are still the current ones and
 * records ITS versions for the authenticated user with the database time;
 * any other field (user id, date, source...) is rejected.
 */
export const legalAcceptanceSchema = z
  .object({
    termsVersion: legalVersion,
    privacyVersion: legalVersion
  })
  .strict();
