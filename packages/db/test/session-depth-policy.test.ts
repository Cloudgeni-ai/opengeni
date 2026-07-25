import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSession,
  createSessionWithIdempotencyKeyResult,
  getSessionSpawnDenialByIdempotencyKey,
  type DbClient,
  type Database,
  type SessionCreateResult,
} from "../src/index";
import { migrate } from "../src/migrate";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

type Workspace = { accountId: string; workspaceId: string };

async function freshWorkspace(name: string): Promise<Workspace> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, ${name}) returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

function sessionInput(
  workspace: Workspace,
  initialMessage: string,
  extra: Record<string, unknown> = {},
) {
  return {
    accountId: workspace.accountId,
    workspaceId: workspace.workspaceId,
    initialMessage,
    resources: [],
    metadata: {},
    model: "depth-policy-test",
    sandboxBackend: "none" as const,
    ...extra,
  };
}

function denied(result: SessionCreateResult) {
  if (!result.denied) throw new Error(`expected denial for ${result.session.id}`);
  return result.denial;
}

async function count(table: "sessions" | "session_spawn_denials", workspaceId: string) {
  const [row] = await admin<{ count: number }[]>`
    select count(*)::int as count from ${admin(table)} where workspace_id = ${workspaceId}`;
  return row?.count ?? 0;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("session-depth-policy-current");
  if (!shared) {
    available = false;
    console.warn("[session-depth-policy-current] PostgreSQL unavailable, skipping");
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

describe("nested-agent depth database admission", () => {
  test("uses the default 3 and persists root-to-depth-three lineage", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("db depth default");
    const root = await createSession(db, sessionInput(workspace, "root"));
    const child = await createSession(
      db,
      sessionInput(workspace, "child", { parentSessionId: root.id }),
    );
    const grandchild = await createSession(
      db,
      sessionInput(workspace, "grandchild", { parentSessionId: child.id }),
    );
    const depth3 = await createSession(
      db,
      sessionInput(workspace, "depth3", { parentSessionId: grandchild.id }),
    );

    expect([root, child, grandchild, depth3].map((session) => session.nestedAgentDepth)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(depth3).toMatchObject({
      rootSessionId: root.id,
      effectiveMaxNestedAgentDepth: 3,
      nestedAgentDepthPolicySource: "default",
      nestedAgentDepthPolicySessionId: null,
    });
  }, 60_000);

  test("records one keyed denial without creating a session or child artifacts", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("db depth denial");
    const root = await createSession(db, sessionInput(workspace, "root"));
    let parent = root;
    for (let depth = 1; depth <= 3; depth += 1) {
      parent = await createSession(
        db,
        sessionInput(workspace, `depth-${depth}`, { parentSessionId: parent.id }),
      );
    }
    const key = `depth-denial-${crypto.randomUUID()}`;
    const input = sessionInput(workspace, "denied", {
      parentSessionId: parent.id,
      createIdempotencyKey: key,
      subjectId: "subject:denied",
      mcpServers: [{ id: "denied-mcp", url: "https://mcp.example.test", headersEncrypted: {} }],
    });

    const first = await createSessionWithIdempotencyKeyResult(db, {
      ...input,
      createIdempotencyKey: key,
    });
    const retry = await createSessionWithIdempotencyKeyResult(db, {
      ...input,
      initialMessage: "mutated retry",
      createIdempotencyKey: key,
    });
    const firstDenial = denied(first);
    const retryDenial = denied(retry);

    expect(retryDenial.id).toBe(firstDenial.id);
    expect(firstDenial).toMatchObject({
      parentSessionId: parent.id,
      rootSessionId: root.id,
      currentDepth: 3,
      attemptedDepth: 4,
      effectiveMaxNestedAgentDepth: 3,
      policySource: "default",
      subjectId: "subject:denied",
      code: "nested_agent_depth_exceeded",
      idempotencyKey: key,
    });
    expect(await count("sessions", workspace.workspaceId)).toBe(4);
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(1);
    expect((await getSessionSpawnDenialByIdempotencyKey(db, workspace.workspaceId, key))?.id).toBe(
      firstDenial.id,
    );
  }, 60_000);

  test("serializes an old source writer with current admission and replays the success winner", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("db depth success race");
    const key = `success-race-${crypto.randomUUID()}`;
    const lockKey = `session-create:${workspace.workspaceId}:${key}`;

    // This direct transaction represents a pre-boundary writer. It takes the
    // same advisory lock as the boundary trigger, reserves the source row, and
    // holds the transaction open while the current application writer waits.
    const oldWriter = admin.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`;
      await sql`select pg_sleep(0.1)`;
      const rows = await sql<{ id: string }[]>`
        insert into sessions (
          account_id, workspace_id, initial_message, model, sandbox_backend,
          sandbox_group_id, create_idempotency_key
        ) values (
          ${workspace.accountId}, ${workspace.workspaceId}, 'old writer',
          'depth-policy-test', 'none', gen_random_uuid(), ${key}
        )
        returning id`;
      await sql`select pg_sleep(0.1)`;
      return rows[0]?.id ?? null;
    });
    await delay(25);

    const currentWriter = createSessionWithIdempotencyKeyResult(db, {
      ...sessionInput(workspace, "current writer"),
      createIdempotencyKey: key,
    });
    const [oldSessionId, replay] = await Promise.all([oldWriter, currentWriter]);

    expect(oldSessionId).not.toBeNull();
    if (oldSessionId === null) throw new Error("old writer did not create a session");
    expect(replay.denied).toBe(false);
    if (replay.denied) return;
    expect(replay.created).toBe(false);
    expect(replay.session.id).toBe(oldSessionId);
    expect(await count("sessions", workspace.workspaceId)).toBe(1);

    // A contradictory denial is suppressed by the BEFORE guard rather than
    // surfacing a raw 23505 or creating a second outcome row.
    const denialRows = await admin<{ id: string }[]>`
      insert into session_spawn_denials (
        account_id, workspace_id, current_depth, attempted_depth,
        effective_max_nested_agent_depth, policy_source, code, idempotency_key
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, 0, 1, 0,
        'default', 'nested_agent_depth_exceeded', ${key}
      )
      returning id`;
    expect(denialRows).toHaveLength(0);
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(0);
  }, 60_000);

  test("serializes an old denial writer and replays the denial winner", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("db depth denial race");
    const key = `denial-race-${crypto.randomUUID()}`;
    const lockKey = `session-create:${workspace.workspaceId}:${key}`;

    const oldWriter = admin.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${lockKey}))`;
      await sql`select pg_sleep(0.1)`;
      const rows = await sql<{ id: string }[]>`
        insert into session_spawn_denials (
          account_id, workspace_id, current_depth, attempted_depth,
          effective_max_nested_agent_depth, policy_source, code, idempotency_key
        ) values (
          ${workspace.accountId}, ${workspace.workspaceId}, 3, 4, 3,
          'default', 'nested_agent_depth_exceeded', ${key}
        )
        returning id`;
      await sql`select pg_sleep(0.1)`;
      return rows[0]?.id ?? null;
    });
    await delay(25);

    const currentWriter = createSessionWithIdempotencyKeyResult(db, {
      ...sessionInput(workspace, "current writer"),
      createIdempotencyKey: key,
    });
    const [oldDenialId, replay] = await Promise.all([oldWriter, currentWriter]);

    expect(oldDenialId).not.toBeNull();
    if (oldDenialId === null) throw new Error("old writer did not create a denial");
    expect(replay.denied).toBe(true);
    const replayedDenial = denied(replay);
    expect(replayedDenial.id).toBe(oldDenialId);
    expect(await count("sessions", workspace.workspaceId)).toBe(0);
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(1);

    // The old success-shaped source write is also suppressed by the same
    // ledger winner, with no raw unique violation and no session artifact.
    const sessionRows = await admin<{ id: string }[]>`
      insert into sessions (
        account_id, workspace_id, initial_message, model, sandbox_backend,
        sandbox_group_id, create_idempotency_key
      ) values (
        ${workspace.accountId}, ${workspace.workspaceId}, 'old success',
        'depth-policy-test', 'none', gen_random_uuid(), ${key}
      )
      returning id`;
    expect(sessionRows).toHaveLength(0);
    expect(await count("sessions", workspace.workspaceId)).toBe(0);
  }, 60_000);

  test("installs the guard before insert and cascades its ledger on workspace deletion", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("db depth guard cleanup");
    const successKey = `guard-success-${crypto.randomUUID()}`;
    const denialKey = `guard-denial-${crypto.randomUUID()}`;
    await createSession(
      db,
      sessionInput(workspace, "success", { createIdempotencyKey: successKey }),
    );
    const denial = await createSessionWithIdempotencyKeyResult(db, {
      ...sessionInput(workspace, "denied", { maxNestedAgentDepthOverride: 5 }),
      createIdempotencyKey: denialKey,
    });
    expect(denied(denial).code).toBe("nested_agent_depth_override_forbidden");

    const [trigger] = await admin<{ definition: string }[]>`
      select pg_get_triggerdef(oid) as definition
      from pg_trigger
      where tgrelid = 'sessions'::regclass
        and tgname = 'session_idempotency_guard'
        and not tgisinternal`;
    expect(trigger?.definition).toContain("BEFORE INSERT");

    const [before] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from session_create_idempotency_guard
      where workspace_id = ${workspace.workspaceId}`;
    expect(before?.count).toBe(2);

    await admin`delete from workspaces where id = ${workspace.workspaceId}`;

    const [after] = await admin<{ count: number }[]>`
      select count(*)::int as count
      from session_create_idempotency_guard
      where workspace_id = ${workspace.workspaceId}`;
    expect(after?.count).toBe(0);
    expect(await count("session_spawn_denials", workspace.workspaceId)).toBe(0);
  }, 60_000);

  test("allows reductions, requires authorization for increases, and inherits session policy", async () => {
    if (!available) return;
    const workspace = await freshWorkspace("db depth overrides");
    const reduced = await createSession(
      db,
      sessionInput(workspace, "reduced", { maxNestedAgentDepthOverride: 1 }),
    );
    const inherited = await createSession(
      db,
      sessionInput(workspace, "inherited", { parentSessionId: reduced.id }),
    );
    expect(reduced).toMatchObject({
      effectiveMaxNestedAgentDepth: 1,
      nestedAgentDepthPolicySource: "session",
      nestedAgentDepthPolicySessionId: reduced.id,
    });
    expect(inherited).toMatchObject({
      effectiveMaxNestedAgentDepth: 1,
      nestedAgentDepthPolicySource: "session",
      nestedAgentDepthPolicySessionId: reduced.id,
    });

    const forbidden = await createSessionWithIdempotencyKeyResult(db, {
      ...sessionInput(workspace, "forbidden increase", { maxNestedAgentDepthOverride: 5 }),
      createIdempotencyKey: `forbidden-${crypto.randomUUID()}`,
    });
    expect(denied(forbidden).code).toBe("nested_agent_depth_override_forbidden");

    const authorized = await createSession(
      db,
      sessionInput(workspace, "authorized increase", {
        maxNestedAgentDepthOverride: 5,
        allowNestedAgentDepthIncrease: true,
      }),
    );
    expect(authorized).toMatchObject({
      effectiveMaxNestedAgentDepth: 5,
      nestedAgentDepthPolicySource: "session",
      nestedAgentDepthPolicySessionId: authorized.id,
    });
  }, 60_000);

  test("uses persisted deployment policy rather than process configuration", async () => {
    if (!available) return;
    await migrate(shared!.adminUrl, undefined, { maxNestedAgentDepth: 5 });
    try {
      const workspace = await freshWorkspace("db persisted deployment policy");
      const session = await createSession(db, sessionInput(workspace, "persisted policy"));
      expect(session).toMatchObject({
        effectiveMaxNestedAgentDepth: 5,
        nestedAgentDepthPolicySource: "deployment",
      });
    } finally {
      await migrate(shared!.adminUrl, undefined, {});
    }
  }, 60_000);
});
