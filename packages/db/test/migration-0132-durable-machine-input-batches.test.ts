import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0132_durable_machine_input_batches.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0132");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0132] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0132 (durable machine-input batches)", () => {
  test("backfills delivered batches at their causal position and removes deferred state", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await sql.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await sql`
          insert into schema_migrations (name)
          values (${file})
          on conflict do nothing
        `;
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0132-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0132-workspace') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspace!.id}, ${account!.id})`;
      const sessionId = crypto.randomUUID();
      const turnId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id
        ) values (
          ${sessionId}, ${account!.id}, ${workspace!.id}, 'idle', 'fixture',
          'test-model', 'none', ${sessionId}, ${`session-${sessionId}`}
        )`;
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, resources,
          tools, model, reasoning_effort, sandbox_backend, metadata, lineage,
          execution_generation
        ) values (
          ${turnId}, ${account!.id}, ${workspace!.id}, ${sessionId}, ${crypto.randomUUID()},
          ${`session-${sessionId}`}, 'completed', 'user', 1, 'human request',
          '[]'::jsonb, '[]'::jsonb, 'test-model', 'low', 'none',
          '{}'::jsonb, '{}'::jsonb, 1
        )`;
      await sql`
        insert into session_history_items (
          account_id, workspace_id, session_id, turn_id, position, item
        ) values
          (
            ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 0,
            ${sql.json({ type: "message", role: "user", content: "human request" })}
          ),
          (
            ${account!.id}, ${workspace!.id}, ${sessionId}, ${turnId}, 1,
            ${sql.json({ type: "message", role: "assistant", content: "response" })}
          )`;
      const deliveredId = crypto.randomUUID();
      const pendingId = crypto.randomUUID();
      await sql`
        insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, classification,
          source_id, dedupe_key, summary, payload, lineage, state,
          delivered_turn_id, delivered_at
        ) values
          (
            ${deliveredId}, ${account!.id}, ${workspace!.id}, ${sessionId},
            'agent_message', 'info', 'source-agent', 'delivered-agent-message',
            'Important durable instruction',
            ${sql.json({
              type: "agent_message",
              text: "Important durable instruction",
              operationId: crypto.randomUUID(),
            })},
            ${sql.json({ callerSessionId: "source-agent" })},
            'delivered', ${turnId}, now()
          ),
          (
            ${pendingId}, ${account!.id}, ${workspace!.id}, ${sessionId},
            'child_terminal_result', 'success', 'child', 'deferred-child',
            'Child completed',
            ${sql.json({
              type: "child_terminal_result",
              childSessionId: crypto.randomUUID(),
              status: "idle",
            })},
            '{}'::jsonb, 'deferred', null, null
          )`;

      const compactedSessionId = crypto.randomUUID();
      const compactedTurnId = crypto.randomUUID();
      const compactedUpdateId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id, last_sequence
        ) values (
          ${compactedSessionId}, ${account!.id}, ${workspace!.id}, 'idle',
          'compacted fixture', 'test-model', 'none', ${compactedSessionId},
          ${`session-${compactedSessionId}`}, 1
        )`;
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, resources,
          tools, model, reasoning_effort, sandbox_backend, metadata, lineage,
          execution_generation
        ) values (
          ${compactedTurnId}, ${account!.id}, ${workspace!.id}, ${compactedSessionId},
          ${crypto.randomUUID()}, ${`session-${compactedSessionId}`}, 'completed',
          'system', 1, 'Process the delivered internal session updates.',
          '[]'::jsonb, '[]'::jsonb, 'test-model', 'low', 'none',
          '{}'::jsonb, '{}'::jsonb, 1
        )`;
      await sql`
        insert into session_history_items (
          account_id, workspace_id, session_id, turn_id, position, item, active
        ) values
          (
            ${account!.id}, ${workspace!.id}, ${compactedSessionId}, ${compactedTurnId}, 0,
            ${sql.json({ type: "message", role: "assistant", content: "old response" })},
            false
          ),
          (
            ${account!.id}, ${workspace!.id}, ${compactedSessionId}, ${compactedTurnId}, 1,
            ${sql.json({ type: "message", role: "user", content: "compaction summary" })},
            true
          )`;
      await sql`
        insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, classification,
          source_id, dedupe_key, summary, payload, lineage, state,
          delivered_turn_id, delivered_at
        ) values (
          ${compactedUpdateId}, ${account!.id}, ${workspace!.id}, ${compactedSessionId},
          'agent_message', 'info', 'old-agent', 'compacted-agent-message',
          'Input already consumed by an explicit compaction',
          ${sql.json({
            type: "agent_message",
            text: "Input already consumed by an explicit compaction",
            operationId: crypto.randomUUID(),
          })},
          '{}'::jsonb, 'delivered', ${compactedTurnId}, now() - interval '1 hour'
        )`;
      await sql`
        insert into session_events (
          account_id, workspace_id, session_id, sequence, type, payload, occurred_at
        ) values (
          ${account!.id}, ${workspace!.id}, ${compactedSessionId}, 1,
          'session.context.compacted', '{}'::jsonb, now()
        )`;

      await sql.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      const [delivered] = await sql<
        Array<{ state: string; history_item_id: string; position: string; item: unknown }>
      >`
        select updates.state,
               updates.delivered_history_item_id as history_item_id,
               history.position::text,
               history.item
        from session_system_updates updates
        join session_history_items history
          on history.id = updates.delivered_history_item_id
        where updates.id = ${deliveredId}`;
      expect(delivered?.state).toBe("delivered");
      expect(Number(delivered?.position)).toBeGreaterThan(0);
      expect(Number(delivered?.position)).toBeLessThan(1);
      expect(delivered?.item).toMatchObject({ type: "message", role: "system" });
      expect(JSON.stringify(delivered?.item)).toContain("Important durable instruction");

      const [pending] = await sql<Array<{ state: string; history_item_id: string | null }>>`
        select state, delivered_history_item_id as history_item_id
        from session_system_updates where id = ${pendingId}`;
      expect(pending).toEqual({ state: "pending", history_item_id: null });

      const [compacted] = await sql<
        Array<{ history_item_id: string; reconstructed_active: boolean; active_count: string }>
      >`
        select
          updates.delivered_history_item_id as history_item_id,
          history.active as reconstructed_active,
          (
            select count(*)::text
            from session_history_items active_history
            where active_history.session_id = ${compactedSessionId}
              and active_history.active
          ) as active_count
        from session_system_updates updates
        join session_history_items history
          on history.id = updates.delivered_history_item_id
        where updates.id = ${compactedUpdateId}`;
      expect(compacted?.history_item_id).toBeTruthy();
      expect(compacted?.reconstructed_active).toBe(false);
      expect(compacted?.active_count).toBe("1");

      let constraintError: unknown;
      try {
        await sql`
          update session_system_updates
          set delivered_history_item_id = null
          where id = ${deliveredId}
        `;
      } catch (error) {
        constraintError = error;
      }
      expect(constraintError).toBeTruthy();
    } finally {
      await sql.end();
    }
  }, 180_000);
});
