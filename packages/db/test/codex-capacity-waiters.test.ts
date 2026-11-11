import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  claimSessionWorkForAttempt,
  codexCapacityRefreshBackoffMs,
  createDb,
  withSessionActivityRlsContext,
  type Database,
  type DbClient,
} from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let monitor: postgres.Sql;
let clientA: DbClient;
let claimClient: DbClient;
let dbA: Database;
let claimDb: Database;

type Workspace = { accountId: string; workspaceId: string };
type CapacityScenario = Workspace & {
  sessionId: string;
  turnId: string;
  attemptId: string;
  goalId: string | null;
  workflowId: string;
};

async function claimTestTurn(
  db: Database,
  workspaceId: string,
  sessionId: string,
  workflowId: string,
) {
  const result = await claimSessionWorkForAttempt(db, workspaceId, {
    sessionId,
    workflowId,
    workflowRunId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  return result.action === "claimed" ? result.turn : null;
}

async function freshWorkspace(): Promise<Workspace> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('codex capacity account') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, 'codex capacity workspace') returning id`;
  await admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  return { accountId: account!.id, workspaceId: workspace!.id };
}

async function seedScenario(
  ws: Workspace,
  options: { withGoal?: boolean } = {},
): Promise<CapacityScenario> {
  const sessionId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const goalId = crypto.randomUUID();
  const workflowId = `session-${sessionId}`;
  await withSessionActivityRlsContext(
    dbA,
    { accountId: ws.accountId, workspaceId: ws.workspaceId },
    async (tx) => {
      await tx.execute(sql`
        insert into sessions (
          id, account_id, workspace_id, initial_message, model,
          reasoning_effort, latency_mode, sandbox_backend, sandbox_group_id, status,
          temporal_workflow_id, tool_policy
        ) values (
          ${sessionId}, ${ws.accountId}, ${ws.workspaceId}, 'capacity test',
          'codex/gpt-6-sol', 'medium', 'standard', 'modal', ${sessionId}, 'running', ${workflowId},
          jsonb_build_object('mode', 'explicit', 'inheritedFromSessionId', null)
        )
      `);
      await tx.execute(sql`
      insert into session_turns (
        id, account_id, workspace_id, session_id, trigger_event_id,
        temporal_workflow_id, status, position, prompt, model,
        reasoning_effort, sandbox_backend, resources, tools, metadata,
        execution_generation, active_attempt_id
      ) values (
        ${turnId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${crypto.randomUUID()},
        ${workflowId}, 'running', 1, 'capacity test', 'codex/gpt-6-sol',
        'xhigh', 'modal', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
        1, ${attemptId}
      )
      `);
      await tx.execute(sql`update sessions set active_turn_id = ${turnId} where id = ${sessionId}`);
      await tx.execute(sql`
        insert into session_turn_attempts (
          id, account_id, workspace_id, session_id, turn_id,
          execution_generation, state, temporal_workflow_id,
          temporal_workflow_run_id, temporal_activity_id, verified_control_revision,
          mcp_approval_policies
        ) values (
          ${attemptId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${turnId},
          1, 'running', ${workflowId}, ${`run-${attemptId}`}, ${`capacity-${attemptId}`}, 0,
          '{}'::jsonb
        )
      `);
    },
  );
  if (options.withGoal !== false) {
    await admin`
      insert into session_goals (
        id, account_id, workspace_id, session_id, status, text,
        success_criteria, version, max_auto_continuations
      ) values (
        ${goalId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, 'active',
        'finish the capacity test', 'resume exactly once', 1, 20
      )`;
  }
  return {
    ...ws,
    sessionId,
    turnId,
    attemptId,
    goalId: options.withGoal === false ? null : goalId,
    workflowId,
  };
}

async function waitForAppSessionLockWait(blockerPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const [row] = await monitor<{ waiting: number }[]>`
      select count(*)::int as waiting
      from pg_stat_activity
      where datname = current_database()
        and usename = 'opengeni_app'
        and state = 'active'
        and wait_event_type = 'Lock'
        and ${blockerPid} = any(pg_blocking_pids(pid))`;
    if ((row?.waiting ?? 0) > 0) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("claim did not block on the session row");
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("codex-capacity-waiters");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("Codex capacity waiter regressions require a real PostgreSQL database");
    }
    available = false;
    console.warn("[codex-capacity-waiters] postgres unavailable, skipping");
    return;
  }
  admin = shared.admin;
  monitor = postgres(shared.adminUrl, { max: 1 });
  clientA = createDb(shared.appUrl, { max: 12 });
  claimClient = createDb(shared.appUrl, { max: 1 });
  dbA = clientA.db;
  claimDb = claimClient.db;
}, 180_000);

afterAll(async () => {
  await claimClient?.close().catch(() => undefined);
  await clientA?.close().catch(() => undefined);
  await monitor?.end().catch(() => undefined);
  await shared?.release();
}, 180_000);

describe("durable Codex capacity waits", () => {
  test("bounded unknown-reset backoff is deterministic and capped", () => {
    expect(codexCapacityRefreshBackoffMs(-1)).toBe(60_000);
    expect(codexCapacityRefreshBackoffMs(0)).toBe(60_000);
    expect(codexCapacityRefreshBackoffMs(1)).toBe(120_000);
    expect(codexCapacityRefreshBackoffMs(4)).toBe(900_000);
    expect(codexCapacityRefreshBackoffMs(100)).toBe(900_000);
  });

  test("claim locks the session before a pending internal update", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const scenario = await seedScenario(ws);
    const updateId = crypto.randomUUID();
    await withSessionActivityRlsContext(
      dbA,
      { accountId: scenario.accountId, workspaceId: scenario.workspaceId },
      async (tx) => {
        await tx.execute(sql`
        update session_turn_attempts
        set state = 'closed', outcome = 'completed', closed_at = now(), updated_at = now()
        where workspace_id = ${scenario.workspaceId} and id = ${scenario.attemptId}
        `);
        await tx.execute(sql`
        update session_turns
        set status = 'completed', active_attempt_id = null, finished_at = now(), updated_at = now()
        where workspace_id = ${scenario.workspaceId} and id = ${scenario.turnId}
        `);
        await tx.execute(sql`
        update sessions
        set status = 'queued', active_turn_id = null, updated_at = now()
        where workspace_id = ${scenario.workspaceId} and id = ${scenario.sessionId}
        `);
        await tx.execute(sql`
        insert into session_system_updates (
          id, account_id, workspace_id, session_id, kind, classification,
          source_id, dedupe_key, summary, payload, lineage, state
        ) values (
          ${updateId}, ${scenario.accountId}, ${scenario.workspaceId}, ${scenario.sessionId},
          'agent_steer_instruction', 'action_required', ${scenario.sessionId},
          ${`capacity-lock-detector:${updateId}`}, 'lock-order detector',
          ${JSON.stringify({
            type: "agent_steer_instruction",
            instruction: "verify canonical claim lock order",
            operationId: updateId,
          })}::jsonb,
          '{}'::jsonb, 'pending'
        )
        `);
      },
    );

    let claim: ReturnType<typeof claimTestTurn> | null = null;
    await admin.begin(async (lockTx) => {
      await lockTx`
        select id from sessions
        where workspace_id = ${scenario.workspaceId} and id = ${scenario.sessionId}
        for update`;
      const [blocker] = await lockTx<{ pid: number }[]>`
        select pg_backend_pid()::int as pid`;
      if (!blocker) throw new Error("expected blocker backend");
      claim = claimTestTurn(claimDb, scenario.workspaceId, scenario.sessionId, scenario.workflowId);
      await waitForAppSessionLockWait(blocker.pid);

      // A pending-update-first claim would form update -> session / session ->
      // update and time out here. Canonical session-first claim leaves this row
      // independently lockable while the claim waits on the session.
      await lockTx`set local lock_timeout = '250ms'`;
      const locked = await lockTx<{ id: string }[]>`
        select id from session_system_updates
        where workspace_id = ${scenario.workspaceId} and id = ${updateId}
        for update`;
      expect(locked.map((row) => row.id)).toEqual([updateId]);
    });

    const claimed = await claim!;
    expect(claimed?.source).toBe("system");
    const [delivered] = await admin<{ delivered_turn_id: string | null; state: string }[]>`
      select delivered_turn_id, state from session_system_updates where id = ${updateId}`;
    expect(delivered).toEqual({ delivered_turn_id: claimed?.id ?? null, state: "delivered" });
  });
});
