import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import { migrate } from "../src/migrate";

const migration = "1230_remove_knowledge_source_sync_rows.sql";
const realDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const subjectId = "user:retired-knowledge-sync";
let owned: OwnerMigratedTestDatabase | null = null;
let ownerSql: postgres.Sql | null = null;
let prefix: string | null = null;
let routinesBefore: RoutineMetadata[] = [];

type RoutineMetadata = {
  name: string;
  definer: boolean;
  config: string[] | null;
  owner: string;
  acl: string[] | null;
};

// Signature, owner, grants, SECURITY DEFINER and search path of the three
// routines 1230 replaces.
async function rewrittenRoutines(): Promise<RoutineMetadata[]> {
  return [
    ...(await owned!.admin<RoutineMetadata[]>`
      select p.oid::regprocedure::text as name, p.prosecdef as definer, p.proconfig as config,
        pg_get_userbyid(p.proowner) as owner, p.proacl::text[] as acl
      from pg_proc p
      where p.proname in ('google_drive_file_authorized', 'google_drive_document_citation',
        'knowledge_document_prepare')
      order by 1`),
  ];
}

beforeAll(async () => {
  if (!realDatabase) return;
  owned = await acquireOwnerMigratedTestDatabase("remove-knowledge-source-sync-rows");
  if (!owned) throw new Error("Real PostgreSQL is required for the Knowledge sync removal");
  prefix = await mkdtemp(join(tmpdir(), "opengeni-before-knowledge-sync-removal-"));
  const source = join(import.meta.dir, "../drizzle");
  for (const name of await readdir(source)) {
    if (name.endsWith(".sql") && name < migration) {
      await copyFile(join(source, name), join(prefix, name));
    }
  }
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: prefix });
  routinesBefore = await rewrittenRoutines();
  // The NOSUPERUSER NOBYPASSRLS owner, exactly like production.
  ownerSql = postgres(owned.ownerUrl, { max: 1, onnotice: () => undefined });
}, 900_000);

afterAll(async () => {
  await ownerSql?.end().catch(() => undefined);
  await owned?.release();
  if (prefix) await rm(prefix, { recursive: true, force: true });
}, 180_000);

type Scope = { accountId: string; workspaceId: string };

async function scope(): Promise<Scope> {
  const admin = owned!.admin;
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('retired sync') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'retired sync')
    returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

// Rows are fixtured directly as they were left behind: the release that wrote
// them is gone, so only their shape matters here.
async function fixture<T>(write: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await owned!.admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    return await write(tx);
  })) as T;
}

async function task(
  at: Scope,
  input: {
    action?: Record<string, unknown>;
    agentConfig?: Record<string, unknown>;
    status?: "active" | "paused";
  },
) {
  const temporalScheduleId = `schedule-${crypto.randomUUID()}`;
  const id = await fixture(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into scheduled_tasks (account_id, workspace_id, name, owner_subject_id, status,
        schedule, temporal_schedule_id, agent_config, action, created_by_subject_id,
        execution_digest, overlap_policy)
      values (${at.accountId}, ${at.workspaceId}, 'Drive sync', ${subjectId},
        ${input.status ?? "paused"},
        ${tx.json({ type: "manual" })}, ${temporalScheduleId},
        ${tx.json((input.agentConfig ?? { prompt: "Summarize" }) as postgres.JSONValue)},
        ${tx.json((input.action ?? { kind: "agent_turn" }) as postgres.JSONValue)},
        ${subjectId}, ${"0".repeat(64)}, 'skip')
      returning id`;
    return row!.id;
  });
  return { id, temporalScheduleId };
}

async function run(at: Scope, taskId: string, actionKind: string) {
  return await fixture(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into scheduled_task_runs (account_id, workspace_id, task_id, trigger_type, status,
        action_kind)
      values (${at.accountId}, ${at.workspaceId}, ${taskId}, 'manual', 'failed', ${actionKind})
      returning id`;
    return row!.id;
  });
}

