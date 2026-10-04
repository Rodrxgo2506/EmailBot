import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, listMigrationFiles, type TestDatabase, type Tx } from "../src/harness.js";
import { count, one, seedTwoTenants, type Fixtures } from "./fixtures.js";

/*
 * Migration 8 regression: the search vector used to index the whole
 * text_body, and PostgreSQL rejects tsvectors whose lexeme data exceeds
 * 1 MB ("string is too long for tsvector"), so large emails could never be
 * inserted. Only the first 50,000 characters of the search document are
 * indexed now; text_body is stored in full.
 */

const MIGRATION_8 = "20261003140000";
const TSVECTOR_LIMIT_BYTES = 1_048_575;
const INDEXED_CHARACTERS = 50_000;

/** Distinct ASCII words: every token becomes its own lexeme. */
function distinctWords(count: number, prefix = "w"): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index.toString(36)}x`).join(" ");
}

/** Worst case measured for the default parser: hyphenated pairs of distinct 4-byte characters. */
function hyphenatedAstralPairs(characters: number): string {
  const parts: string[] = [];
  for (let index = 0, length = 0; length < characters; index++) {
    const token = `${String.fromCodePoint(0x20000 + 2 * index)}-${String.fromCodePoint(0x20001 + 2 * index)}`;
    parts.push(token);
    length += 4;
  }
  return parts.join(" ");
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let sequence = 0;
async function insertEmail(
  tx: Tx,
  f: Fixtures,
  fields: { subject?: string; textBody?: string | null; htmlBody?: string | null; senderName?: string }
): Promise<string> {
  sequence += 1;
  const row = await one<{ id: string }>(
    tx,
    `insert into public.emails (organization_id, email_account_id, provider_message_id, sender_email, sender_name, subject, text_body, html_body, received_at)
     values ($1, $2, $3, 'alerts@bank.example', $4, $5, $6, $7, now())
     on conflict (email_account_id, provider_message_id) do nothing
     returning id`,
    [f.a.orgId, f.a.accountId, `search-${sequence}`, fields.senderName ?? null, fields.subject ?? null, fields.textBody ?? null, fields.htmlBody ?? null]
  );
  return row.id;
}

const matches = (tx: Tx, id: string, query: string) =>
  count(tx, "select 1 from public.emails where id = $1 and search_vector @@ websearch_to_tsquery('simple', $2)", [id, query]);

describe("migration 8 exists", () => {
  it("is the eighth migration", () => {
    expect(listMigrationFiles()[7]).toBe(`${MIGRATION_8}_bounded_email_search_vector.sql`);
  });
});

describe("BEFORE migration 8: large bodies cannot be inserted (reproduces the defect)", () => {
  let t: TestDatabase;
  let f: Fixtures;

  beforeAll(async () => {
    t = await createTestDatabase({ stopBefore: MIGRATION_8 });
    f = await seedTwoTenants(t);
  });
  afterAll(async () => t?.close());

  it("a multi-MB body is rejected by the search vector trigger", async () => {
    await expect(t.asService((tx) => insertEmail(tx, f, { subject: "big", textBody: distinctWords(400_000) }))).rejects.toThrow(
      /string is too long for tsvector/
    );
  });

  it("a body just over the limit is rejected too", async () => {
    await expect(t.asService((tx) => insertEmail(tx, f, { subject: "edge", textBody: distinctWords(120_000) }))).rejects.toThrow(
      /string is too long for tsvector/
    );
  });
});

describe("AFTER migration 8: bounded search document", () => {
  let t: TestDatabase;
  let f: Fixtures;

  beforeAll(async () => {
    t = await createTestDatabase();
    f = await seedTwoTenants(t);
  });
  afterAll(async () => t?.close());

  it("a small body is inserted and searchable", async () => {
    await t.asService(async (tx) => {
      const id = await insertEmail(tx, f, { subject: "Factura octubre", textBody: "Adjuntamos la factura 2026-10 del servicio." });
      expect(await matches(tx, id, "factura")).toBe(1);
      expect(await matches(tx, id, "servicio")).toBe(1);
      expect(await matches(tx, id, "inexistente")).toBe(0);
    });
  });

  it("a multi-MB body is inserted, kept intact and gets a bounded search vector", async () => {
    const body = `inicio ${distinctWords(500_000)} final`;
    expect(body.length).toBeGreaterThan(3_000_000);

    await t.asService(async (tx) => {
      const id = await insertEmail(tx, f, { subject: "Reporte mensual", textBody: body });
      const row = await one<{ length: number; hash: string; vector_bytes: number; has_vector: boolean }>(
        tx,
        `select length(text_body) as length, encode(sha256(convert_to(text_body, 'UTF8')), 'hex') as hash,
                pg_column_size(search_vector) as vector_bytes, search_vector is not null as has_vector
         from public.emails where id = $1`,
        [id]
      );
      expect(row.length).toBe(body.length);
      expect(row.hash).toBe(sha256(body));
      expect(row.has_vector).toBe(true);
      expect(row.vector_bytes).toBeLessThan(TSVECTOR_LIMIT_BYTES);

      expect(await matches(tx, id, "reporte")).toBe(1);
      expect(await matches(tx, id, "inicio")).toBe(1);
      // Outside the indexed window (documented trade-off): stored, not searchable.
      expect(await matches(tx, id, "final")).toBe(0);
    });
  });

  it("a body just over the old limit no longer fails", async () => {
    const body = distinctWords(120_000);
    await t.asService(async (tx) => {
      const id = await insertEmail(tx, f, { subject: "edge", textBody: body });
      const row = await one<{ length: number }>(tx, "select length(text_body) as length from public.emails where id = $1", [id]);
      expect(row.length).toBe(body.length);
    });
  });

  it("the worst-case document stays far below the tsvector limit", async () => {
    const body = hyphenatedAstralPairs(200_000);
    await t.asService(async (tx) => {
      const id = await insertEmail(tx, f, { subject: "worst case", textBody: body });
      const row = await one<{ vector_bytes: number; lexemes: number }>(
        tx,
        "select pg_column_size(search_vector) as vector_bytes, length(search_vector) as lexemes from public.emails where id = $1",
        [id]
      );
      // Lexeme data + positions (what the limit applies to) = total - 4 bytes per entry - header.
      const lexemeData = row.vector_bytes - 4 * row.lexemes - 8;
      expect(lexemeData).toBeLessThan(TSVECTOR_LIMIT_BYTES / 2);
    });
  });

  it("a large HTML body does not break the insert", async () => {
    const html = `<html><body>${"<div><p>Hola <b>mundo</b> &amp; m&aacute;s</p></div>".repeat(120_000)}</body></html>`;
    await t.asService(async (tx) => {
      const id = await insertEmail(tx, f, { subject: "Boletín HTML", textBody: null, htmlBody: html });
      const row = await one<{ length: number }>(tx, "select length(html_body) as length from public.emails where id = $1", [id]);
      expect(row.length).toBe(html.length);
      expect(await matches(tx, id, "boletín")).toBe(1);
    });
  });

  it("indexes Spanish, ñ, accents and emoji text", async () => {
    await t.asService(async (tx) => {
      const id = await insertEmail(tx, f, {
        subject: "Cotización ñandú 🎉",
        senderName: "Banco Peñaranda",
        textBody: `Tu código llega mañana. ${"relleno ".repeat(10_000)}`
      });
      for (const term of ["cotización", "ñandú", "peñaranda", "código", "mañana"]) {
        expect(await matches(tx, id, term), term).toBe(1);
      }
    });
  });

  it("subject and sender are always indexed even when the body fills the window", async () => {
    await t.asService(async (tx) => {
      const id = await insertEmail(tx, f, { subject: "Aviso urgente", senderName: "Tesorería", textBody: distinctWords(200_000) });
      expect(await matches(tx, id, "urgente")).toBe(1);
      expect(await matches(tx, id, "tesorería")).toBe(1);
      expect(await matches(tx, id, "alerts@bank.example")).toBe(1);
    });
  });

  it("updating text_body to a large value goes through the same bounded trigger", async () => {
    await t.asAdmin(async (tx) => {
      const id = await insertEmail(tx, f, { subject: "update", textBody: "corto" });
      await tx.query("update public.emails set text_body = $2 where id = $1", [id, distinctWords(400_000)]);
      expect(await matches(tx, id, "corto")).toBe(0);
      expect(await matches(tx, id, "update")).toBe(1);
    });
  });

  it("keeps the trigger function locked down", async () => {
    const executable = await t.asAdmin((tx) =>
      count(
        tx,
        `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'private' and p.proname = 'update_email_search_vector'
           and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE')
                or has_function_privilege('service_role', p.oid, 'EXECUTE'))`
      )
    );
    expect(executable).toBe(0);
    const definer = await t.asAdmin((tx) =>
      one<{ prosecdef: boolean; config: string[] }>(
        tx,
        `select p.prosecdef, p.proconfig as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'private' and p.proname = 'update_email_search_vector'`
      )
    );
    expect(definer.prosecdef).toBe(true);
    expect(definer.config).toContain('search_path=""');
  });

  it("INDEXED_CHARACTERS matches the migration", async () => {
    const definition = await t.asAdmin((tx) =>
      one<{ src: string }>(
        tx,
        `select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'private' and p.proname = 'update_email_search_vector'`
      )
    );
    expect(definition.src).toContain(String(INDEXED_CHARACTERS));
  });
});
