/*
 * EmailBot F9 - Microsoft Graph subscription storage against a LOCAL Supabase
 * stack: the API's privileged lookups (PostgREST JSON-path filter on
 * provider_metadata, organization join) and the cleanup that keeps the other
 * provider_metadata keys. Fixtures are written with SQL as postgres in the
 * local container and deleted at the end.
 *
 *   supabase start
 *   pnpm --filter @emailbot/api e2e
 */
import { randomBytes, randomUUID } from "node:crypto";
import { hashClientState } from "@emailbot/shared";
import { createClient } from "@supabase/supabase-js";
import { privilegedOperations } from "../src/repositories/supabase/index.js";
import { localEnv, localSql } from "./local-supabase.js";

const { url, serviceKey } = localEnv();
const privileged = privilegedOperations(createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } }));
const run = randomBytes(3).toString("hex");

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string, detail = ""): void {
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
}
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
const firstLine = (error: unknown) => (error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error));

const active = randomUUID();
const suspended = randomUUID();
const accountA = randomUUID();
const accountB = randomUUID();
const subA = randomUUID();
const subB = randomUUID();
const metadata = (subscriptionId: string, clientState: string) =>
  JSON.stringify({ subscriptionId, subscriptionClientStateHash: hashClientState(clientState), keep: "other-key" });

try {
  localSql(
    [
      "begin;",
      `insert into public.organizations (id, name, slug, status) values (${literal(active)}, ${literal(`Graph active ${run}`)}, ${literal(`graph-active-${run}`)}, 'ACTIVE');`,
      `insert into public.organizations (id, name, slug, status) values (${literal(suspended)}, ${literal(`Graph suspended ${run}`)}, ${literal(`graph-suspended-${run}`)}, 'SUSPENDED');`,
      `insert into public.email_accounts (id, organization_id, provider, status, email_address, provider_metadata, access_token_encrypted, refresh_token_encrypted, token_expires_at, watch_expires_at, watch_renewed_at, watch_error_code)
         values (${literal(accountA)}, ${literal(active)}, 'MICROSOFT', 'ACTIVE', ${literal(`a-${run}@graph.test`)}, ${literal(metadata(subA, "state-a"))}::jsonb, 'enc-access', 'enc-refresh', now() + interval '1 hour', now() + interval '60 hours', now(), 'HTTP_400');`,
      `insert into public.email_accounts (id, organization_id, provider, status, email_address, provider_metadata)
         values (${literal(accountB)}, ${literal(suspended)}, 'MICROSOFT', 'ACTIVE', ${literal(`b-${run}@graph.test`)}, ${literal(metadata(subB, "state-b"))}::jsonb);`,
      "commit;"
    ].join("\n")
  );

  const found = await privileged.findMicrosoftSubscription(subA);
  check(
    found?.emailAccountId === accountA && found.organizationId === active && found.accountStatus === "ACTIVE" && found.organizationStatus === "ACTIVE",
    "findMicrosoftSubscription: account and organization of the subscription"
  );
  check(found?.clientStateHash === hashClientState("state-a"), "findMicrosoftSubscription: stored clientState hash (never the value)");
  check((await privileged.findMicrosoftSubscription(subB))?.organizationStatus === "SUSPENDED", "findMicrosoftSubscription: reports an inactive organization");
  check((await privileged.findMicrosoftSubscription(randomUUID())) === null, "findMicrosoftSubscription: unknown subscription -> null");
  check((await privileged.findMicrosoftSubscription("x' or 1=1 --")) === null, "findMicrosoftSubscription: non-GUID never queried");

  const credentials = await privileged.getMicrosoftSubscriptionCredentials(active, accountA);
  check(
    credentials?.subscriptionId === subA && credentials.accessTokenEncrypted === "enc-access" && credentials.refreshTokenEncrypted === "enc-refresh",
    "getMicrosoftSubscriptionCredentials: subscription id + encrypted tokens"
  );
  check((await privileged.getMicrosoftSubscriptionCredentials(suspended, accountA)) === null, "getMicrosoftSubscriptionCredentials: scoped to the organization");

  await privileged.clearMicrosoftSubscription(active, accountA);
  const row = localSql(
    `select provider_metadata::text || '|' || coalesce(watch_expires_at::text, 'null') || '|' || coalesce(watch_error_code, 'null') from public.email_accounts where id = ${literal(accountA)};`
  ).trim();
  check(row.startsWith('{"keep": "other-key"}|null|null'), "clearMicrosoftSubscription: subscription keys and watch_* cleared, other metadata kept", row.split("|")[0]);
  check((await privileged.findMicrosoftSubscription(subA)) === null, "a cleared subscription is no longer accepted");
} catch (error) {
  fail++;
  console.log(`FAIL setup or query: ${firstLine(error)}`);
} finally {
  try {
    localSql(`delete from public.organizations where id in (${literal(active)}, ${literal(suspended)});\n`);
    check(true, "cleanup: test organizations deleted (cascade)");
  } catch (error) {
    check(false, "cleanup: test organizations deleted (cascade)", firstLine(error));
  }
}

console.log(`RESULT pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
