import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0097_host_export_outbox.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0097-host-export");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0097] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0097 durable host export migration (real PostgreSQL)", () => {
  test("migrates populated source tables without manufacturing historical exports", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, prepare: false });
    const hostExportRole = `og_export_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let roleCreated = false;
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const migrationFile of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, migrationFile), "utf8"));
      }

      const [account] = await sql<Array<{ id: string }>>`
        insert into managed_accounts (name) values ('migration-0097-account') returning id`;
      const [workspace] = await sql<Array<{ id: string }>>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0097-workspace') returning id`;
      const sessionId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model, sandbox_backend,
          sandbox_group_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'populated session',
          'scripted-model', 'none', ${sessionId}
        )`;
      const turnId = crypto.randomUUID();
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model,
          reasoning_effort, sandbox_backend
        ) values (
          ${turnId}, ${account!.id}, ${workspace!.id}, ${sessionId},
          ${crypto.randomUUID()}, ${`session-${sessionId}`}, 'queued', 1,
          'populated prompt', 'scripted-model', 'low', 'none'
        )`;
      await sql`
        insert into session_events (
          account_id, workspace_id, session_id, turn_id, sequence, type, payload
        ) values (
          ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
          'turn.queued', ${sql.json({ historical: true })}
        )`;
      await sql`
        insert into usage_events (
          account_id, workspace_id, event_type, quantity, unit,
          idempotency_key, occurred_at
        ) values (
          ${account!.id}, ${workspace!.id}, 'agent_run.created', 1, ${"u".repeat(512)},
          ${`historical:${turnId}`}, now()
        )`;

      await sql.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const [empty] = await sql<Array<{ count: string }>>`
        select count(*)::text as count from host_export_outbox`;
      expect(empty?.count).toBe("0");
      const [config] = await sql<Array<{ eventsEnabled: boolean; usageEnabled: boolean }>>`
        select session_events_enabled as "eventsEnabled",
          usage_events_enabled as "usageEnabled"
        from host_export_config where id = 1`;
      expect(config).toEqual({ eventsEnabled: false, usageEnabled: false });
      await sql`
        insert into usage_events (
          account_id, workspace_id, event_type, quantity, unit,
          idempotency_key, occurred_at
        ) values (
          ${account!.id}, ${workspace!.id}, 'agent_run.created', 1,
          ${"u".repeat(512)}, ${`disabled-after-migration:${turnId}`}, now()
        )`;
      const [stillEmpty] = await sql<Array<{ count: string }>>`
        select count(*)::text as count from host_export_outbox`;
      expect(stillEmpty?.count).toBe("0");

      await sql`select opengeni_host_export.register_host_export_consumer(
        'session_event', 'migration-0097-events'
      )`;
      await sql`select opengeni_host_export.register_host_export_consumer(
        'usage_event', 'migration-0097-usage'
      )`;
      const newEventId = crypto.randomUUID();
      await sql`
        insert into session_events (
          id, account_id, workspace_id, session_id, turn_id, sequence, type, payload
        ) values (
          ${newEventId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 2,
          'agent.message.completed', ${sql.json({ current: true })}
        )`;
      await sql`
        insert into usage_events (
          account_id, workspace_id, session_id, turn_id, event_type, quantity,
          unit, source_resource_type, source_resource_id, idempotency_key,
          occurred_at
        ) values (
          ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId},
          'agent_run.completed', 1, 'run', 'session_turn', ${turnId},
          ${`current:${turnId}`}, now()
        )`;
      const exported = await sql<Array<{ kind: string; sourceId: string }>>`
        select export_kind as kind, source_id as "sourceId"
        from host_export_outbox order by export_kind`;
      expect(exported).toHaveLength(2);
      expect(
        exported.some((row) => row.kind === "session_event" && row.sourceId === newEventId),
      ).toBe(true);
      expect(exported.some((row) => row.kind === "usage_event")).toBe(true);

      let oversizedExportError: unknown;
      try {
        await sql`
          insert into usage_events (
            account_id, workspace_id, event_type, quantity, unit,
            idempotency_key, occurred_at
          ) values (
            ${account!.id}, ${workspace!.id}, 'agent_run.created', 1,
            ${"u".repeat(129)}, ${`oversized-current:${turnId}`}, now()
          )`;
      } catch (error) {
        oversizedExportError = error;
      }
      expect(oversizedExportError).toBeInstanceOf(Error);
      expect((oversizedExportError as Error).message).toContain("host-export wire bounds");

      const provisioned = await provisionRoles(blank.databaseUrl, {
        rlsStrategy: "scoped",
        hostExportRole,
        hostExportPassword: "export-test-password",
      });
      roleCreated = true;
      expect(provisioned.hostExportRole).toBe(hostExportRole);
      const exporterUrl = new URL(blank.databaseUrl);
      exporterUrl.username = hostExportRole;
      exporterUrl.password = "export-test-password";
      const roleSql = postgres(exporterUrl.toString(), {
        max: 1,
        prepare: false,
      });
      try {
        await roleSql`select opengeni_host_export.register_host_export_consumer(
          'session_event', 'migration-role-events'
        )`;
        let directReadError: unknown;
        try {
          await roleSql`select * from host_export_outbox limit 1`;
        } catch (error) {
          directReadError = error;
        }
        expect(directReadError).toBeInstanceOf(Error);
      } finally {
        await roleSql.end();
      }

      let failedConcurrentBuild: unknown;
      try {
        await sql.unsafe(
          'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "usage_events_workspace_session_idx" ON "usage_events" ("unit")',
        );
      } catch (error) {
        failedConcurrentBuild = error;
      }
      expect(failedConcurrentBuild).toBeInstanceOf(Error);
      const [invalidIndex] = await sql<Array<{ valid: boolean; ready: boolean }>>`
        select i.indisvalid as valid, i.indisready as ready
        from pg_catalog.pg_class c
        join pg_catalog.pg_index i on i.indexrelid = c.oid
        where c.relname = 'usage_events_workspace_session_idx'`;
      expect(invalidIndex?.valid).toBe(false);

      await sql.unsafe(`
        create table if not exists schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      for (const applied of files.filter((entry) => entry.localeCompare(migration) <= 0)) {
        await sql`insert into schema_migrations (name) values (${applied}) on conflict do nothing`;
      }
      await migrate(blank.databaseUrl);
      const [recoveredIndex] = await sql<
        Array<{ valid: boolean; ready: boolean; definition: string }>
      >`
        select i.indisvalid as valid, i.indisready as ready,
          pg_catalog.pg_get_indexdef(c.oid) as definition
        from pg_catalog.pg_class c
        join pg_catalog.pg_index i on i.indexrelid = c.oid
        where c.relname = 'usage_events_workspace_session_idx'`;
      expect(recoveredIndex).toMatchObject({ valid: true, ready: true });
      expect(recoveredIndex?.definition).toContain("workspace_id, session_id, occurred_at");
    } finally {
      if (roleCreated) {
        await sql.unsafe(`DROP OWNED BY "${hostExportRole}"`).catch(() => undefined);
        await sql.unsafe(`DROP ROLE IF EXISTS "${hostExportRole}"`).catch(() => undefined);
      }
      await sql.end();
    }
  }, 180_000);
});
