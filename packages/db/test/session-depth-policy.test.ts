import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acquireBlankTestDatabase,
  acquireSharedTestDatabase,
  type SharedTestDatabase,
} from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  createDb,
  createSession,
  createSessionWithIdempotencyKey,
  dbSql,
  getSession,
  getSessionSpawnDenial,
  getSessionSpawnDenialByIdempotencyKey,
  getSessionLineage,
  listSessionSpawnDenials,
  listSessions,
  SessionSpawnDeniedDbError,
  withWorkspaceRls,
  type Database,
  type DbClient,
  type DbSession,
  type SessionCreateResult,
  type SessionSpawnDenial,
} from "../src/index";
import { migrate } from "../src/migrate";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

type Workspace = { accountId: string; workspaceId: string };

async function freshWorkspace(name = "depth-policy"): Promise<Workspace> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function sessionInput<T extends Record<string, unknown>>(
  workspace: Workspace,
  message: string,
  extra: T = {} as T,
) {
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage: message,
    resources: [],
    metadata: {},
    model: "depth-policy-test",
    sandboxBackend: "none" as const,
    ...extra,
  } as {
    accountId: string;
    workspaceId: string;
    initialMessage: string;
    resources: never[];
    metadata: Record<string, never>;
    model: string;
    sandboxBackend: "none";
  } & T;
}

function createdSession(result: SessionCreateResult): DbSession {
  if (result.denied) throw new Error(`unexpected session-create denial: ${result.denial.code}`);
  return result.session;
}

function deniedSpawn(result: SessionCreateResult): SessionSpawnDenial {
  if (!result.denied) throw new Error(`expected session-create denial for ${result.session.id}`);
  return result.denial;
}

async function deniedCreate(promise: Promise<DbSession>): Promise<SessionSpawnDenial> {
  try {
    const session = await promise;
    throw new Error(`expected session-create denial for ${session.id}`);
  } catch (error) {
    if (error instanceof SessionSpawnDeniedDbError) return error.denial;
    throw error;
  }
}

async function chain(workspace: Workspace, length: number): Promise<DbSession[]> {
  const sessions: DbSession[] = [];
  let parentSessionId: string | undefined;
  for (let depth = 0; depth < length; depth += 1) {
    const session = await createSession(
      db,
      sessionInput(workspace, `depth-${depth}`, parentSessionId ? { parentSessionId } : {}),
    );
    sessions.push(session);
    parentSessionId = session.id;
  }
  return sessions;
}

async function count(table: string, workspaceId: string): Promise<number> {
  const [row] = await admin<{ count: number }[]>`
    select count(*)::int as count from ${admin(table)} where workspace_id = ${workspaceId}`;
  return row?.count ?? 0;
}

async function sortedMigrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
}

async function applyAndRecordMigration(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
  await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
}

