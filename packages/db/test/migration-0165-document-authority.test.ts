import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0165_document_authority_foundation.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0165-document-authority");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0165-document-authority] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0165 (document authority)", () => {
  test("rejects an undrained queue, rolls back, then backfills and restores FORCE RLS", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      const liveApp = postgres(appUrl.toString(), { max: 1 });
      let liveWriterError: unknown;
      try {
        await liveApp`select 1`;
        await sql.unsafe(migrationSql);
      } catch (error) {
        liveWriterError = error;
      } finally {
        await liveApp.end();
      }
      expect(String(liveWriterError)).toContain(
        "document authority activation requires all opengeni_app sessions to be stopped",
      );

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0165-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0165-workspace') returning id`;
      const [file] = await sql<{ id: string }[]>`
        insert into files (
          account_id, workspace_id, status, filename, safe_filename, content_type,
          size_bytes, bucket, object_key
        ) values (
          ${account!.id}, ${workspace!.id}, 'ready', 'legacy.txt', 'legacy.txt',
          'text/plain', 1, 'test', 'migration-0165/legacy.txt'
        ) returning id`;
      const [base] = await sql<{ id: string }[]>`
        insert into document_bases (account_id, workspace_id, name)
        values (${account!.id}, ${workspace!.id}, 'Legacy') returning id`;
      const [wrongChunkBase] = await sql<{ id: string }[]>`
        insert into document_bases (account_id, workspace_id, name)
        values (${account!.id}, ${workspace!.id}, 'Legacy chunk drift') returning id`;
      const [document] = await sql<{ id: string }[]>`
        insert into documents (
          account_id, workspace_id, base_id, file_id, status, title, created_by, visibility
        ) values (
          ${account!.id}, ${workspace!.id}, ${base!.id}, ${file!.id}, 'queued',
          'Legacy private document', 'user:alice', 'private'
        ) returning id`;
      const zeroVector = `[${Array.from({ length: 3072 }, () => "0").join(",")}]`;
      await sql`
        insert into document_chunks (
          account_id, workspace_id, document_id, base_id, file_id, chunk_index,
          text, metadata, embedding, embedding_model
        ) values (
          ${account!.id}, ${workspace!.id}, ${document!.id}, ${wrongChunkBase!.id}, ${file!.id},
          0, 'legacy private text', '{}'::jsonb, ${zeroVector}::vector, 'migration-test'
        )`;

      let drainError: unknown;
      try {
        await sql.unsafe(migrationSql);
      } catch (error) {
        drainError = error;
      }
      expect(String(drainError)).toContain(
        "migration 0165 requires every queued/indexing document to settle",
      );

      const rolledBack = await sql<
        Array<{ authorityColumns: number; documentsForced: boolean; chunksForced: boolean }>
      >`
        select
          (
            select count(*)::int from information_schema.columns
            where table_schema = current_schema()
              and table_name in ('documents', 'document_chunks')
              and column_name = 'authority_kind'
          ) as "authorityColumns",
          (select relforcerowsecurity from pg_class where oid = 'documents'::regclass)
            as "documentsForced",
          (select relforcerowsecurity from pg_class where oid = 'document_chunks'::regclass)
            as "chunksForced"`;
      expect(rolledBack[0]).toEqual({
        authorityColumns: 0,
        documentsForced: true,
        chunksForced: true,
      });

      await sql`update documents set status = 'ready' where id = ${document!.id}`;
      await sql.unsafe(migrationSql);

      const [migrated] = await sql<
        Array<{
          documentKind: string;
          documentWorkspace: string | null;
          documentSubject: string | null;
          chunkKind: string;
          chunkWorkspace: string | null;
          chunkSubject: string | null;
          chunkBase: string;
        }>
      >`
        select
          document.authority_kind as "documentKind",
          document.authority_workspace_id as "documentWorkspace",
          document.authority_subject_id as "documentSubject",
          chunk.authority_kind as "chunkKind",
          chunk.authority_workspace_id as "chunkWorkspace",
          chunk.authority_subject_id as "chunkSubject",
          chunk.base_id as "chunkBase"
        from documents document
        join document_chunks chunk on chunk.document_id = document.id
        where document.id = ${document!.id}`;
      expect(migrated).toEqual({
        documentKind: "personal",
        documentWorkspace: workspace!.id,
        documentSubject: "user:alice",
        chunkKind: "personal",
        chunkWorkspace: workspace!.id,
        chunkSubject: "user:alice",
        chunkBase: base!.id,
      });

      const relations = await sql<
        Array<{ name: string; rls: boolean; forced: boolean; authorityPolicy: boolean }>
      >`
        select
          relation.relname as name,
          relation.relrowsecurity as rls,
          relation.relforcerowsecurity as forced,
          exists (
            select 1 from pg_policy policy
            where policy.polrelid = relation.oid
              and policy.polname = 'document_authority_isolation'
          ) as "authorityPolicy"
        from pg_class relation
        where relation.oid in ('documents'::regclass, 'document_chunks'::regclass)
        order by relation.relname`;
      expect([...relations]).toEqual([
        { name: "document_chunks", rls: true, forced: true, authorityPolicy: true },
        { name: "documents", rls: true, forced: true, authorityPolicy: true },
      ]);
    } finally {
      await sql.end();
    }
  }, 180_000);
});
