/*
 * Every organization-scoped query key starts with ["org", organizationId]
 * so switching organizations can drop the whole tenant cache at once and
 * data of one tenant is never shown under another.
 */
export const queryKeys = {
  org: (organizationId: string) => ["org", organizationId] as const,
  current: (organizationId: string) => ["org", organizationId, "current"] as const,
  emails: (organizationId: string) => ["org", organizationId, "emails"] as const,
  emailList: (organizationId: string, params: Record<string, unknown>) =>
    ["org", organizationId, "emails", "list", params] as const,
  email: (organizationId: string, id: string) => ["org", organizationId, "emails", "detail", id] as const,
  categories: (organizationId: string) => ["org", organizationId, "categories"] as const,
  bots: (organizationId: string) => ["org", organizationId, "bots"] as const,
  bot: (organizationId: string, id: string) => ["org", organizationId, "bots", id] as const,
  botCustomers: (organizationId: string, botId: string) => ["org", organizationId, "bots", botId, "customers"] as const,
  customers: (organizationId: string) => ["org", organizationId, "customers"] as const,
  customerList: (organizationId: string, params: Record<string, unknown>) =>
    ["org", organizationId, "customers", "list", params] as const,
  customer: (organizationId: string, id: string) => ["org", organizationId, "customers", "detail", id] as const,
  customerIdentifiers: (organizationId: string, id: string) => ["org", organizationId, "customers", "detail", id, "identifiers"] as const,
  customerBots: (organizationId: string, id: string) => ["org", organizationId, "customers", "detail", id, "bots"] as const,
  customerAccess: (organizationId: string, id: string) => ["org", organizationId, "customers", "detail", id, "access"] as const,
  rules: (organizationId: string) => ["org", organizationId, "rules"] as const,
  rule: (organizationId: string, id: string) => ["org", organizationId, "rules", id] as const,
  accounts: (organizationId: string) => ["org", organizationId, "email-accounts"] as const,
  members: (organizationId: string) => ["org", organizationId, "members"] as const,
  audit: (organizationId: string, params: Record<string, unknown>) => ["org", organizationId, "audit", params] as const,
  stats: (organizationId: string) => ["org", organizationId, "emails", "stats"] as const
};
