import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0061");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0061] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0061 (revisioned workflow wake outbox)", () => {
  test("migrates populated control receipts and seeds already-committed maintenance work", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const pre0061 = files.filter((file) => file < "0061_");
      await admin.unsafe(
        `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
      );
      for (const file of pre0061) {
        await applyFile(admin, file);
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [account] = await admin<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0061-account') returning id`;
      const [workspace] = await admin<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0061-workspace') returning id`;
      const sessionId = crypto.randomUUID();
      const workflowId = `session-${sessionId}`;
      await admin`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id, compact_requested
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'maintenance pending',
          'scripted-model', 'none', ${sessionId}, ${workflowId}, true
        )`;
      await admin`
        insert into runtime_control_operations (
          account_id, workspace_id, scope, target_id, client_event_id,
          requested_state, expected_state, expected_generation, result
        ) values (
          ${account!.id}, ${workspace!.id}, 'workspace', ${workspace!.id},
          'legacy-workspace-control', 'active', 'paused', 4,
          ${admin.json({
            state: "active",
            generation: 5,
            affectedSessionIds: [sessionId],
            exceptionSessionIds: [],
            wakeSessionIds: [sessionId],
          })}
        )`;

      await applyFile(admin, "0061_session_workflow_wake_outbox.sql");

      const [receipt] = await admin<{ controls: unknown }[]>`
        select result -> 'controls' as controls
        from runtime_control_operations
        where client_event_id = 'legacy-workspace-control'`;
      expect(receipt?.controls).toEqual([]);
      const [wake] = await admin<
        Array<{
          session_id: string;
          temporal_workflow_id: string;
          wake_revision: number;
          delivered_revision: number;
          reason: string;
        }>
      >`
        select session_id, temporal_workflow_id,
          wake_revision::integer as wake_revision,
          delivered_revision::integer as delivered_revision,
          reason
        from session_workflow_wake_outbox where session_id = ${sessionId}`;
      expect(wake).toEqual({
        session_id: sessionId,
        temporal_workflow_id: workflowId,
        wake_revision: 1,
        delivered_revision: 0,
        reason: "cutover_seed",
      });
      const [functions] = await admin<Array<{ old_scan: string | null; new_claim: string | null }>>`
        select
          to_regprocedure('opengeni_private.list_enrollable_sessions(integer)')::text as old_scan,
          to_regprocedure('opengeni_private.claim_session_workflow_wakes(integer)')::text as new_claim`;
      expect(functions?.old_scan).toBeNull();
      expect(functions?.new_claim).not.toBeNull();
    } finally {
      await admin.end().catch(() => undefined);
    }
  }, 180_000);
});
