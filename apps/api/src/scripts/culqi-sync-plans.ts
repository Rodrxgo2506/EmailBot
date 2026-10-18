/*
 * Commercial V1 phase 2 (Culqi SANDBOX): creates in Culqi the plan of every
 * active EmailBot price (BASIC / PRO / BUSINESS x monthly / yearly) and stores
 * the mapping in public.billing_provider_plans. EmailBot remains the source of
 * the prices: each Culqi plan is created from the catalog row.
 *
 *   pnpm --filter @emailbot/api culqi:sync-plans            # dry run: shows what exists / would be created
 *   pnpm --filter @emailbot/api culqi:sync-plans --apply    # creates the missing plans (sandbox)
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and CULQI_SECRET_KEY (sk_test_ only:
 * live keys are refused). Refuses a non-local database unless --allow-remote-database
 * is passed explicitly. Prints ids and amounts only, never keys.
 */
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { createCulqiClient, culqiKeyProblem } from "@emailbot/shared";
import { BILLING_PERIODS, type BillingPeriod } from "@emailbot/types";
import { createClient } from "@supabase/supabase-js";
import { syncCulqiPlans, type CatalogPrice } from "../modules/billing/culqi-plans.js";

loadDotenv({ path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../../.env")], quiet: true });

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const allowRemote = args.has("--allow-remote-database");

function fail(message: string): never {
  console.error(`culqi:sync-plans: ${message}`);
  process.exit(1);
}

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const secretKey = process.env.CULQI_SECRET_KEY;
if (!supabaseUrl || !serviceRoleKey) fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
if (!secretKey) fail("CULQI_SECRET_KEY is required");
const keyProblem = culqiKeyProblem(secretKey, "secret");
if (keyProblem) fail(`CULQI_SECRET_KEY ${keyProblem}`);

const host = new URL(supabaseUrl).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host) && !allowRemote) {
  fail(`refusing to write to a non-local database (${host}); pass --allow-remote-database only for an approved sandbox`);
}

const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const culqi = createCulqiClient({ secretKey, fetch: globalThis.fetch, ...(process.env.CULQI_API_URL ? { baseUrl: process.env.CULQI_API_URL } : {}) });

const { data: rows, error } = await db
  .from("plan_prices")
  .select("id,billing_period,currency,amount_cents,active,plan:plan_catalog!inner(code,name,sort_order,active)")
  .eq("active", true)
  .eq("plan.active", true);
if (error) fail(`could not read the catalog: ${error.message}`);

const prices: CatalogPrice[] = (rows ?? [])
  .map((row) => {
    const plan = (Array.isArray(row.plan) ? row.plan[0] : row.plan) as { code: string; name: string; sort_order: number };
    return {
      planPriceId: row.id as string,
      plan: plan.code,
      planName: plan.name,
      billingPeriod: row.billing_period as BillingPeriod,
      currency: row.currency as string,
      amountCents: Number(row.amount_cents),
      order: Number(plan.sort_order)
    };
  })
  .sort((a, b) => a.order - b.order || BILLING_PERIODS.indexOf(a.billingPeriod) - BILLING_PERIODS.indexOf(b.billingPeriod));

const { data: mappedRows, error: mappedError } = await db
  .from("billing_provider_plans")
  .select("plan_price_id,external_plan_id")
  .eq("provider", "CULQI")
  .eq("environment", culqi.environment);
if (mappedError) fail(`could not read billing_provider_plans: ${mappedError.message}`);
const mapped = new Map((mappedRows ?? []).map((row) => [row.plan_price_id as string, row.external_plan_id as string]));

console.log(`Culqi environment: ${culqi.environment} | database: ${host} | mode: ${apply ? "APPLY" : "dry run"}`);
const actions = await syncCulqiPlans({
  prices,
  mapped,
  culqi,
  apply,
  async save(planPriceId, externalPlanId) {
    const { error: insertError } = await db
      .from("billing_provider_plans")
      .insert({ plan_price_id: planPriceId, provider: "CULQI", environment: culqi.environment, external_plan_id: externalPlanId });
    if (insertError) fail(`created ${externalPlanId} at Culqi but could not store the mapping: ${insertError.message}`);
  }
});

for (const item of actions) {
  const label = `${item.price.plan} ${item.price.billingPeriod} ${item.price.currency} ${(item.price.amountCents / 100).toFixed(2)}`;
  if (item.action === "MISMATCH") console.log(`  MISMATCH ${label} -> ${item.externalPlanId}: ${item.problems.join("; ")}`);
  else if (item.action === "CREATE") console.log(`  MISSING  ${label} (run with --apply to create it)`);
  else console.log(`  ${item.action.padEnd(8)} ${label} -> ${item.externalPlanId}`);
}
if (actions.some((item) => item.action === "MISMATCH")) process.exitCode = 2;
