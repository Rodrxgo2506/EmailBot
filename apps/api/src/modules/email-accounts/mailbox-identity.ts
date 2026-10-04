import type { OAuthProvider } from "@emailbot/shared";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";

export interface MailboxIdentity {
  emailAddress: string;
  displayName: string | null;
  providerAccountId: string | null;
  /** Initial synchronization cursor (see apps/worker/src/providers). */
  syncCursor: string | null;
}

const gmailProfileSchema = z.object({
  emailAddress: z.string().min(3),
  historyId: z.union([z.string(), z.number()]).transform(String)
});

const graphUserSchema = z.object({
  id: z.string(),
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().nullable().optional(),
  displayName: z.string().nullable().optional()
});

async function getJson(url: string, accessToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }
  });
  if (!response.ok) {
    throw new AppError(502, "PROVIDER_ERROR", `Mailbox profile request failed with HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Identifies the mailbox that was just authorized and returns the cursor
 * from which new messages must be processed (only mail received AFTER the
 * connection is evaluated; historical mail is never bulk-imported).
 */
export async function fetchMailboxIdentity(
  provider: OAuthProvider,
  accessToken: string,
  fetchImpl: typeof fetch
): Promise<MailboxIdentity> {
  if (provider === "GMAIL") {
    const profile = gmailProfileSchema.parse(
      await getJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", accessToken, fetchImpl)
    );
    return {
      emailAddress: profile.emailAddress.toLowerCase(),
      displayName: null,
      providerAccountId: profile.emailAddress.toLowerCase(),
      syncCursor: profile.historyId
    };
  }

  const user = graphUserSchema.parse(
    await getJson(
      "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName",
      accessToken,
      fetchImpl
    )
  );
  const emailAddress = user.mail ?? user.userPrincipalName;
  if (!emailAddress) throw new AppError(502, "PROVIDER_ERROR", "The Microsoft account has no mailbox address");

  return {
    emailAddress: emailAddress.toLowerCase(),
    displayName: user.displayName ?? null,
    providerAccountId: user.id,
    // Graph delta starts from "now": the worker only enqueues messages received after this instant.
    syncCursor: `since:${new Date().toISOString()}`
  };
}