async function syncState(at: Scope, taskId: string, runId: string) {
  const sourceId = crypto.randomUUID();
  await fixture(async (tx) => {
    await tx`
      insert into knowledge_source_sync_states (source_id, account_id, workspace_id,
        scheduled_task_id, source_sync_generation, source_lifecycle_generation,
        source_config_generation, control_workspace_id, provider_coordination_key, connection_id,
        connection_version, connection_provider_domain, connection_kind,
        connection_owner_subject_id, initiating_subject_id, destination)
      values (${sourceId}, ${at.accountId}, ${at.workspaceId}, ${taskId}, 1, 1, 1,
        ${at.workspaceId}, 'google-drive:me', ${crypto.randomUUID()}, 1, 'googleapis.com',
        'oauth2', ${subjectId}, ${subjectId}, ${tx.json({ kind: "personal" })})`;
    await tx`
      insert into knowledge_source_sync_wakes (account_id, workspace_id, source_id,
        scheduled_task_id, scheduled_task_run_id, cause, producer_key,
        source_config_generation, source_lifecycle_generation)
      values (${at.accountId}, ${at.workspaceId}, ${sourceId}, ${taskId}, ${runId}, 'manual',
        ${`wake-${crypto.randomUUID()}`}, 1, 1)`;
  });
  return sourceId;
}

async function count(table: string, column: string, value: string): Promise<number> {
  const [row] = await owned!.admin.unsafe<{ count: number }[]>(
    `select count(*)::int as count from ${table} where ${column} = $1`,
    [value],
  );
  return row!.count;
}

