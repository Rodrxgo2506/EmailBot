import type { CommercialPlan, PlanCatalogEntry } from "@emailbot/types";

/*
 * GET /api/plans as the API returns it for the approved Commercial V1 catalog
 * (the database seed, checked in packages/database/test/plan-catalog.test.ts).
 * Test data only: the web never hardcodes prices or limits.
 */

const GB = 1024 ** 3;

const price = (monthly: string, yearly: string) => [
  { billingPeriod: "MONTHLY" as const, currency: "PEN", amount: monthly, amountCents: Math.round(Number(monthly) * 100) },
  { billingPeriod: "YEARLY" as const, currency: "PEN", amount: yearly, amountCents: Math.round(Number(yearly) * 100) }
];

export const PLAN_CATALOG: PlanCatalogEntry[] = [
  {
    code: "BASIC",
    name: "Básico",
    description: null,
    badge: null,
    sortOrder: 1,
    prices: price("19.90", "199.00"),
    limits: { EMAIL_ACCOUNTS: 2, RULES: 10, BOTS: 2, MONTHLY_EMAILS: 2_000, MEMBERS: 2, CUSTOMERS: 500, STORAGE_BYTES: 1 * GB, RETENTION_DAYS: 30 },
    features: { GMAIL: true, MICROSOFT: false, ADVANCED_STATS: false, PORTAL: false, API: false, PRIORITY_SUPPORT: false }
  },
  {
    code: "PRO",
    name: "Pro",
    description: null,
    badge: "Más elegido",
    sortOrder: 2,
    prices: price("39.90", "399.00"),
    limits: { EMAIL_ACCOUNTS: 5, RULES: 30, BOTS: 10, MONTHLY_EMAILS: 15_000, MEMBERS: 5, CUSTOMERS: 2_500, STORAGE_BYTES: 5 * GB, RETENTION_DAYS: 90 },
    features: { GMAIL: true, MICROSOFT: true, ADVANCED_STATS: true, PORTAL: true, API: false, PRIORITY_SUPPORT: true }
  },
  {
    code: "BUSINESS",
    name: "Business",
    description: null,
    badge: null,
    sortOrder: 3,
    prices: price("89.90", "899.00"),
    limits: { EMAIL_ACCOUNTS: 20, RULES: 100, BOTS: 50, MONTHLY_EMAILS: 75_000, MEMBERS: 20, CUSTOMERS: 10_000, STORAGE_BYTES: 25 * GB, RETENTION_DAYS: 365 },
    features: { GMAIL: true, MICROSOFT: true, ADVANCED_STATS: true, PORTAL: true, API: true, PRIORITY_SUPPORT: true }
  }
];

export const catalogEntry = (code: CommercialPlan): PlanCatalogEntry => PLAN_CATALOG.find((plan) => plan.code === code) as PlanCatalogEntry;
