import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0076");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0076] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0076 (atomic session initialization receipt)", () => {
  test("is a rolling metadata-only expansion that preserves legacy binaries and enforces new receipts", async () => {
    if (!available || !blank) return;

    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const migrationName = "0076_atomic_session_initialization.sql";
      const migrationSql = await readFile(join(migrationsDir, migrationName), "utf8");
      expect(migrationSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");

      await admin.unsafe(
        "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const file of files.filter((file) => file < "0076_")) {
        await admin.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name)
        values ('migration-0076-account')
        returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0076-workspace')
        returning id`;
      const legacySessionId = crypto.randomUUID();
      const [legacyBefore] = await admin<Array<{ ctid: string }>>`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${legacySessionId}, ${account!.id}, ${workspace!.id}, 'idle',
          'legacy request semantics are unavailable', 'scripted-model', 'none',
          ${legacySessionId}, ${`session-${legacySessionId}`}
        )
        returning ctid::text as ctid`;

      await migrate(blank.databaseUrl);

      const [legacyAfter] = await admin<
        Array<{
          ctid: string;
          create_request_fingerprint: string | null;
          initialization_version: number;
          initial_workflow_wake_revision: number | null;
        }>
      >`
        select ctid::text as ctid, create_request_fingerprint,
          initialization_version, initial_workflow_wake_revision::integer
        from sessions
        where id = ${legacySessionId}`;
      expect(legacyAfter).toEqual({
        ctid: legacyBefore!.ctid,
        create_request_fingerprint: null,
        initialization_version: 0,
        initial_workflow_wake_revision: null,
      });

      const constraints = await admin<Array<{ name: string; validated: boolean }>>`
        select conname as name, convalidated as validated
        from pg_constraint
        where conrelid = 'sessions'::regclass
          and conname in (
            'sessions_initialization_version_check',
            'sessions_create_request_fingerprint_check',
            'sessions_initial_workflow_wake_revision_check',
            'sessions_canonical_initialization_receipt_check'
          )
        order by conname`;
      expect(constraints).toHaveLength(4);
      expect(constraints.every((constraint) => constraint.validated === false)).toBe(true);

      const [defaultMetadata] = await admin<
        Array<{ has_missing: boolean; missing_value: string | null }>
      >`
        select atthasmissing as has_missing, attmissingval::text as missing_value
        from pg_attribute
        where attrelid = 'sessions'::regclass
          and attname = 'initialization_version'`;
      expect(defaultMetadata).toEqual({
        has_missing: true,
        missing_value: "{0}",
      });

      // A pre-0076 binary names only its known columns. Its reads, updates, and
      // inserts remain valid; omitted receipt fields keep the row explicitly
      // legacy rather than fabricating a canonical initialization.
      const [oldRead] = await admin<Array<{ initial_message: string; model: string }>>`
        select initial_message, model from sessions where id = ${legacySessionId}`;
      expect(oldRead).toEqual({
        initial_message: "legacy request semantics are unavailable",
        model: "scripted-model",
      });
      await admin`
        update sessions set model = 'scripted-model-v2'
        where id = ${legacySessionId}`;
      const oldBinarySessionId = crypto.randomUUID();
      await admin`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${oldBinarySessionId}, ${account!.id}, ${workspace!.id}, 'idle',
          'old binary insert', 'scripted-model', 'none', ${oldBinarySessionId},
          ${`session-${oldBinarySessionId}`}
        )`;
      const [oldInsert] = await admin<
        Array<{
          initialization_version: number;
          create_request_fingerprint: string | null;
        }>
      >`
        select initialization_version, create_request_fingerprint
        from sessions where id = ${oldBinarySessionId}`;
      expect(oldInsert).toEqual({
        initialization_version: 0,
        create_request_fingerprint: null,
      });

      const insertReceipt = async (input: {
        fingerprint: string | null;
        version: number;
        workflowId: string | null;
        wakeRevision: number | null;
      }): Promise<void> => {
        const sessionId = crypto.randomUUID();
        await admin`
          insert into sessions (
            id, account_id, workspace_id, status, initial_message, model,
            sandbox_backend, sandbox_group_id, temporal_workflow_id,
            create_request_fingerprint, initialization_version,
            initial_workflow_wake_revision
          ) values (
            ${sessionId}, ${account!.id}, ${workspace!.id}, 'queued',
            'canonical candidate', 'scripted-model', 'none', ${sessionId},
            ${input.workflowId}, ${input.fingerprint}, ${input.version},
            ${input.wakeRevision}
          )`;
      };

      const fingerprint = `v1:${"a".repeat(64)}`;
      await insertReceipt({
        fingerprint,
        version: 1,
        workflowId: `session-${crypto.randomUUID()}`,
        wakeRevision: 1,
      });
      await expect(
        insertReceipt({
          fingerprint: null,
          version: 1,
          workflowId: `session-${crypto.randomUUID()}`,
          wakeRevision: 1,
        }),
      ).rejects.toThrow();
      await expect(
        insertReceipt({
          fingerprint: "not-a-v1-fingerprint",
          version: 1,
          workflowId: `session-${crypto.randomUUID()}`,
          wakeRevision: 1,
        }),
      ).rejects.toThrow();
      await expect(
        insertReceipt({
          fingerprint,
          version: 1,
          workflowId: `session-${crypto.randomUUID()}`,
          wakeRevision: 0,
        }),
      ).rejects.toThrow();
      await expect(
        insertReceipt({
          fingerprint,
          version: 2,
          workflowId: `session-${crypto.randomUUID()}`,
          wakeRevision: 1,
        }),
      ).rejects.toThrow();
      await expect(
        insertReceipt({
          fingerprint,
          version: 1,
          workflowId: null,
          wakeRevision: 1,
        }),
      ).rejects.toThrow();

      const [ledgerBefore] = await admin<{ count: number }[]>`
        select count(*)::integer as count
        from schema_migrations where name = ${migrationName}`;
      expect(ledgerBefore?.count).toBe(1);
      await migrate(blank.databaseUrl);
      const [ledgerAfter] = await admin<{ count: number }[]>`
        select count(*)::integer as count
        from schema_migrations where name = ${migrationName}`;
      expect(ledgerAfter?.count).toBe(1);
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 300_000);
});
