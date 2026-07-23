import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { provisionRoles } from "../src/provision-roles";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const expandMigration = "0103_host_export_root_session.sql";
const contractMigration = "0104_host_export_root_session_backfill.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0103-host-export-root-session");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0103] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0103/0104 host-export root session lineage (real PostgreSQL)", () => {
  test("reinforces atomic capture and fails closed before validating the rolling contract", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, prepare: false });
    const hostExportRole = `og_export_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let roleCreated = false;
    try {
      const expandSql = await readFile(join(migrationsDir, expandMigration), "utf8");
      const contractSql = await readFile(join(migrationsDir, contractMigration), "utf8");
      expect(expandSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
      expect(contractSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
      expect(contractSql).not.toMatch(/\bUPDATE\s+"host_export_outbox"/i);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const migrationFile of files.filter(
        (entry) => entry.localeCompare(expandMigration) < 0,
      )) {
        await sql.unsafe(await readFile(join(migrationsDir, migrationFile), "utf8"));
      }

      const [account] = await sql<Array<{ id: string }>>`
        insert into managed_accounts (name)
        values ('migration-0103-account') returning id`;
      const [workspace] = await sql<Array<{ id: string }>>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0103-workspace') returning id`;
      const rootId = crypto.randomUUID();
      const childId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id
        ) values (
          ${rootId}, ${account!.id}, ${workspace!.id}, 'root',
          'scripted-model', 'none', ${rootId}
        )`;
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id, parent_session_id
        ) values (
          ${childId}, ${account!.id}, ${workspace!.id}, 'child',
          'scripted-model', 'none', ${childId}, ${rootId}
        )`;

      const rootSourceId = crypto.randomUUID();
      const childSourceId = crypto.randomUUID();
      const sessionlessSourceId = crypto.randomUUID();
      for (const row of [
        { sourceId: rootSourceId, sessionId: rootId, key: "root" },
        { sourceId: childSourceId, sessionId: childId, key: "child" },
        { sourceId: sessionlessSourceId, sessionId: null, key: "sessionless" },
      ]) {
        await sql`
          insert into host_export_outbox (
            export_kind, source_id, account_id, workspace_id, session_id,
            event_type, idempotency_key, payload, envelope_bytes,
            occurred_at, source_recorded_at, enqueued_at
          ) values (
            'session_event', ${row.sourceId}, ${account!.id}, ${workspace!.id},
            ${row.sessionId}, 'test.event', ${row.key}, '{}'::jsonb, 128,
            now(), now(), now()
          )`;
      }
      const capturedBy0097 = await sql<Array<{ sourceId: string; rootSessionId: string | null }>>`
        select source_id as "sourceId", root_session_id as "rootSessionId"
        from host_export_outbox order by idempotency_key`;
      expect(
        capturedBy0097.map((row) => ({
          sourceId: row.sourceId,
          rootSessionId: row.rootSessionId,
        })),
      ).toEqual([
        { sourceId: childSourceId, rootSessionId: rootId },
        { sourceId: rootSourceId, rootSessionId: rootId },
        { sourceId: sessionlessSourceId, rootSessionId: null },
      ]);

      const provisioned = await provisionRoles(blank.databaseUrl, {
        rlsStrategy: "scoped",
        hostExportRole,
        hostExportPassword: "export-test-password",
      });
      roleCreated = true;
      expect(provisioned.hostExportRole).toBe(hostExportRole);
      await sql.unsafe(`
        CREATE FUNCTION opengeni_host_export.default_acl_probe()
        RETURNS integer LANGUAGE sql AS 'SELECT 1';
        REVOKE ALL ON FUNCTION opengeni_host_export.default_acl_probe() FROM PUBLIC;
      `);

      // Manufacture the only state the corrected chain forbids: an outbox row
      // created without 0097's trigger and conditional-root constraint. This
      // models external drift and proves 0104 never silently rewrites it.
      await sql.unsafe(`
        DROP TRIGGER host_export_outbox_capture_root_session ON host_export_outbox;
        ALTER TABLE host_export_outbox
          DROP CONSTRAINT host_export_outbox_root_session_check;
      `);
      const driftSourceId = crypto.randomUUID();
      await sql`
        insert into host_export_outbox (
          export_kind, source_id, account_id, workspace_id, session_id,
          event_type, idempotency_key, payload, envelope_bytes,
          occurred_at, source_recorded_at, enqueued_at
        ) values (
          'session_event', ${driftSourceId}, ${account!.id}, ${workspace!.id},
          ${childId}, 'test.event', 'drift-child', '{}'::jsonb, 128,
          now(), now(), now()
        )`;

      // 0103 is replay-safe reinforcement: both executions restore the trigger
      // and leased-cursor root API, but neither guesses a historical root.
      await sql.unsafe(expandSql);
      await sql.unsafe(expandSql);
      const [driftBeforeContract] = await sql<Array<{ rootSessionId: string | null }>>`
        select root_session_id as "rootSessionId"
        from host_export_outbox where source_id = ${driftSourceId}::uuid`;
      expect(driftBeforeContract?.rootSessionId).toBeNull();

      let missingCurrentSessionError: unknown;
      try {
        await sql`
          insert into host_export_outbox (
            export_kind, source_id, account_id, workspace_id, session_id,
            event_type, idempotency_key, payload, envelope_bytes,
            occurred_at, source_recorded_at, enqueued_at
          ) values (
            'session_event', ${crypto.randomUUID()}, ${account!.id}, ${workspace!.id},
            ${crypto.randomUUID()}, 'test.event', 'invalid-current-orphan', '{}'::jsonb,
            128, now(), now(), now()
          )`;
      } catch (error) {
        missingCurrentSessionError = error;
      }
      expect(missingCurrentSessionError).toBeInstanceOf(Error);
      expect((missingCurrentSessionError as Error).message).toContain(
        "does not exist in workspace",
      );

      let contractError: unknown;
      try {
        await sql.unsafe(contractSql);
      } catch (error) {
        contractError = error;
      }
      expect(contractError).toBeInstanceOf(Error);
      expect((contractError as Error).message).toContain("host_export_outbox_root_session_check");
      const [rolledBackConstraint] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from pg_constraint
        where conname = 'host_export_outbox_root_session_check'
          and conrelid = 'host_export_outbox'::regclass`;
      expect(rolledBackConstraint?.count).toBe(0);

      // Explicit operator disposition is separate from the migration. Once the
      // row has an evidence-backed root, the contract validates and replays.
      await sql`
        update host_export_outbox set root_session_id = ${rootId}::uuid
        where source_id = ${driftSourceId}::uuid`;
      await sql.unsafe(contractSql);
      await sql.unsafe(contractSql);
      const [validatedConstraint] = await sql<Array<{ validated: boolean }>>`
        select convalidated as validated from pg_constraint
        where conname = 'host_export_outbox_root_session_check'
          and conrelid = 'host_export_outbox'::regclass`;
      expect(validatedConstraint?.validated).toBe(true);

      let nullRootError: unknown;
      try {
        await sql`
          update host_export_outbox set root_session_id = null
          where source_id = ${childSourceId}::uuid`;
      } catch (error) {
        nullRootError = error;
      }
      expect(nullRootError).toBeInstanceOf(Error);
      expect((nullRootError as Error).message).toContain("host_export_outbox_root_session_check");

      const currentSourceId = crypto.randomUUID();
      await sql`
        insert into host_export_outbox (
          export_kind, source_id, account_id, workspace_id, session_id,
          event_type, idempotency_key, payload, envelope_bytes,
          occurred_at, source_recorded_at, enqueued_at
        ) values (
          'session_event', ${currentSourceId}, ${account!.id}, ${workspace!.id},
          ${childId}, 'test.event', 'current-child', '{}'::jsonb, 128,
          now(), now(), now()
        )`;

      const exporterUrl = new URL(blank.databaseUrl);
      exporterUrl.username = hostExportRole;
      exporterUrl.password = "export-test-password";
      const exporter = postgres(exporterUrl.toString(), {
        max: 1,
        prepare: false,
      });
      try {
        const [defaultAclProbe] = await exporter<Array<{ value: number }>>`
          select opengeni_host_export.default_acl_probe() as value`;
        expect(defaultAclProbe?.value).toBe(1);
        await exporter`select opengeni_host_export.register_host_export_consumer(
          'session_event', 'migration-0103-upgrade'
        )`;
        await exporter`select opengeni_host_export.allocate_host_export_cursors(
          'session_event', 100
        )`;
        const leaseToken = crypto.randomUUID();
        const claimed = await exporter`
          select * from opengeni_host_export.claim_host_export_batch(
            'session_event', 'migration-0103-upgrade', ${leaseToken}::uuid,
            'migration-test', 60, 100, 1048576
          )`;
        expect(claimed.length).toBe(5);
        const roots = await exporter<Array<{ rootSessionId: string | null }>>`
          select root_session_id as "rootSessionId"
          from opengeni_host_export.host_export_cursor_roots(
            'session_event', 'migration-0103-upgrade', ${leaseToken}::uuid
          )
          order by export_cursor`;
        expect(roots).toHaveLength(5);
        expect(roots.filter((row) => row.rootSessionId === rootId)).toHaveLength(4);
        expect(roots.filter((row) => row.rootSessionId === null)).toHaveLength(1);
      } finally {
        await exporter.end();
      }
    } finally {
      if (roleCreated) {
        await sql
          .unsafe(
            `ALTER DEFAULT PRIVILEGES IN SCHEMA opengeni_host_export REVOKE EXECUTE ON FUNCTIONS FROM "${hostExportRole}"`,
          )
          .catch(() => undefined);
        await sql.unsafe(`DROP OWNED BY "${hostExportRole}"`).catch(() => undefined);
        await sql.unsafe(`DROP ROLE IF EXISTS "${hostExportRole}"`).catch(() => undefined);
      }
      await sql.end();
    }
  }, 180_000);
});
