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
    const defaultPolicy = await createSession(db, sessionInput(workspace, "default-policy"));
    expect(defaultPolicy.effectiveMaxNestedAgentDepth).toBe(3);
    expect(defaultPolicy.nestedAgentDepthPolicySource).toBe("default");

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

  test("fails closed for old nested inserts and makes denial evidence append-only", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("rolling-and-immutable");
    const parent = await createSession(db, sessionInput(workspace, "parent"));

    await expect(
      withWorkspaceRls(db, workspace.workspaceId, async (scopedDb) => {
        const childId = crypto.randomUUID();
        await scopedDb.execute(dbSql`
          insert into sessions (
            id, account_id, workspace_id, parent_session_id, initial_message,
            model, sandbox_backend, sandbox_group_id
          ) values (
            ${childId}, ${workspace.accountId}, ${workspace.workspaceId}, ${parent.id},
            'old binary child', 'test', 'none', ${childId}
          )
        `);
      }),
    ).rejects.toThrow();
    expect(await count("sessions", workspace.workspaceId)).toBe(1);

    const descendants = await chain(workspace, 3);
    const outcome = await createSessionWithIdempotencyKey(
      db,
      sessionInput(workspace, "append-only denial", {
        parentSessionId: descendants[2]!.id,
        createIdempotencyKey: "append-only",
        maxNestedAgentDepthOverride: 2,
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

  test("backfills a genuine 0064 deep tree before enforcing 0065", async () => {
    if (!available) return;
    const blank = await acquireBlankTestDatabase("session-depth-policy-backfill");
    if (!blank) throw new Error("real PostgreSQL is required for migration backfill proof");
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((candidate) => candidate < "0065_")) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
      }
      const [{ id: accountId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('0065 backfill') returning id`;
      const [{ id: workspaceId } = { id: "" }] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name, settings)
        values (${accountId}, '0065 backfill', '{"maxNestedAgentDepth":2}') returning id`;
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
      await sql.unsafe(
        await readFile(join(migrationsDir, "0065_nested_agent_depth_policy.sql"), "utf8"),
      );
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
    } finally {
      await sql.end().catch(() => undefined);
      await blank.release();
    }
  }, 180_000);
});
