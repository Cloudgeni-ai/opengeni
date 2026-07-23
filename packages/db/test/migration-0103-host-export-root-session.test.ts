import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { provisionRoles } from "../src/provision-roles";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const expandMigration = "0103_host_export_root_session.sql";
const backfillMigration = "0104_host_export_root_session_backfill.sql";
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
  test("captures new children before the maintenance backfill resolves legacy lineages", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, prepare: false });
    const hostExportRole = `og_export_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let roleCreated = false;
    try {
      const expandSql = await readFile(join(migrationsDir, expandMigration), "utf8");
      const backfillSql = await readFile(join(migrationsDir, backfillMigration), "utf8");
      expect(expandSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
      expect(backfillSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
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
      const orphanSourceId = crypto.randomUUID();
      const orphanSessionId = crypto.randomUUID();
      for (const row of [
        { sourceId: rootSourceId, sessionId: rootId, key: "legacy-root" },
        { sourceId: childSourceId, sessionId: childId, key: "legacy-child" },
        {
          sourceId: orphanSourceId,
          sessionId: orphanSessionId,
          key: "legacy-orphan",
        },
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

      await sql.unsafe(expandSql);

      const beforeBackfill = await sql<Array<{ sourceId: string; rootSessionId: string | null }>>`
        select source_id as "sourceId", root_session_id as "rootSessionId"
        from host_export_outbox
        where source_id in (
          ${rootSourceId}::uuid,
          ${childSourceId}::uuid,
          ${orphanSourceId}::uuid
        )
        order by idempotency_key`;
      expect(
        beforeBackfill.map((row) => ({
          sourceId: row.sourceId,
          rootSessionId: row.rootSessionId,
        })),
      ).toEqual([
        { sourceId: childSourceId, rootSessionId: null },
        { sourceId: orphanSourceId, rootSessionId: null },
        { sourceId: rootSourceId, rootSessionId: null },
      ]);

      const newSourceId = crypto.randomUUID();
      await sql`
        insert into host_export_outbox (
          export_kind, source_id, account_id, workspace_id, session_id,
          event_type, idempotency_key, payload, envelope_bytes,
          occurred_at, source_recorded_at, enqueued_at
        ) values (
          'session_event', ${newSourceId}, ${account!.id}, ${workspace!.id},
          ${childId}, 'test.event', 'current-child', '{}'::jsonb, 128,
          now(), now(), now()
        )`;
      const [captured] = await sql<Array<{ rootSessionId: string | null }>>`
        select root_session_id as "rootSessionId"
        from host_export_outbox where source_id = ${newSourceId}::uuid`;
      expect(captured?.rootSessionId).toBe(rootId);

      let missingCurrentSessionError: unknown;
      try {
        await sql`
          insert into host_export_outbox (
            export_kind, source_id, account_id, workspace_id, session_id,
            event_type, idempotency_key, payload, envelope_bytes,
            occurred_at, source_recorded_at, enqueued_at
          ) values (
            'session_event', ${crypto.randomUUID()}, ${account!.id}, ${workspace!.id},
            ${orphanSessionId}, 'test.event', 'invalid-current-orphan', '{}'::jsonb,
            128, now(), now(), now()
          )`;
      } catch (error) {
        missingCurrentSessionError = error;
      }
      expect(missingCurrentSessionError).toBeInstanceOf(Error);
      expect((missingCurrentSessionError as Error).message).toContain(
        "does not exist in workspace",
      );

      await sql.unsafe(backfillSql);
      const backfilled = await sql<Array<{ sourceId: string; rootSessionId: string | null }>>`
        select source_id as "sourceId", root_session_id as "rootSessionId"
        from host_export_outbox
        where source_id in (
          ${rootSourceId}::uuid,
          ${childSourceId}::uuid,
          ${orphanSourceId}::uuid
        )
        order by idempotency_key`;
      expect(
        backfilled.map((row) => ({
          sourceId: row.sourceId,
          rootSessionId: row.rootSessionId,
        })),
      ).toEqual([
        { sourceId: childSourceId, rootSessionId: rootId },
        { sourceId: orphanSourceId, rootSessionId: null },
        { sourceId: rootSourceId, rootSessionId: rootId },
      ]);

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
        expect(claimed.length).toBe(4);
        const roots = await exporter<Array<{ rootSessionId: string | null }>>`
          select root_session_id as "rootSessionId"
          from opengeni_host_export.host_export_cursor_roots(
            'session_event', 'migration-0103-upgrade', ${leaseToken}::uuid
          )
          order by export_cursor`;
        expect(roots).toHaveLength(4);
        expect(roots.filter((row) => row.rootSessionId === rootId)).toHaveLength(3);
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
