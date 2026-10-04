import type { TestDatabase, Tx } from "../src/harness.js";

export async function one<T>(tx: Tx, sql: string, params: unknown[] = []): Promise<T> {
  const result = await tx.query<T>(sql, params);
  const row = result.rows[0];
  if (row === undefined) throw new Error(`Query returned no rows: ${sql}`);
  return row;
}

export async function count(tx: Tx, sql: string, params: unknown[] = []): Promise<number> {
  const row = await one<{ n: number }>(tx, `select count(*)::int as n from (${sql}) q`, params);
  return row.n;
}

export interface TenantFixture {
  orgId: string;
  ownerId: string;
  accountId: string;
  categoryId: string;
  ruleId: string;
  emailId: string;
  attachmentId: string;
}

export interface Fixtures {
  a: TenantFixture & { adminId: string; operatorId: string; viewerId: string };
  b: TenantFixture;
  outsiderId: string;
}

async function seedTenantData(t: TestDatabase, orgId: string, ownerId: string, prefix: string) {
  // Seeded by the table owner (like the dashboard/migrations), not by the backend role.
  return t.asAdmin(async (tx) => {
    const account = await one<{ id: string }>(
      tx,
      `insert into public.email_accounts (organization_id, provider, email_address, access_token_encrypted, refresh_token_encrypted)
       values ($1, 'GMAIL', $2, 'v1.iv.tag.access', 'v1.iv.tag.refresh') returning id`,
      [orgId, `inbox@${prefix}.test`]
    );
    const category = await one<{ id: string }>(
      tx,
      `insert into public.categories (organization_id, name, slug) values ($1, 'Codes', 'codes') returning id`,
      [orgId]
    );
    const rule = await one<{ id: string }>(
      tx,
      `insert into public.email_rules (organization_id, category_id, name, conditions, actions)
       values ($1, $2, 'Rule', '{"conditions":[{"field":"subject","operator":"contains","value":"code"}]}', '{"actions":[]}')
       returning id`,
      [orgId, category.id]
    );
    const email = await one<{ id: string }>(
      tx,
      `insert into public.emails (organization_id, email_account_id, category_id, matched_rule_id, provider_message_id,
                                  sender_email, subject, received_at)
       values ($1, $2, $3, $4, 'provider-msg-1', 'sender@example.com', 'Your code', now()) returning id`,
      [orgId, account.id, category.id, rule.id]
    );
    const attachment = await one<{ id: string }>(
      tx,
      `insert into public.email_attachments (organization_id, email_id, filename) values ($1, $2, 'file.pdf') returning id`,
      [orgId, email.id]
    );
    await tx.query(
      `insert into public.audit_logs (organization_id, actor_type, actor_user_id, action, entity_type, entity_id)
       values ($1, 'USER', $2, 'CREATE', 'organization', $1)`,
      [orgId, ownerId]
    );

    return {
      accountId: account.id,
      categoryId: category.id,
      ruleId: rule.id,
      emailId: email.id,
      attachmentId: attachment.id
    };
  });
}

/** Two organizations (A with every role, B with only an owner) plus an outsider. */
export async function seedTwoTenants(t: TestDatabase): Promise<Fixtures> {
  const ownerA = await t.createUser("owner@a.test");
  const adminA = await t.createUser("admin@a.test");
  const operatorA = await t.createUser("operator@a.test");
  const viewerA = await t.createUser("viewer@a.test");
  const ownerB = await t.createUser("owner@b.test");
  const outsiderId = await t.createUser("outsider@c.test");

  const orgA = await t.asUser(ownerA, (tx) =>
    one<{ id: string }>(tx, "select public.create_organization('Org A', 'org-a') as id")
  );
  const orgB = await t.asUser(ownerB, (tx) =>
    one<{ id: string }>(tx, "select public.create_organization('Org B', 'org-b') as id")
  );

  await t.asUser(ownerA, async (tx) => {
    for (const [userId, role] of [
      [adminA, "ADMIN"],
      [operatorA, "OPERATOR"],
      [viewerA, "VIEWER"]
    ] as const) {
      await tx.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, $3)", [
        orgA.id,
        userId,
        role
      ]);
    }
  });

  const dataA = await seedTenantData(t, orgA.id, ownerA, "a");
  const dataB = await seedTenantData(t, orgB.id, ownerB, "b");

  return {
    a: { orgId: orgA.id, ownerId: ownerA, adminId: adminA, operatorId: operatorA, viewerId: viewerA, ...dataA },
    b: { orgId: orgB.id, ownerId: ownerB, ...dataB },
    outsiderId
  };
}
