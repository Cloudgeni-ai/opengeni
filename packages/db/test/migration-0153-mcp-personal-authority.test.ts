import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { McpPersonalConnectionDelegation } from "@opengeni/contracts";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0153_mcp_personal_connection_delegations.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0153-mcp-personal-authority");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0153] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

async function expectSqlFailure(work: Promise<unknown>, message: string): Promise<void> {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

describe("0153 personal MCP authority (real PostgreSQL)", () => {
  test("is rolling, exact, immutable, parent-fenced, and executable by the runtime role", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      expect(migrationSql.split("\n", 1)[0]).toBe("-- deployment-mode: rolling");

      await sql.unsafe(`
        do $$ begin
          if not exists (select 1 from pg_roles where rolname = 'opengeni_app') then
            create role opengeni_app with login nosuperuser nobypassrls
              nocreaterole nocreatedb noreplication noinherit password 'migration-0153-test';
          else
            alter role opengeni_app with login nosuperuser nobypassrls
              nocreaterole nocreatedb noreplication noinherit password 'migration-0153-test';
          end if;
        end $$;
      `);
      await sql.unsafe(`
        create table schema_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        );
      `);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const migrationFile of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, migrationFile), "utf8"));
        await sql`
          insert into schema_migrations (name) values (${migrationFile})
          on conflict do nothing`;
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0153-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0153-workspace') returning id`;
      const [otherWorkspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0153-other-workspace') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values
          (${workspace!.id}, ${account!.id}),
          (${otherWorkspace!.id}, ${account!.id})`;

      const parentSessionId = crypto.randomUUID();
      const otherSessionId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id, tool_policy
        ) values
          (
            ${parentSessionId}, ${account!.id}, ${workspace!.id}, 'idle',
            'legacy parent', 'scripted-model', 'none', ${parentSessionId},
            ${`session-${parentSessionId}`},
            ${sql.json({ mode: "explicit", inheritedFromSessionId: null })}
          ),
          (
            ${otherSessionId}, ${account!.id}, ${otherWorkspace!.id}, 'idle',
            'other parent', 'scripted-model', 'none', ${otherSessionId},
            ${`session-${otherSessionId}`},
            ${sql.json({ mode: "explicit", inheritedFromSessionId: null })}
          )`;
      const parentTurnId = crypto.randomUUID();
      const otherTurnId = crypto.randomUUID();
      await sql`
        insert into session_turns (
          id, account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, source, position, prompt, resources,
          tools, model, reasoning_effort, sandbox_backend, metadata, lineage,
          execution_generation
        ) values
          (
            ${parentTurnId}, ${account!.id}, ${workspace!.id}, ${parentSessionId},
            ${crypto.randomUUID()}, ${`session-${parentSessionId}`}, 'completed',
            'user', 1, 'legacy parent turn', '[]'::jsonb, '[]'::jsonb,
            'scripted-model', 'low', 'none', '{}'::jsonb, '{}'::jsonb, 1
          ),
          (
            ${otherTurnId}, ${account!.id}, ${otherWorkspace!.id}, ${otherSessionId},
            ${crypto.randomUUID()}, ${`session-${otherSessionId}`}, 'completed',
            'user', 1, 'other turn', '[]'::jsonb, '[]'::jsonb,
            'scripted-model', 'low', 'none', '{}'::jsonb, '{}'::jsonb, 1
          )`;

      const legacyUpdateId = crypto.randomUUID();
      await sql`
        insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, classification,
          source_id, dedupe_key, summary, payload, lineage
        ) values (
          ${legacyUpdateId}, ${account!.id}, ${workspace!.id}, ${parentSessionId},
          'agent_message', 'info', 'legacy-source', 'legacy-update', 'legacy update',
          ${sql.json({
            type: "agent_message",
            text: "legacy update",
            operationId: crypto.randomUUID(),
          })},
          '{}'::jsonb
        )`;
      const legacyOutboxId = crypto.randomUUID();
      await sql`
        insert into session_system_update_outbox (
          id, account_id, workspace_id, source_session_id, target_session_id,
          dedupe_key, kind, classification, source_id, summary, payload, lineage
        ) values (
          ${legacyOutboxId}, ${account!.id}, ${workspace!.id}, ${parentSessionId},
          ${parentSessionId}, 'legacy-outbox', 'child_terminal_result', 'success',
          ${parentSessionId}, 'legacy outbox',
          ${sql.json({
            type: "child_terminal_result",
            childSessionId: parentSessionId,
            status: "idle",
          })},
          '{}'::jsonb
        )`;
      const legacyTaskId = crypto.randomUUID();
      await sql`
        insert into scheduled_tasks (
          id, account_id, workspace_id, name, status, schedule,
          temporal_schedule_id, run_mode, overlap_policy, agent_config, metadata
        ) values (
          ${legacyTaskId}, ${account!.id}, ${workspace!.id}, 'legacy task', 'active',
          ${sql.json({ type: "interval", everySeconds: 3600 })},
          ${`scheduled-task-${legacyTaskId}`}, 'new_session_per_run', 'allow_concurrent',
          ${sql.json({ prompt: "legacy scheduled work", resources: [], tools: [], metadata: {} })},
          '{}'::jsonb
        )`;

      await sql.unsafe(migrationSql);

      const [legacy] = await sql<
        Array<{
          session_authority: unknown;
          parent_turn_id: string | null;
          turn_authority: unknown;
          update_authority: unknown;
          outbox_authority: unknown;
          task_creator_kind: string;
          task_creator_subject: string;
          task_creator_context: unknown;
          task_authority: unknown;
        }>
      >`
        select
          sessions.initial_personal_connection_delegations as session_authority,
          sessions.parent_turn_id,
          turns.personal_connection_delegations as turn_authority,
          updates.personal_connection_delegations as update_authority,
          outbox.personal_connection_delegations as outbox_authority,
          tasks.created_by_kind as task_creator_kind,
          tasks.created_by_subject_id as task_creator_subject,
          tasks.created_by_context as task_creator_context,
          tasks.personal_connection_delegations as task_authority
        from sessions
        join session_turns turns on turns.id = ${parentTurnId}
        join session_system_updates updates on updates.id = ${legacyUpdateId}
        join session_system_update_outbox outbox on outbox.id = ${legacyOutboxId}
        join scheduled_tasks tasks on tasks.id = ${legacyTaskId}
        where sessions.id = ${parentSessionId}`;
      expect(legacy).toEqual({
        session_authority: [],
        parent_turn_id: null,
        turn_authority: [],
        update_authority: [],
        outbox_authority: [],
        task_creator_kind: "service",
        task_creator_subject: "unattributed-legacy",
        task_creator_context: { backfill: true },
        task_authority: [],
      });

      const [constraintCoverage] = await sql<Array<{ covered: number; oversizedNames: number }>>`
        select
          count(*) filter (
            where pg_get_constraintdef(constraint_row.oid) like '%jsonb_typeof%array%'
              and pg_get_constraintdef(constraint_row.oid) like '%jsonb_array_length%128%'
          )::int as covered,
          count(*) filter (where length(constraint_row.conname) > 63)::int as "oversizedNames"
        from pg_constraint constraint_row
        where constraint_row.conname = any(${[
          "sessions_initial_personal_delegations_array_chk",
          "session_turns_personal_delegations_array_chk",
          "session_updates_personal_delegations_array_chk",
          "session_update_outbox_personal_delegations_array_chk",
          "scheduled_tasks_personal_delegations_array_chk",
        ]})`;
      expect(constraintCoverage).toEqual({ covered: 5, oversizedNames: 0 });

      await expectSqlFailure(
        sql`
          insert into session_system_updates (
            account_id, workspace_id, session_id, kind, classification,
            source_id, dedupe_key, summary, payload, lineage,
            personal_connection_delegations
          ) values (
            ${account!.id}, ${workspace!.id}, ${parentSessionId}, 'agent_message', 'info',
            'invalid-object', ${crypto.randomUUID()}, 'invalid object',
            ${sql.json({
              type: "agent_message",
              text: "invalid object",
              operationId: crypto.randomUUID(),
            })},
            '{}'::jsonb, '{}'::jsonb
          )`,
        "session_updates_personal_delegations_array_chk",
      );
      await expectSqlFailure(
        sql`
          insert into session_system_updates (
            account_id, workspace_id, session_id, kind, classification,
            source_id, dedupe_key, summary, payload, lineage,
            personal_connection_delegations
          ) values (
            ${account!.id}, ${workspace!.id}, ${parentSessionId}, 'agent_message', 'info',
            'invalid-length', ${crypto.randomUUID()}, 'invalid length',
            ${sql.json({
              type: "agent_message",
              text: "invalid length",
              operationId: crypto.randomUUID(),
            })},
            '{}'::jsonb, ${sql.json(Array.from({ length: 129 }, (_, index) => index))}
          )`,
        "session_updates_personal_delegations_array_chk",
      );

      const delegation: McpPersonalConnectionDelegation[] = [
        {
          serverId: "linear",
          connectionId: crypto.randomUUID(),
          ownerSubjectId: "subject:migration-0153",
          providerDomain: "linear.app",
          kind: "oauth2",
        },
      ];
      await expectSqlFailure(
        sql`
          update sessions
          set initial_personal_connection_delegations = ${sql.json(delegation)}
          where id = ${parentSessionId}`,
        "session initial personal MCP authority is immutable",
      );
      await expectSqlFailure(
        sql`
          update session_turns
          set personal_connection_delegations = ${sql.json(delegation)}
          where id = ${parentTurnId}`,
        "session_turns personal MCP authority is immutable",
      );
      await expectSqlFailure(
        sql`
          update session_system_updates
          set personal_connection_delegations = ${sql.json(delegation)}
          where id = ${legacyUpdateId}`,
        "session_system_updates personal MCP authority is immutable",
      );
      await expectSqlFailure(
        sql`
          update session_system_update_outbox
          set personal_connection_delegations = ${sql.json(delegation)}
          where id = ${legacyOutboxId}`,
        "session_system_update_outbox personal MCP authority is immutable",
      );
      await expectSqlFailure(
        sql`
          update scheduled_tasks
          set created_by_subject_id = 'subject:rewritten'
          where id = ${legacyTaskId}`,
        "scheduled task creator is immutable",
      );
      await sql`
        update scheduled_tasks
        set personal_connection_delegations = ${sql.json(delegation)}
        where id = ${legacyTaskId}`;
      const [mutableTaskAuthority] = await sql<Array<{ authority: unknown }>>`
        select personal_connection_delegations as authority
        from scheduled_tasks where id = ${legacyTaskId}`;
      expect(mutableTaskAuthority?.authority).toEqual(delegation);

      const validChildId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id,
          tool_policy, parent_session_id, parent_turn_id
        ) values (
          ${validChildId}, ${account!.id}, ${workspace!.id}, 'idle', 'valid child',
          'scripted-model', 'none', ${validChildId}, ${`session-${validChildId}`},
          ${sql.json({ mode: "explicit", inheritedFromSessionId: parentSessionId })},
          ${parentSessionId}, ${parentTurnId}
        )`;
      await expectSqlFailure(
        sql`delete from sessions where id = ${parentSessionId}`,
        "sessions_workspace_parent_fk",
      );
      const [preservedLineage] = await sql<
        Array<{ parentSessionId: string | null; parentTurnId: string | null }>
      >`
        select parent_session_id as "parentSessionId", parent_turn_id as "parentTurnId"
        from sessions where id = ${validChildId}`;
      expect(preservedLineage).toEqual({ parentSessionId, parentTurnId });

      const oldWriterChildId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, status, initial_message, model,
          sandbox_backend, sandbox_group_id, temporal_workflow_id, tool_policy,
          parent_session_id
        ) values (
          ${oldWriterChildId}, ${account!.id}, ${workspace!.id}, 'idle', 'old writer child',
          'scripted-model', 'none', ${oldWriterChildId}, ${`session-${oldWriterChildId}`},
          ${sql.json({ mode: "explicit", inheritedFromSessionId: parentSessionId })},
          ${parentSessionId}
        )`;
      const [oldWriterChild] = await sql<
        Array<{ parent_turn_id: string | null; authority: unknown }>
      >`
        select parent_turn_id, initial_personal_connection_delegations as authority
        from sessions where id = ${oldWriterChildId}`;
      expect(oldWriterChild).toEqual({ parent_turn_id: null, authority: [] });
      await sql`update sessions set status = 'queued' where id = ${oldWriterChildId}`;

      const invalidChildId = crypto.randomUUID();
      await expectSqlFailure(
        sql`
          insert into sessions (
            id, account_id, workspace_id, status, initial_message, model,
            sandbox_backend, sandbox_group_id, temporal_workflow_id,
            tool_policy, parent_session_id, parent_turn_id
          ) values (
            ${invalidChildId}, ${account!.id}, ${workspace!.id}, 'idle', 'invalid child',
            'scripted-model', 'none', ${invalidChildId}, ${`session-${invalidChildId}`},
            ${sql.json({ mode: "explicit", inheritedFromSessionId: parentSessionId })},
            ${parentSessionId}, ${otherTurnId}
          )`,
        "session parent turn must belong to its parent session and workspace",
      );

      await sql`
        update session_system_update_outbox set status = 'delivered'
        where id = ${legacyOutboxId}`;
      const exactOutboxId = crypto.randomUUID();
      await sql`
        insert into session_system_update_outbox (
          id, account_id, workspace_id, source_session_id, target_session_id,
          dedupe_key, kind, classification, source_id, summary, payload, lineage,
          personal_connection_delegations
        ) values (
          ${exactOutboxId}, ${account!.id}, ${workspace!.id}, ${validChildId},
          ${parentSessionId}, ${`exact-outbox-${exactOutboxId}`}, 'child_terminal_result',
          'success', ${validChildId}, 'exact frozen authority',
          ${sql.json({
            type: "child_terminal_result",
            childSessionId: validChildId,
            status: "idle",
          })},
          ${sql.json({ parentTurnId })}, ${sql.json(delegation)}
        )`;
      const [functionAcl] = await sql<
        Array<{ appExecute: boolean; publicExecute: boolean; securityDefiner: boolean }>
      >`
        select
          has_function_privilege(
            'opengeni_app',
            'opengeni_private.claim_session_system_update_outbox(integer)'::regprocedure,
            'EXECUTE'
          ) as "appExecute",
          coalesce(bool_or(
            acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
          ), false) as "publicExecute",
          procedure.prosecdef as "securityDefiner"
        from pg_proc procedure
        cross join lateral aclexplode(
          coalesce(procedure.proacl, acldefault('f', procedure.proowner))
        ) acl
        where procedure.oid =
          'opengeni_private.claim_session_system_update_outbox(integer)'::regprocedure
        group by procedure.oid`;
      expect(functionAcl).toEqual({
        appExecute: true,
        publicExecute: false,
        securityDefiner: true,
      });

      const claimed = await sql.begin(async (tx) => {
        await tx`set local role opengeni_app`;
        return await tx<
          Array<{ id: string; personal_connection_delegations: McpPersonalConnectionDelegation[] }>
        >`select id, personal_connection_delegations
          from opengeni_private.claim_session_system_update_outbox(10)`;
      });
      expect(claimed).toContainEqual({
        id: exactOutboxId,
        personal_connection_delegations: delegation,
      });
    } finally {
      await sql.end();
    }
  }, 180_000);
});