describe.skipIf(!realDatabase)("1230 removes retired Knowledge sync rows", () => {
  test("deletes every source task with its runs and sync rows, keeps chat history, and is idempotent", async () => {
    const at = await scope();
    const native = await task(at, {
      action: {
        kind: "knowledge_source_sync",
        connection: { providerDomain: "googleapis.com" },
      },
    });
    const nativeRun = await run(at, native.id, "knowledge_source_sync");
    const nativeSource = await syncState(at, native.id, nativeRun);

    // An agent task bound to a source whose run started a chat.
    const agent = await task(at, {
      agentConfig: {
        prompt: "Import",
        knowledgeSource: { connection: { providerDomain: "atlassian.com" } },
      },
    });
    const agentRun = await run(at, agent.id, "agent_turn");
    await syncState(at, agent.id, agentRun);
    await fixture(async (tx) => {
      await tx`
        insert into session_turns (account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model, reasoning_effort,
          sandbox_backend, scheduled_task_run_id)
        values (${at.accountId}, ${at.workspaceId}, ${crypto.randomUUID()},
          ${crypto.randomUUID()}, 'workflow', 'completed', 1, 'Import', 'model', 'low', 'modal',
          ${agentRun})`;
    });

    // The same, still active: deleting it pauses it, firing the app's
    // pause triggers.
    const activeAgent = await task(at, {
      status: "active",
      agentConfig: {
        prompt: "Import",
        knowledgeSource: { connection: { providerDomain: "googleapis.com" } },
      },
    });
    const activeAgentRun = await run(at, activeAgent.id, "agent_turn");
    await fixture(async (tx) => {
      await tx`
        insert into session_turns (account_id, workspace_id, session_id, trigger_event_id,
          temporal_workflow_id, status, position, prompt, model, reasoning_effort,
          sandbox_backend, scheduled_task_run_id)
        values (${at.accountId}, ${at.workspaceId}, ${crypto.randomUUID()},
          ${crypto.randomUUID()}, 'workflow', 'completed', 1, 'Import', 'model', 'low', 'modal',
          ${activeAgentRun})`;
    });

    // A source task its owner already deleted, with its schedule cleanup queued
    // together with a connector cleanup nothing can run any more.
    const hidden = await task(at, {
      action: { kind: "knowledge_source_sync", connection: { providerDomain: "googleapis.com" } },
    });
    await fixture(async (tx) => {
      await tx`update scheduled_tasks set deleted_at = now() where id = ${hidden.id}`;
      await tx`
        insert into temporal_schedule_cleanup_outbox (account_id, workspace_id,
          temporal_schedule_id, scheduled_task_id, connector_cleanup_subject_id,
          connector_cleanup_snapshot)
        values (${at.accountId}, ${at.workspaceId}, ${hidden.temporalScheduleId}, ${hidden.id},
          ${subjectId}, ${tx.json({
            version: 1,
            taskId: hidden.id,
            accountId: at.accountId,
            workspaceId: at.workspaceId,
            connectorKind: "google_drive",
            connectionId: crypto.randomUUID(),
            connectionVersion: 1,
            sourceId: crypto.randomUUID(),
            sourceLifecycleGeneration: 1,
            sourceConfigGeneration: 1,
            externalSourceId: "folder",
            subjectId,
          })})`;
    });

    // Ordinary schedules and runs stay.
    const ordinary = await task(at, {});
    const ordinaryRun = await run(at, ordinary.id, "agent_turn");

    // A Knowledge source facet binding, and a tools facet that stays.
    const facets = await fixture(async (tx) => {
      const integrationFacetId = crypto.randomUUID();
      const [source] = await tx<{ id: string }[]>`
        insert into integration_facet_definitions (integration_facet_id, facet_key, kind)
        values (${integrationFacetId}, 'files', 'knowledge_source') returning id`;
      const [tools] = await tx<{ id: string }[]>`
        insert into integration_facet_definitions (integration_facet_id, facet_key, kind)
        values (${integrationFacetId}, 'tools', 'tools') returning id`;
      const installationId = crypto.randomUUID();
      const [binding] = await tx<{ id: string }[]>`
        insert into integration_facet_bindings (account_id, workspace_id, facet_definition_id,
          integration_facet_installation_id, binding_key, display_name, created_by_subject_id)
        values (${at.accountId}, ${at.workspaceId}, ${source!.id}, ${installationId}, 'drive',
          'Drive folder', ${subjectId})
        returning id`;
      const [toolBinding] = await tx<{ id: string }[]>`
        insert into integration_facet_bindings (account_id, workspace_id, facet_definition_id,
          integration_facet_installation_id, binding_key, display_name, created_by_subject_id)
        values (${at.accountId}, ${at.workspaceId}, ${tools!.id}, ${installationId}, 'tools',
          'Tools', ${subjectId})
        returning id`;
      return {
        source: source!.id,
        tools: tools!.id,
        binding: binding!.id,
        toolBinding: toolBinding!.id,
      };
    });

    await migrate(owned!.ownerUrl);

    // The native task, its run, sync state and wake are gone.
    expect(await count("scheduled_tasks", "id", native.id)).toBe(0);
    expect(await count("scheduled_task_runs", "id", nativeRun)).toBe(0);
    expect(await count("knowledge_source_sync_states", "source_id", nativeSource)).toBe(0);
    expect(await count("knowledge_source_sync_wakes", "scheduled_task_id", native.id)).toBe(0);
    expect(await count("scheduled_tasks", "id", hidden.id)).toBe(0);

    // The chat's run stays; its schedule is deleted the way the app deletes one.
    const [kept] = await owned!.admin<{ status: string; deleted: boolean }[]>`
      select status, deleted_at is not null as deleted from scheduled_tasks where id = ${agent.id}`;
    expect(kept).toEqual({ status: "paused", deleted: true });
    expect(await count("scheduled_task_runs", "id", agentRun)).toBe(1);
    const [keptActive] = await owned!.admin<{ status: string; deleted: boolean }[]>`
      select status, deleted_at is not null as deleted from scheduled_tasks
      where id = ${activeAgent.id}`;
    expect(keptActive).toEqual({ status: "paused", deleted: true });
    expect(await count("scheduled_task_runs", "id", activeAgentRun)).toBe(1);
    expect(await count("knowledge_source_sync_states", "scheduled_task_id", agent.id)).toBe(0);
    expect(await count("knowledge_source_sync_wakes", "scheduled_task_id", agent.id)).toBe(0);

    // Each Temporal schedule is queued for deletion once; queued connector
    // cleanup is done.
    const cleanup = await owned!.admin<
      { temporalScheduleId: string; taskId: string | null; connectorDone: boolean | null }[]
    >`
      select temporal_schedule_id as "temporalScheduleId", scheduled_task_id as "taskId",
        case when connector_cleanup_snapshot is null then null
          else connector_cleanup_completed_at is not null end as "connectorDone"
      from temporal_schedule_cleanup_outbox where workspace_id = ${at.workspaceId}
      order by temporal_schedule_id`;
    expect([...cleanup]).toEqual(
      [
        { temporalScheduleId: native.temporalScheduleId, taskId: null, connectorDone: null },
        { temporalScheduleId: agent.temporalScheduleId, taskId: null, connectorDone: null },
        {
          temporalScheduleId: activeAgent.temporalScheduleId,
          taskId: null,
          connectorDone: null,
        },
        { temporalScheduleId: hidden.temporalScheduleId, taskId: hidden.id, connectorDone: true },
      ].sort((a, b) => a.temporalScheduleId.localeCompare(b.temporalScheduleId)),
    );

    expect(await count("scheduled_tasks", "id", ordinary.id)).toBe(1);
    expect(await count("scheduled_task_runs", "id", ordinaryRun)).toBe(1);
    expect(await count("integration_facet_definitions", "id", facets.source)).toBe(0);
    expect(await count("integration_facet_bindings", "id", facets.binding)).toBe(0);
    expect(await count("integration_facet_definitions", "id", facets.tools)).toBe(1);
    expect(await count("integration_facet_bindings", "id", facets.toolBinding)).toBe(1);

    // FORCE ROW LEVEL SECURITY and the tenancy fence are restored.
    const forced = await owned!.admin<{ relname: string; forced: boolean }[]>`
      select relname, relforcerowsecurity as forced from pg_class
      where relkind = 'r' and relname in ('scheduled_tasks', 'scheduled_task_runs',
        'knowledge_source_sync_states', 'knowledge_source_sync_wakes',
        'temporal_schedule_cleanup_outbox', 'integration_facet_definitions',
        'integration_facet_bindings')`;
    expect(forced).toHaveLength(7);
    expect(forced.every((row) => row.forced)).toBe(true);
    const [fence] = await owned!.admin<{ enabled: string }[]>`
      select tgenabled as enabled from pg_trigger
      where tgname = 'session_tenancy_workspace_fence'
        and tgrelid = 'scheduled_tasks'::regclass`;
    expect(fence!.enabled).toBe("O");

    // Running it again changes nothing.
    const sqlText = await readFile(join(import.meta.dir, "../drizzle", migration), "utf8");
    await ownerSql!.unsafe(`BEGIN; ${sqlText} COMMIT;`);
    expect(await count("scheduled_tasks", "id", agent.id)).toBe(1);
    expect(await count("scheduled_task_runs", "id", agentRun)).toBe(1);
    expect(await count("scheduled_tasks", "id", ordinary.id)).toBe(1);
    const [again] = await owned!.admin<{ count: number }[]>`
      select count(*)::int as count from temporal_schedule_cleanup_outbox
      where workspace_id = ${at.workspaceId}`;
    expect(again!.count).toBe(4);
  }, 180_000);

  test("a Google Drive source copy stays unreadable and has no citation", async () => {
    const names = await owned!.admin<{ name: string; body: string }[]>`
      select p.proname as name, p.prosrc as body from pg_proc p
      where p.proname in ('google_drive_file_authorized', 'google_drive_document_citation',
        'knowledge_document_prepare')`;
    expect(names.map((row) => row.name).sort()).toEqual([
      "google_drive_document_citation",
      "google_drive_file_authorized",
      "knowledge_document_prepare",
    ]);
    for (const row of names) {
      expect(row.body).not.toMatch(
        /knowledge_source_sync_|google_drive_object_acl_(evidence|principals)/,
      );
    }
    expect(routinesBefore).toHaveLength(3);
    expect(await rewrittenRoutines()).toEqual(routinesBefore);

    // They still run, as the migration owner, and fail closed.
    const [authorized] = await ownerSql!<{ allowed: boolean }[]>`
      select google_drive_file_authorized(gen_random_uuid(), gen_random_uuid(), ${subjectId},
        gen_random_uuid()) as allowed`;
    expect(authorized!.allowed).toBe(false);
    const [citation] = await ownerSql!<{ citation: unknown }[]>`
      select google_drive_document_citation(gen_random_uuid(), gen_random_uuid(), ${subjectId},
        gen_random_uuid(), gen_random_uuid()) as citation`;
    expect(citation!.citation).toBeNull();
    await expect(
      ownerSql!`select knowledge_document_prepare(gen_random_uuid(), gen_random_uuid(),
        gen_random_uuid(), '{}'::jsonb)`,
    ).rejects.toThrow("Invalid document preparation authority");
  });
});
