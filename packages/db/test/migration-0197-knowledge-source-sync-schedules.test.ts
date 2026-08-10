import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationUrl = new URL(
  "../drizzle/0197_knowledge_source_sync_schedules.sql",
  import.meta.url,
);

describe("migration 0197 knowledge source sync schedules", () => {
  test("is a drained maintenance cutover, bounded, RLS-protected, and contains no agent/session producer", async () => {
    const source = await readFile(migrationUrl, "utf8");
    expect(source.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
    expect(source).toContain("SET LOCAL lock_timeout = '5s'");
    expect(source).toContain("SET LOCAL statement_timeout = '30min'");
    expect(source.match(/FROM pg_stat_activity/g)).toHaveLength(2);
    expect(source).toContain("usename = 'opengeni_app'");
    expect(source).toContain('LOCK TABLE "scheduled_tasks" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain('LOCK TABLE "documents" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain("all opengeni_app sessions to be stopped");
    expect(source).toContain(`DEFAULT '{"kind":"agent_turn"}'::jsonb`);
    expect(source).toContain("knowledge_source_sync_states");
    expect(source).toContain("knowledge_source_sync_item_outcomes");
    expect(source).toContain("knowledge_source_sync_wakes");
    expect(source).toContain("knowledge_source_sync_index_obligations");
    expect(source).toContain("knowledge_source_sync_object_observations");
    expect(source).toContain("active_scan_generation");
    expect(source).toContain("knowledge_document_versions_object_external_version_idx");
    expect(source).toContain("knowledge_source_identity");
    expect(source).toContain("knowledge_source_object_id");
    expect(source).toContain("source_sync_generation");
    expect(source).toContain("initiating_subject_id");
    expect(source).toContain("documents_workspace_knowledge_source_identity_uq");
    expect(source).toContain("knowledge_source_sync_lock_authority");
    expect(source).toContain('REFERENCES "scheduled_task_runs"("id") ON DELETE SET NULL');
    expect(source).toContain("buffered_scheduled_task_run_id");
    expect(source).toContain("ENABLE ROW LEVEL SECURITY");
    expect(source).toContain("FORCE ROW LEVEL SECURITY");
    expect(source).toContain("NOT VALID");
    expect(source).toContain("VALIDATE CONSTRAINT");
    expect(source).not.toContain('"target_session_id"');
    expect(source).not.toMatch(/create\s+table\s+.*session/i);
    expect(source).not.toMatch(/agent_run\.created/i);

    const blank = await acquireBlankTestDatabase("migration-0191");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await migrate(blank.databaseUrl);
      const tables = await sql<Array<{ name: string; rls: boolean; forced: boolean }>>`
        select relname as name, relrowsecurity as rls, relforcerowsecurity as forced
        from pg_class
        where relnamespace = 'public'::regnamespace
          and relname in (
            'knowledge_source_sync_states',
            'knowledge_source_sync_item_outcomes',
            'knowledge_source_sync_wakes',
            'knowledge_source_sync_index_obligations',
            'knowledge_source_sync_object_observations'
          )
        order by relname`;
      expect([...tables]).toEqual([
        { name: "knowledge_source_sync_index_obligations", rls: true, forced: true },
        { name: "knowledge_source_sync_item_outcomes", rls: true, forced: true },
        { name: "knowledge_source_sync_object_observations", rls: true, forced: true },
        { name: "knowledge_source_sync_states", rls: true, forced: true },
        { name: "knowledge_source_sync_wakes", rls: true, forced: true },
      ]);
      const columns = await sql<Array<{ tableName: string; columnName: string }>>`
        select table_name as "tableName", column_name as "columnName"
        from information_schema.columns
        where table_schema = 'public'
          and (
            (table_name = 'scheduled_tasks' and column_name = 'action')
            or (table_name = 'scheduled_task_runs' and column_name in (
              'action_kind', 'knowledge_sync_run_id', 'knowledge_summary', 'completed_at'
            ))
          )
        order by table_name, column_name`;
      expect(columns).toHaveLength(5);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);

  test("rejects a live pre-cutover application session before taking table locks", async () => {
    const blank = await acquireBlankTestDatabase("migration-0197-live-app");
    if (!blank) return;
    const source = await readFile(migrationUrl, "utf8");
    const admin = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    const appUrl = new URL(blank.databaseUrl);
    appUrl.username = "opengeni_app";
    appUrl.password = "apppw";
    const app = postgres(appUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      await app`select 1`;
      const preflight = source.match(
        /DO \$knowledge_source_sync_maintenance_preflight\$[\s\S]*?\$knowledge_source_sync_maintenance_preflight\$;/,
      )?.[0];
      expect(preflight).toBeDefined();
      let failure: unknown = null;
      try {
        await admin.unsafe(preflight!);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "55000" });
    } finally {
      await app.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      await blank.release();
    }
  }, 60_000);
});
