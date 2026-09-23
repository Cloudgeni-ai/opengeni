import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  clearSessionGoal,
  createDb,
  createSession,
  evaluateGoalContinuation,
  getSessionGoal,
  listSessionEvents,
  type Database,
  type DbClient,
} from "../src/index";

// Persisted goal-state behavior is exercised through the real packages/db
// functions against a throwaway PostgreSQL database under the non-superuser
// application role, so FORCE RLS remains part of the test.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{
  accountId: string;
  workspaceId: string;
}> {
  const [a] = await admin<
    { id: string }[]
  >`insert into managed_accounts (name) values ('acct') returning id`;
  const [w] = await admin<
    { id: string }[]
  >`insert into workspaces (account_id, name) values (${a!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${w!.id}, ${a!.id})`;
  return { accountId: a!.id, workspaceId: w!.id };
}

async function seedSession(ws: { accountId: string; workspaceId: string }): Promise<string> {
  const id = crypto.randomUUID();
  await createSession(db, {
    requestedSessionId: id,
    accountId: ws.accountId,
    workspaceId: ws.workspaceId,
    initialMessage: "go",
    resources: [],
    metadata: {},
    model: "gpt",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "modal",
  });
  return id;
}

// Append a session_event as the superuser at the next durable cursor sequence.
async function appendEvent(
  ws: { accountId: string; workspaceId: string },
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  turnId: string | null = null,
): Promise<void> {
  const [{ next } = { next: 1 }] = await admin<{ next: number }[]>`
    select last_sequence + 1 as next
    from session_event_cursors
    where workspace_id = ${ws.workspaceId} and session_id = ${sessionId}`;
  await admin`
    insert into session_events (account_id, workspace_id, session_id, turn_id, sequence, type, payload)
    values (${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${turnId}, ${next}, ${type}, ${admin.json(payload as Parameters<typeof admin.json>[0])})`;
}

// A finished turn + an active goal whose lastContinuationTurnId points at it, so
// evaluateGoalContinuation reads THIS turn's events to decide the freeze.
async function seedGoalOnFinishedTurn(
  ws: { accountId: string; workspaceId: string },
  sessionId: string,
): Promise<string> {
  const turnId = crypto.randomUUID();
  const triggerEventId = crypto.randomUUID();
  await admin`
    insert into session_turns (id, account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
                               status, position, prompt, model, reasoning_effort, sandbox_backend, finished_at)
    values (${turnId}, ${ws.accountId}, ${ws.workspaceId}, ${sessionId}, ${triggerEventId}, 'wf',
            'failed', 1, 'go', 'gpt', 'medium', 'modal', now())`;
  await admin`
    insert into session_goals (account_id, workspace_id, session_id, status, text,
                               version, auto_continuations, no_progress_streak,
                               last_continuation_turn_id, version_at_last_continuation)
    values (${ws.accountId}, ${ws.workspaceId}, ${sessionId}, 'active', 'ship it',
            1, 0, 0, ${turnId}, 1)`;
  return turnId;
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("codex-capacity-goal-continuation");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[codex-capacity-goal-continuation] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
}, 180_000);

describe("session goal clearing", () => {
  test("deletes the goal row, appends goal.cleared once, and is idempotent", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    await admin`
      insert into session_goals (account_id, workspace_id, session_id, status, text)
      values (${ws.accountId}, ${ws.workspaceId}, ${sessionId}, 'active', 'ship it')`;

    const first = await clearSessionGoal(db, ws.workspaceId, sessionId);
    expect(first.cleared).toBe(true);
    expect(first.goal?.text).toBe("ship it");
    expect(first.event?.type).toBe("goal.cleared");
    expect(await getSessionGoal(db, ws.workspaceId, sessionId)).toBeNull();

    const second = await clearSessionGoal(db, ws.workspaceId, sessionId);
    expect(second).toEqual({ cleared: false, goal: null, event: null });
    const events = await listSessionEvents(db, ws.workspaceId, sessionId);
    expect(events.map((event) => event.type)).toEqual(["goal.cleared"]);
  });
});

describe("evaluateGoalContinuation freezes Codex capacity waits", () => {
  const CONFIG = { defaultMaxAutoContinuations: 100 } as const;

  test("a rotated capacity continuation freezes autoContinuations", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const turnId = await seedGoalOnFinishedTurn(ws, sessionId);
    // Capacity recovery marks the failed turn as rotated so it does not consume goal budget.
    await appendEvent(
      ws,
      sessionId,
      "turn.failed",
      {
        rotated: true,
        recovery: "goal_continuation",
        code: "codex_usage_limit_reached",
      },
      turnId,
    );
    const decision = await evaluateGoalContinuation(db, {
      workspaceId: ws.workspaceId,
      sessionId,
      ...CONFIG,
    });
    expect(decision.decision).toBe("continue");
    // FROZEN: the rotation-wait did not consume the goal's continuation budget.
    expect(decision.decision === "continue" ? decision.autoContinuation : -1).toBe(0);
  });

  test("a normal non-capacity goal continuation still increments", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const turnId = await seedGoalOnFinishedTurn(ws, sessionId);
    // A normal goal continuation has no rotated capacity marker.
    await appendEvent(
      ws,
      sessionId,
      "turn.failed",
      { recovery: "goal_continuation", code: "codex_usage_limit_reached" },
      turnId,
    );
    const decision = await evaluateGoalContinuation(db, {
      workspaceId: ws.workspaceId,
      sessionId,
      ...CONFIG,
    });
    expect(decision.decision).toBe("continue");
    // Not a capacity wait, so the budget advances as before.
    expect(decision.decision === "continue" ? decision.autoContinuation : -1).toBe(1);
  });
});