async function prepareDatabaseThrough0064(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(
    `create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
  );
  for (const file of (await sortedMigrationFiles()).filter((candidate) => candidate < "0065_")) {
    await applyAndRecordMigration(sql, file);
  }
}

async function grantAppRoleForDepthPolicy(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`
    GRANT USAGE ON SCHEMA public, opengeni_private TO opengeni_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO opengeni_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA opengeni_private TO opengeni_app;
    REVOKE INSERT, UPDATE, DELETE ON nested_agent_depth_configuration FROM opengeni_app;
    GRANT SELECT ON nested_agent_depth_configuration TO opengeni_app;
    REVOKE UPDATE, DELETE ON session_spawn_denials FROM opengeni_app;
    GRANT SELECT, INSERT ON session_spawn_denials TO opengeni_app;
    REVOKE ALL ON FUNCTION lock_nested_agent_depth_configuration() FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION lock_nested_agent_depth_configuration() TO opengeni_app;
  `);
}

async function expectStillPending<T>(promise: Promise<T>): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    Bun.sleep(150).then(() => "pending" as const),
  ]);
  expect(state).toBe("pending");
}

async function expectPostgresCode(promise: Promise<unknown>, expectedCode: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === "object" && !seen.has(current)) {
      seen.add(current);
      if ((current as { code?: unknown }).code === expectedCode) return;
      current = (current as { cause?: unknown }).cause;
    }
    throw error;
  }
  throw new Error(`expected PostgreSQL SQLSTATE ${expectedCode}`);
}

const sessionCreateSideEffectTables = [
  "session_mcp_servers",
  "session_turns",
  "session_events",
  "session_system_updates",
  "session_system_update_outbox",
  "session_workflow_wake_outbox",
  "session_goals",
  "agent_run_states",
  "session_history_items",
  "session_pending_tool_calls",
  "sandbox_session_envelopes",
  "sandbox_leases",
  "codex_credential_leases",
  "usage_events",
  "credit_ledger_entries",
] as const;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-depth-policy");
  if (!shared) {
    available = false;
    console.warn("[session-depth-policy] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

describe("nested agent depth policy (real PostgreSQL + FORCE RLS)", () => {
  test("persists root/child/grandchild/depth3 lineage and policy fields", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("fields");
    const sessions = await chain(workspace, 4);
    const [root, child, grandchild, depth3] = sessions;

    for (const [session, depth] of sessions.map((value, index) => [value, index] as const)) {
      expect(session.rootSessionId).toBe(root!.id);
      expect(session.nestedAgentDepth).toBe(depth);
      expect(session.maxNestedAgentDepthOverride).toBeNull();
      expect(session.effectiveMaxNestedAgentDepth).toBe(3);
      expect(session.nestedAgentDepthPolicySource).toBe("default");
      expect(session.nestedAgentDepthPolicySessionId).toBeNull();
    }
    expect(child!.parentSessionId).toBe(root!.id);
    expect(grandchild!.parentSessionId).toBe(child!.id);
    expect(depth3!.parentSessionId).toBe(grandchild!.id);
    expect((await getSession(db, workspace.workspaceId, depth3!.id))?.nestedAgentDepth).toBe(3);
  }, 60_000);

  test("denies depth4 before session or MCP insertion and records one keyed audit row", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("depth4");
    const sessions = await chain(workspace, 4);
    const key = "depth4-denial";
    const input = sessionInput(workspace, "depth4", {
      parentSessionId: sessions[3]!.id,
      createIdempotencyKey: key,
      subjectId: "subject:depth4",
      mcpServers: [
        {
          id: "denied-mcp",
          url: "https://mcp.example.test",
          headersEncrypted: {},
        },
      ],
    });

    const first = await createSessionWithIdempotencyKey(db, input);
    const retry = await createSessionWithIdempotencyKey(db, input);
    expect(first.denied).toBe(true);
    expect(retry.denied).toBe(true);
    expect(deniedSpawn(retry).id).toBe(deniedSpawn(first).id);
    expect(deniedSpawn(first)).toMatchObject({
      accountId: workspace.accountId,
      workspaceId: workspace.workspaceId,
      parentSessionId: sessions[3]!.id,
      rootSessionId: sessions[0]!.id,
      currentDepth: 3,
      attemptedDepth: 4,
      effectiveMaxNestedAgentDepth: 3,
      requestedMaxNestedAgentDepthOverride: null,
      policySource: "default",
      policySessionId: null,
      subjectId: "subject:depth4",
      code: "nested_agent_depth_exceeded",
      idempotencyKey: key,
    });
    expect(await count("sessions", workspace.workspaceId)).toBe(4);
    for (const table of sessionCreateSideEffectTables) {
      expect(await count(table, workspace.workspaceId)).toBe(0);
    }
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(1);
    expect((await getSessionSpawnDenialByIdempotencyKey(db, workspace.workspaceId, key))?.id).toBe(
      deniedSpawn(first).id,
    );

    const successfulKey = "successful-create-wins";
    const successful = await createSessionWithIdempotencyKey(
      db,
      sessionInput(workspace, "successful", { createIdempotencyKey: successfulKey }),
    );
    const successfulRetry = await createSessionWithIdempotencyKey(
      db,
      sessionInput(workspace, "would-have-denied", {
        parentSessionId: sessions[3]!.id,
        createIdempotencyKey: successfulKey,
      }),
    );
    expect(successful.denied).toBe(false);
    expect(successful.created).toBe(true);
    expect(successfulRetry.denied).toBe(false);
    expect(successfulRetry.created).toBe(false);
    expect(createdSession(successfulRetry).id).toBe(createdSession(successful).id);
    expect(await count("sessions", workspace.workspaceId)).toBe(5);
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(1);
  }, 60_000);

  test("dedupes one denial under concurrent keyed retries", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("concurrent-denial");
    const sessions = await chain(workspace, 4);
    const key = "concurrent-depth4";
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        createSessionWithIdempotencyKey(
          db,
          sessionInput(workspace, "concurrent-depth4", {
            parentSessionId: sessions[3]!.id,
            createIdempotencyKey: key,
          }),
        ),
      ),
    );
    expect(results.every((result) => result.denied)).toBe(true);
    expect(new Set(results.map((result) => deniedSpawn(result).id)).size).toBe(1);
    expect(await count("sessions", workspace.workspaceId)).toBe(4);
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(1);
  }, 60_000);

  test("allows reductions, requires explicit authorization for increases, and inherits session policy", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("overrides");
    const reduced = await createSession(
      db,
      sessionInput(workspace, "reduced", { maxNestedAgentDepthOverride: 1 }),
    );
    expect(reduced.effectiveMaxNestedAgentDepth).toBe(1);
    expect(reduced.nestedAgentDepthPolicySource).toBe("session");
    expect(reduced.nestedAgentDepthPolicySessionId).toBe(reduced.id);
    const inherited = await createSession(
      db,
      sessionInput(workspace, "inherited", { parentSessionId: reduced.id }),
    );
    expect(inherited.effectiveMaxNestedAgentDepth).toBe(1);
    expect(inherited.nestedAgentDepthPolicySource).toBe("session");
    expect(inherited.nestedAgentDepthPolicySessionId).toBe(reduced.id);
    const reductionDenied = await deniedCreate(
      createSession(
        db,
        sessionInput(workspace, "reduction-denied", { parentSessionId: inherited.id }),
      ),
    );
    expect(reductionDenied.code).toBe("nested_agent_depth_exceeded");

    const forbidden = await deniedCreate(
      createSession(
        db,
        sessionInput(workspace, "forbidden-increase", { maxNestedAgentDepthOverride: 5 }),
      ),
    );
    expect(forbidden.code).toBe("nested_agent_depth_override_forbidden");
    expect(forbidden.rootSessionId).toBeNull();
    const authorized = await createSession(
      db,
      sessionInput(workspace, "authorized-increase", {
        maxNestedAgentDepthOverride: 5,
        allowNestedAgentDepthIncrease: true,
      }),
    );
    expect(authorized.effectiveMaxNestedAgentDepth).toBe(5);
    expect(authorized.nestedAgentDepthPolicySessionId).toBe(authorized.id);

    const candidateWorkspace = await freshWorkspace("candidate-too-narrow");
    const regular = await chain(candidateWorkspace, 3);
    const candidateDenied = await deniedCreate(
      createSession(
        db,
        sessionInput(candidateWorkspace, "candidate-too-narrow", {
          parentSessionId: regular[2]!.id,
          maxNestedAgentDepthOverride: 1,
        }),
      ),
    );
    expect(candidateDenied).toMatchObject({
      code: "nested_agent_depth_exceeded",
      attemptedDepth: 3,
      effectiveMaxNestedAgentDepth: 1,
      policySource: "session",
      policySessionId: null,
    });
  }, 60_000);

  test("uses workspace over deployment over default and serializes policy change with create", async () => {
    if (!available) return;
    await migrate(shared!.adminUrl, undefined, { maxNestedAgentDepth: 5 });
    try {
      const workspace = await freshWorkspace("precedence");
      await admin`
      update workspaces
      set settings = settings || '{"maxNestedAgentDepth": 2}'::jsonb
      where id = ${workspace.workspaceId}`;
      const workspacePolicy = await createSession(
        db,
        sessionInput(workspace, "workspace-policy", { deploymentMaxNestedAgentDepth: 5 }),
      );
      expect(workspacePolicy.effectiveMaxNestedAgentDepth).toBe(2);
      expect(workspacePolicy.nestedAgentDepthPolicySource).toBe("workspace");
      const workspaceChild = await createSession(
        db,
        sessionInput(workspace, "workspace-child", {
          parentSessionId: workspacePolicy.id,
          deploymentMaxNestedAgentDepth: 5,
        }),
      );
      expect(workspaceChild.effectiveMaxNestedAgentDepth).toBe(2);
      expect(workspaceChild.nestedAgentDepthPolicySource).toBe("workspace");

      await admin`
      update workspaces
      set settings = settings - 'maxNestedAgentDepth'
      where id = ${workspace.workspaceId}`;
      const reResolvedChild = await createSession(
        db,
        sessionInput(workspace, "re-resolved-child", {
          parentSessionId: workspacePolicy.id,
          deploymentMaxNestedAgentDepth: 5,
        }),
      );
      expect(reResolvedChild.effectiveMaxNestedAgentDepth).toBe(5);
      expect(reResolvedChild.nestedAgentDepthPolicySource).toBe("deployment");
      const deploymentPolicy = await createSession(
        db,
        sessionInput(workspace, "deployment-policy", { deploymentMaxNestedAgentDepth: 5 }),
      );
      expect(deploymentPolicy.effectiveMaxNestedAgentDepth).toBe(5);
      expect(deploymentPolicy.nestedAgentDepthPolicySource).toBe("deployment");
      const blocker = postgres(shared!.adminUrl, { max: 1 });
      try {
        await blocker`begin`;
        await blocker`
          select workspace_id from workspace_inference_controls
          where workspace_id = ${workspace.workspaceId} for update`;
        const pending = createSession(
          db,
          sessionInput(workspace, "serialized-policy", { deploymentMaxNestedAgentDepth: 5 }),
        );
        await Bun.sleep(100);
        await blocker`
          update workspaces
          set settings = settings || '{"maxNestedAgentDepth": 1}'::jsonb
          where id = ${workspace.workspaceId}`;
        await blocker`commit`;
        const serialized = await pending;
        expect(serialized.effectiveMaxNestedAgentDepth).toBe(1);
        expect(serialized.nestedAgentDepthPolicySource).toBe("workspace");
      } finally {
        await blocker`rollback`.catch(() => undefined);
        await blocker.end();
      }
      await migrate(shared!.adminUrl, undefined, {});
      const defaultWorkspace = await freshWorkspace("default-precedence");
      const defaultPolicy = await createSession(
        db,
        sessionInput(defaultWorkspace, "default-policy"),
      );
      expect(defaultPolicy.effectiveMaxNestedAgentDepth).toBe(3);
      expect(defaultPolicy.nestedAgentDepthPolicySource).toBe("default");
    } finally {
      await migrate(shared!.adminUrl, undefined, {});
    }
  }, 60_000);

  test("serializes an old-shape workspace policy writer through the inference-control row", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("old-settings-writer");
    const blocker = postgres(shared!.adminUrl, { max: 1 });
    const writer = postgres(shared!.adminUrl, { max: 1 });
    try {
      await blocker`begin`;
      await blocker`
        select workspace_id from workspace_inference_controls
        where workspace_id = ${workspace.workspaceId} for share`;
      await writer`begin`;
      const pendingWrite = writer`
        update workspaces
        set settings = settings || '{"maxNestedAgentDepth":1}'::jsonb
        where id = ${workspace.workspaceId}`;
      await expectStillPending(pendingWrite);
      await blocker`commit`;
      expect((await pendingWrite).count).toBe(1);
      await writer`commit`;

      const [row] = await admin<{ limit: number }[]>`
        select (settings ->> 'maxNestedAgentDepth')::int as limit
        from workspaces where id = ${workspace.workspaceId}`;
      expect(row?.limit).toBe(1);
    } finally {
      await blocker`rollback`.catch(() => undefined);
      await writer`rollback`.catch(() => undefined);
      await blocker.end();
      await writer.end();
    }
  }, 60_000);

  test("keeps the app role mutation-free while deployment policy reconciliation waits for its share lock", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("deployment-policy-lock");
    const app = postgres(shared!.appUrl, { max: 1 });
    try {
      const [privileges] = await admin<
        Array<{ tableUpdate: boolean; denialDelete: boolean; functionExecute: boolean }>
      >`
        select
          has_table_privilege('opengeni_app', 'nested_agent_depth_configuration', 'UPDATE')
            as "tableUpdate",
          has_table_privilege('opengeni_app', 'session_spawn_denials', 'DELETE')
            as "denialDelete",
          has_function_privilege(
            'opengeni_app', 'lock_nested_agent_depth_configuration()', 'EXECUTE'
          ) as "functionExecute"`;
      expect(privileges).toEqual({
        tableUpdate: false,
        denialDelete: false,
        functionExecute: true,
      });

      await app`begin`;
      await app`select set_config('opengeni.account_id', ${workspace.accountId}, true)`;
      await app`select set_config('opengeni.workspace_id', ${workspace.workspaceId}, true)`;
      const [locked] = await app<
        Array<{ max_nested_agent_depth: number; policy_source: string }>
      >`select * from lock_nested_agent_depth_configuration()`;
      expect(locked).toMatchObject({ max_nested_agent_depth: 3, policy_source: "default" });

      const reconciliation = migrate(shared!.adminUrl, undefined, { maxNestedAgentDepth: 4 });
      await expectStillPending(reconciliation);
      await app`commit`;
      await reconciliation;
      const [updated] = await admin<
        Array<{ max_nested_agent_depth: number; policy_source: string }>
      >`select max_nested_agent_depth, policy_source from nested_agent_depth_configuration`;
      expect(updated).toEqual({ max_nested_agent_depth: 4, policy_source: "deployment" });
    } finally {
      await app`rollback`.catch(() => undefined);
      await app.end();
      await migrate(shared!.adminUrl, undefined, {});
    }
  }, 60_000);

  test("keeps legacy depth>3 rows readable while denying new unraised descendants", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("legacy-deep");
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    const rootId = ids[0]!;
    const deepId = ids[4]!;

    // Migration 0065 deliberately permits already-persisted trees deeper than
    // their effective limit. Seed that pre-migration state while disabling
    // only the new INSERT trigger, then restore enforcement before exercising
    // any creation API.
    await admin`alter table sessions disable trigger session_depth_policy_defaults`;
    try {
      for (let depth = 0; depth < ids.length; depth += 1) {
        await admin`
          insert into sessions (
            id, account_id, workspace_id, initial_message, model, sandbox_backend,
            sandbox_group_id, parent_session_id, root_session_id, nested_agent_depth,
            effective_max_nested_agent_depth, nested_agent_depth_policy_source
          ) values (
            ${ids[depth]!}, ${workspace.accountId}, ${workspace.workspaceId},
            ${`legacy depth ${depth}`}, 'test', 'none', ${rootId},
            ${depth === 0 ? null : ids[depth - 1]!}, ${rootId}, ${depth}, 3, 'default'
          )`;
      }
    } finally {
      await admin`alter table sessions enable trigger session_depth_policy_defaults`;
    }

    const readable = await getSession(db, workspace.workspaceId, deepId);
    expect(readable?.nestedAgentDepth).toBe(4);
    expect(readable?.rootSessionId).toBe(rootId);
    expect((await listSessions(db, workspace.workspaceId)).some((row) => row.id === deepId)).toBe(
      true,
    );
    expect((await getSessionLineage(db, workspace.workspaceId, deepId))?.ancestors).toHaveLength(4);

    const denied = await deniedCreate(
      createSession(db, sessionInput(workspace, "new-deep", { parentSessionId: deepId })),
    );
    expect(denied.attemptedDepth).toBe(5);

    const raised = await createSession(
      db,
      sessionInput(workspace, "authorized legacy extension", {
        parentSessionId: deepId,
        maxNestedAgentDepthOverride: 5,
        allowNestedAgentDepthIncrease: true,
      }),
    );
    expect(raised.nestedAgentDepth).toBe(5);
    expect(raised.effectiveMaxNestedAgentDepth).toBe(5);
    expect(raised.nestedAgentDepthPolicySource).toBe("session");
  }, 60_000);

  test("isolates denial audit rows by workspace under FORCE RLS", async () => {
    if (!available) return;
    const firstWorkspace = await freshWorkspace("rls-a");
    const secondWorkspace = await freshWorkspace("rls-b");
    const firstChain = await chain(firstWorkspace, 4);
    const secondChain = await chain(secondWorkspace, 4);
    const first = await createSessionWithIdempotencyKey(
      db,
      sessionInput(firstWorkspace, "rls denial a", {
        parentSessionId: firstChain[3]!.id,
        createIdempotencyKey: "rls-a",
      }),
    );
    const second = await createSessionWithIdempotencyKey(
      db,
      sessionInput(secondWorkspace, "rls denial b", {
        parentSessionId: secondChain[3]!.id,
        createIdempotencyKey: "rls-b",
      }),
    );
    expect(first.denied).toBe(true);
    expect(second.denied).toBe(true);
    expect(await listSessionSpawnDenials(db, firstWorkspace.workspaceId)).toHaveLength(1);
    expect(await listSessionSpawnDenials(db, secondWorkspace.workspaceId)).toHaveLength(1);
    expect(
      await getSessionSpawnDenial(db, secondWorkspace.workspaceId, deniedSpawn(first).id),
    ).toBeNull();
  }, 60_000);

  test("serializes success and denial outcomes across tables for the same key", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("cross-table-race");
    const sessions = await chain(workspace, 4);
    const key = "success-vs-denial";
    const [eligible, denied] = await Promise.all([
      createSessionWithIdempotencyKey(
        db,
        sessionInput(workspace, "eligible root", { createIdempotencyKey: key }),
      ),
      createSessionWithIdempotencyKey(
        db,
        sessionInput(workspace, "denied child", {
          createIdempotencyKey: key,
          parentSessionId: sessions[3]!.id,
        }),
      ),
    ]);
    expect(eligible.denied).toBe(denied.denied);
    expect((await count("sessions", workspace.workspaceId)) - 4).toBe(eligible.denied ? 0 : 1);
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(
      eligible.denied ? 1 : 0,
    );
  }, 60_000);

  test("keeps eligible old-shape inserts available, rejects old depth4 atomically, and keeps denials append-only", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("rolling-and-immutable");
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());

    for (let depth = 0; depth < 4; depth += 1) {
      await withWorkspaceRls(db, workspace.workspaceId, async (scopedDb) => {
        await scopedDb.execute(dbSql`
          insert into sessions (
            id, account_id, workspace_id, parent_session_id, initial_message,
            model, sandbox_backend, sandbox_group_id
          ) values (
            ${ids[depth]!}, ${workspace.accountId}, ${workspace.workspaceId},
            ${depth === 0 ? null : ids[depth - 1]!}, ${`old binary depth ${depth}`},
            'test', 'none', ${ids[depth]!}
          )
        `);
      });
      expect((await getSession(db, workspace.workspaceId, ids[depth]!))?.nestedAgentDepth).toBe(
        depth,
      );
    }
    expect(await count("sessions", workspace.workspaceId)).toBe(4);

    await expectPostgresCode(
      withWorkspaceRls(db, workspace.workspaceId, async (scopedDb) => {
        await scopedDb.execute(dbSql`
          insert into sessions (
            id, account_id, workspace_id, parent_session_id, initial_message,
            model, sandbox_backend, sandbox_group_id
          ) values (
            ${ids[4]!}, ${workspace.accountId}, ${workspace.workspaceId}, ${ids[3]!},
            'old binary depth 4', 'test', 'none', ${ids[4]!}
          )
        `);
      }),
      "23514",
    );
    expect(await count("sessions", workspace.workspaceId)).toBe(4);

    const outcome = await createSessionWithIdempotencyKey(
      db,
      sessionInput(workspace, "append-only denial", {
        parentSessionId: ids[3]!,
        createIdempotencyKey: "append-only",
      }),
    );
    const denial = deniedSpawn(outcome);
    await expect(
      withWorkspaceRls(db, workspace.workspaceId, async (scopedDb) => {
        await scopedDb.execute(dbSql`
          update session_spawn_denials set subject_id = 'mutated'
          where workspace_id = ${workspace.workspaceId} and id = ${denial.id}
        `);
      }),
    ).rejects.toThrow();
    await expect(
      withWorkspaceRls(db, workspace.workspaceId, async (scopedDb) => {
        await scopedDb.execute(dbSql`
          delete from session_spawn_denials
          where workspace_id = ${workspace.workspaceId} and id = ${denial.id}
        `);
      }),
    ).rejects.toThrow();
    expect(await getSessionSpawnDenial(db, workspace.workspaceId, denial.id)).toMatchObject({
      id: denial.id,
      subjectId: null,
    });
  }, 60_000);

  test("rejects every application-role lineage/policy mutation and a referenced root deletion", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("immutable-snapshot");
    const [root, child] = await chain(workspace, 2);
    const mutations = [
      dbSql`update sessions set parent_session_id = null where workspace_id = ${workspace.workspaceId} and id = ${child!.id}`,
      dbSql`update sessions set root_session_id = ${child!.id} where workspace_id = ${workspace.workspaceId} and id = ${child!.id}`,
      dbSql`update sessions set nested_agent_depth = 2 where workspace_id = ${workspace.workspaceId} and id = ${child!.id}`,
      dbSql`update sessions set max_nested_agent_depth_override = 1 where workspace_id = ${workspace.workspaceId} and id = ${child!.id}`,
      dbSql`update sessions set effective_max_nested_agent_depth = 2 where workspace_id = ${workspace.workspaceId} and id = ${child!.id}`,
      dbSql`update sessions set nested_agent_depth_policy_source = 'workspace' where workspace_id = ${workspace.workspaceId} and id = ${child!.id}`,
      dbSql`update sessions set nested_agent_depth_policy_session_id = ${root!.id} where workspace_id = ${workspace.workspaceId} and id = ${child!.id}`,
    ];
    for (const mutation of mutations) {
      await expectPostgresCode(
        withWorkspaceRls(db, workspace.workspaceId, async (scopedDb) => {
          await scopedDb.execute(mutation);
        }),
        "55000",
      );
    }

    await expect(
      withWorkspaceRls(db, workspace.workspaceId, async (scopedDb) => {
        await scopedDb.transaction(async (tx) => {
          await tx.execute(
            dbSql`delete from sessions where workspace_id = ${workspace.workspaceId} and id = ${root!.id}`,
          );
        });
      }),
    ).rejects.toThrow();
    expect(await count("sessions", workspace.workspaceId)).toBe(2);
  }, 60_000);

  test("allows a whole-workspace cascade across the session tree and denial evidence", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("workspace-cascade");
    const sessions = await chain(workspace, 4);
    const denial = await createSessionWithIdempotencyKey(
      db,
      sessionInput(workspace, "cascade denial", {
        parentSessionId: sessions[3]!.id,
        createIdempotencyKey: "cascade-denial",
      }),
    );
    expect(denial.denied).toBe(true);

    await admin`delete from workspaces where id = ${workspace.workspaceId}`;
    expect(await count("sessions", workspace.workspaceId)).toBe(0);
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(0);
  }, 60_000);

  test("backfills a genuine 0064 deep tree through the phased migration runner", async () => {
    if (!available) return;
    const blank = await acquireBlankTestDatabase("session-depth-policy-backfill");
    if (!blank) throw new Error("real PostgreSQL is required for migration backfill proof");
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await prepareDatabaseThrough0064(sql);
      const [{ id: accountId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('0065 backfill') returning id`;
      const [{ id: workspaceId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name, settings)
        values (${accountId}, '0065 backfill', '{"maxNestedAgentDepth":2}') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId}) on conflict do nothing`;
      const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
      for (let depth = 0; depth < ids.length; depth += 1) {
        await sql`
          insert into sessions (
            id, account_id, workspace_id, parent_session_id, initial_message,
            model, sandbox_backend, sandbox_group_id
          ) values (
            ${ids[depth]!}, ${accountId}, ${workspaceId}, ${depth === 0 ? null : ids[depth - 1]!},
            ${`legacy depth ${depth}`}, 'test', 'none', ${ids[0]!}
          )`;
      }
      await migrate(blank.databaseUrl, undefined, { maxNestedAgentDepth: 3 });
      const rows = await sql<
        Array<{
          id: string;
          root_session_id: string;
          nested_agent_depth: number;
          effective_max_nested_agent_depth: number;
          nested_agent_depth_policy_source: string;
        }>
      >`
        select id, root_session_id, nested_agent_depth,
               effective_max_nested_agent_depth, nested_agent_depth_policy_source
        from sessions where workspace_id = ${workspaceId}
        order by nested_agent_depth`;
      expect(rows).toHaveLength(5);
      for (const [depth, row] of rows.entries()) {
        expect(row).toMatchObject({
          id: ids[depth],
          root_session_id: ids[0],
          nested_agent_depth: depth,
          effective_max_nested_agent_depth: 2,
          nested_agent_depth_policy_source: "workspace",
        });
      }
      const phasedFiles = (await sortedMigrationFiles()).filter(
        (file) => file >= "0065_" && file <= "0072_zzzz",
      );
      const applied = await sql<{ name: string }[]>`
        select name from schema_migrations
        where name >= '0065_' and name <= '0072_zzzz' order by name`;
      expect(applied.map((row) => row.name)).toEqual(phasedFiles);
      const [contract] = await sql<Array<{ validatedConstraints: number; validIndex: boolean }>>`
        select
          count(*) filter (where convalidated)::int as "validatedConstraints",
          coalesce((
            select indisvalid from pg_index
            where indexrelid = 'sessions_workspace_root_depth_idx'::regclass
          ), false) as "validIndex"
        from pg_constraint
        where conname in (
          'sessions_nested_agent_depth_check',
          'sessions_nested_agent_policy_source_check',
          'sessions_nested_agent_policy_session_check',
          'sessions_nested_agent_override_check',
          'sessions_workspace_parent_fk',
          'sessions_workspace_root_session_fk',
          'sessions_workspace_policy_session_fk'
        )`;
      expect(contract).toEqual({ validatedConstraints: 7, validIndex: true });
    } finally {
      await sql.end().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("does not record backfill completion while the final legacy row is locked", async () => {
    if (!available) return;
    const blank = await acquireBlankTestDatabase("session-depth-policy-backfill-lock");
    if (!blank) throw new Error("real PostgreSQL is required for migration lock proof");
    const sql = postgres(blank.databaseUrl, { max: 1 });
    const blocker = postgres(blank.databaseUrl, { max: 1 });
    try {
      await prepareDatabaseThrough0064(sql);
      const [{ id: accountId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('locked backfill') returning id`;
      const [{ id: workspaceId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountId}, 'locked backfill') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId}) on conflict do nothing`;
      const legacyRootId = crypto.randomUUID();
      await sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id
        ) values (
          ${legacyRootId}, ${accountId}, ${workspaceId}, 'locked legacy root',
          'test', 'none', ${legacyRootId}
        )`;

      await sql`select set_config('opengeni.max_nested_agent_depth', '3', false)`;
      await sql`select set_config('opengeni.nested_agent_depth_policy_source', 'default', false)`;
      await applyAndRecordMigration(sql, "0065_nested_agent_depth_expand.sql");
      await applyAndRecordMigration(sql, "0066_nested_agent_depth_boundary.sql");

      await blocker`begin`;
      await blocker`select id from sessions where id = ${legacyRootId} for update`;
      await expectPostgresCode(
        migrate(blank.databaseUrl, undefined, { maxNestedAgentDepth: 3 }),
        "55P03",
      );
      const [failedAttempt] = await sql<{ recorded: boolean }[]>`
        select exists(
          select 1 from schema_migrations
          where name = '0067_nested_agent_depth_backfill.sql'
        ) as recorded`;
      expect(failedAttempt?.recorded).toBe(false);

      await blocker`commit`;
      await migrate(blank.databaseUrl, undefined, { maxNestedAgentDepth: 3 });
      const [recovered] = await sql<
        Array<{
          rootSessionId: string;
          nestedAgentDepth: number;
          effectiveMax: number;
          policySource: string;
          phasedMigrations: number;
        }>
      >`
        select
          root_session_id as "rootSessionId",
          nested_agent_depth as "nestedAgentDepth",
          effective_max_nested_agent_depth as "effectiveMax",
          nested_agent_depth_policy_source as "policySource",
          (select count(*)::int from schema_migrations
            where name >= '0065_' and name <= '0072_zzzz') as "phasedMigrations"
        from sessions where id = ${legacyRootId}`;
      expect(recovered).toEqual({
        rootSessionId: legacyRootId,
        nestedAgentDepth: 0,
        effectiveMax: 3,
        policySource: "default",
        phasedMigrations: 8,
      });
    } finally {
      await blocker`rollback`.catch(() => undefined);
      await blocker.end().catch(() => undefined);
      await sql.end().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("repairs an invalid concurrent depth index and accepts a valid retry", async () => {
    if (!available) return;
    const blank = await acquireBlankTestDatabase("session-depth-policy-index-retry");
    if (!blank) throw new Error("real PostgreSQL is required for concurrent index proof");
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await prepareDatabaseThrough0064(sql);
      await sql`select set_config('opengeni.max_nested_agent_depth', '3', false)`;
      await sql`select set_config('opengeni.nested_agent_depth_policy_source', 'default', false)`;
      for (const file of (await sortedMigrationFiles()).filter(
        (candidate) => candidate >= "0065_" && candidate < "0072_",
      )) {
        await applyAndRecordMigration(sql, file);
      }

      const [{ id: accountId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('invalid concurrent index') returning id`;
      const [{ id: workspaceId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountId}, 'invalid concurrent index') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId}) on conflict do nothing`;
      for (const initialMessage of ["duplicate index key one", "duplicate index key two"]) {
        const id = crypto.randomUUID();
        await sql`
          insert into sessions (
            id, account_id, workspace_id, initial_message, model,
            sandbox_backend, sandbox_group_id
          ) values (
            ${id}, ${accountId}, ${workspaceId}, ${initialMessage},
            'test', 'none', ${id}
          )`;
      }

      await expectPostgresCode(
        sql.unsafe(`
          CREATE UNIQUE INDEX CONCURRENTLY "sessions_workspace_root_depth_idx"
          ON "sessions" ("workspace_id")
        `),
        "23505",
      );
      const [invalid] = await sql<{ valid: boolean }[]>`
        select indisvalid as valid
        from pg_index
        where indexrelid = 'sessions_workspace_root_depth_idx'::regclass`;
      expect(invalid).toEqual({ valid: false });

      await migrate(blank.databaseUrl, undefined, { maxNestedAgentDepth: 3 });
      const [repaired] = await sql<{ oid: number; valid: boolean; columns: string[] }[]>`
        select index_class.oid::int as oid, index.indisvalid as valid,
               array_agg(attribute.attname order by key.ordinality) as columns
        from pg_index index
        join pg_class index_class on index_class.oid = index.indexrelid
        join unnest(index.indkey) with ordinality as key(attnum, ordinality) on true
        join pg_attribute attribute
          on attribute.attrelid = index.indrelid and attribute.attnum = key.attnum
        where index.indexrelid = 'sessions_workspace_root_depth_idx'::regclass
        group by index_class.oid, index.indisvalid`;
      expect(repaired?.valid).toBe(true);
      expect(repaired?.columns).toEqual(["workspace_id", "root_session_id", "nested_agent_depth"]);
      const repairedOid = repaired!.oid;

      await sql`
        delete from schema_migrations
        where name = '0072_nested_agent_depth_index.sql'`;
      await migrate(blank.databaseUrl, undefined, { maxNestedAgentDepth: 3 });
      const [validRetry] = await sql<{ oid: number; migrationRecords: number }[]>`
        select 'sessions_workspace_root_depth_idx'::regclass::oid::int as oid,
               (select count(*)::int from schema_migrations
                where name = '0072_nested_agent_depth_index.sql') as "migrationRecords"`;
      expect(validRetry).toEqual({ oid: repairedOid, migrationRecords: 1 });
    } finally {
      await sql.end().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);

  test("commits bounded backfill batches while old-shape root and child writes remain available", async () => {
    if (!available) return;
    const blank = await acquireBlankTestDatabase("session-depth-policy-batched-backfill");
    if (!blank) throw new Error("real PostgreSQL is required for batched backfill proof");
    const sql = postgres(blank.databaseUrl, { max: 1 });
    const observer = postgres(blank.databaseUrl, { max: 1 });
    const oldWriter = postgres(blank.databaseUrl, { max: 1 });
    let migration: Promise<void> | undefined;
    try {
      await prepareDatabaseThrough0064(sql);
      const [{ id: accountId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('bounded backfill') returning id`;
      const [{ id: workspaceId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountId}, 'bounded backfill') returning id`;
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId}) on conflict do nothing`;

      const legacyRoots = Array.from({ length: 2_500 }, (_, index) => ({
        id: crypto.randomUUID(),
        account_id: accountId,
        workspace_id: workspaceId,
        initial_message: `legacy root ${index}`,
        model: "test",
        sandbox_backend: "none",
      }));
      for (let offset = 0; offset < legacyRoots.length; offset += 500) {
        const batch = legacyRoots.slice(offset, offset + 500);
        await sql`
          insert into sessions (
            id, account_id, workspace_id, initial_message, model,
            sandbox_backend, sandbox_group_id
          )
          select id::uuid, account_id::uuid, workspace_id::uuid, initial_message,
                 model, sandbox_backend, id::uuid
          from jsonb_to_recordset(${sql.json(batch)}::jsonb) as input(
            id text, account_id text, workspace_id text, initial_message text,
            model text, sandbox_backend text
          )`;
      }

      await sql`select set_config('opengeni.max_nested_agent_depth', '3', false)`;
      await sql`select set_config('opengeni.nested_agent_depth_policy_source', 'default', false)`;
      await applyAndRecordMigration(sql, "0065_nested_agent_depth_expand.sql");
      await applyAndRecordMigration(sql, "0066_nested_agent_depth_boundary.sql");
      await grantAppRoleForDepthPolicy(sql);
      await sql.unsafe(`
        CREATE FUNCTION slow_nested_agent_backfill() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(0.002);
          RETURN NEW;
        END $$;
        CREATE TRIGGER slow_nested_agent_backfill
        BEFORE UPDATE OF root_session_id ON sessions
        FOR EACH ROW
        WHEN (OLD.root_session_id IS NULL AND NEW.root_session_id IS NOT NULL)
        EXECUTE FUNCTION slow_nested_agent_backfill();
      `);

      migration = migrate(blank.databaseUrl, undefined, { maxNestedAgentDepth: 3 });
      void migration.catch(() => undefined);
      const deadline = Date.now() + 30_000;
      let committed = 0;
      while (Date.now() < deadline) {
        const [row] = await observer<{ count: number }[]>`
          select count(*)::int as count from sessions
          where workspace_id = ${workspaceId} and root_session_id is not null`;
        committed = row?.count ?? 0;
        if (committed >= 1_000 && committed < 2_500) break;
        await Bun.sleep(50);
      }
      expect(committed).toBeGreaterThanOrEqual(1_000);
      expect(committed).toBeLessThan(2_500);

      const oldRootId = crypto.randomUUID();
      const oldChildId = crypto.randomUUID();
      await oldWriter`begin`;
      await oldWriter.unsafe("set local role opengeni_app");
      await oldWriter`select set_config('opengeni.account_id', ${accountId}, true)`;
      await oldWriter`select set_config('opengeni.workspace_id', ${workspaceId}, true)`;
      await oldWriter`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          sandbox_backend, sandbox_group_id
        ) values (
          ${oldRootId}, ${accountId}, ${workspaceId}, 'old root during backfill',
          'test', 'none', ${oldRootId}
        )`;
      await oldWriter`
        insert into sessions (
          id, account_id, workspace_id, parent_session_id, initial_message, model,
          sandbox_backend, sandbox_group_id
        ) values (
          ${oldChildId}, ${accountId}, ${workspaceId}, ${oldRootId},
          'old child during backfill', 'test', 'none', ${oldChildId}
        )`;
      await oldWriter`commit`;
      await expectStillPending(migration);
      await migration;

      const [finalState] = await observer<
        Array<{ total: number; incomplete: number; childDepth: number; migrations: number }>
      >`
        select
          count(*)::int as total,
          count(*) filter (
            where root_session_id is null or nested_agent_depth is null
              or effective_max_nested_agent_depth is null
              or nested_agent_depth_policy_source is null
          )::int as incomplete,
          max(nested_agent_depth) filter (where id = ${oldChildId})::int as "childDepth",
          (select count(*)::int from schema_migrations
            where name >= '0065_' and name <= '0072_zzzz') as migrations
        from sessions where workspace_id = ${workspaceId}`;
      expect(finalState).toEqual({ total: 2_502, incomplete: 0, childDepth: 1, migrations: 8 });
      const [index] = await observer<{ valid: boolean }[]>`
        select indisvalid as valid from pg_index
        where indexrelid = 'sessions_workspace_root_depth_idx'::regclass`;
      expect(index?.valid).toBe(true);
    } finally {
      await oldWriter`rollback`.catch(() => undefined);
      await migration?.catch(() => undefined);
      await oldWriter.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
      await sql.end().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);
});
