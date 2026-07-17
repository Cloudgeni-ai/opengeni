import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import {
  clearSessionGoal,
  countConsecutiveReactiveRotations,
  createDb,
  evaluateGoalContinuation,
  getSessionGoal,
  listSessionEvents,
  type Database,
  type DbClient,
} from "../src/index";

// Finding 1b + Finding 2 — the persisted-event backstops for the codex
// auto-rotation boundedness, driven through the REAL packages/db query fns against
// a throwaway postgres under the NON-superuser opengeni_app role (so FORCE RLS
// actually applies). Seeding is done as the superuser (bypasses RLS).
//
//   Finding 1b — countConsecutiveReactiveRotations: the number of CONSECUTIVE
//     rotated 429-failover turns since the last SUCCESSFUL turn (turn.completed
//     anchor). The reactive path consults it to bound its 0-delay re-dispatch, and
//     it RESETS to 0 the moment a turn.completed lands.
//   Finding 2 — evaluateGoalContinuation must FREEZE autoContinuations for the
//     rotation-wait state on BOTH the reactive AND the (now `rotated:true`)
//     proactive all-capped path, while a NORMAL non-rotation goal continuation
//     still increments. A goal waiting out a reset must not burn its budget.

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

async function freshWorkspace(): Promise<{ accountId: string; workspaceId: string }> {
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
  await admin`
    insert into sessions (id, account_id, workspace_id, initial_message, model, sandbox_backend, sandbox_group_id)
    values (${id}, ${ws.accountId}, ${ws.workspaceId}, 'go', 'gpt', 'modal', ${id})`;
  return id;
}

// Append a session_event as the superuser at the next per-session sequence.
async function appendEvent(
  ws: { accountId: string; workspaceId: string },
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  turnId: string | null = null,
): Promise<void> {
  const [{ next } = { next: 0 }] = await admin<{ next: number }[]>`
    select coalesce(max(sequence), -1) + 1 as next from session_events
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
  shared = await acquireSharedTestDatabase("reactive-rotation-boundedness");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[reactive-rotation-boundedness] docker unavailable, skipping");
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
});

describe("Finding 1b — countConsecutiveReactiveRotations", () => {
  test("no events → 0 (a fresh session is never mid-loop)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    expect(await countConsecutiveReactiveRotations(db, ws.workspaceId, sessionId)).toBe(0);
  });

  test("counts every rotated turn.failed when there is no successful turn yet (the runaway-walk case)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    await appendEvent(ws, sessionId, "turn.failed", {
      rotated: true,
      recovery: "goal_continuation",
    });
    await appendEvent(ws, sessionId, "turn.failed", {
      rotated: true,
      recovery: "goal_continuation",
    });
    await appendEvent(ws, sessionId, "turn.failed", {
      rotated: true,
      recovery: "goal_continuation",
    });
    expect(await countConsecutiveReactiveRotations(db, ws.workspaceId, sessionId)).toBe(3);
  });

  test("a non-rotated turn.failed is NOT counted (only rotation failovers)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    await appendEvent(ws, sessionId, "turn.failed", { rotated: true });
    await appendEvent(ws, sessionId, "turn.failed", { recovery: "provider_backpressure" }); // no rotated marker
    expect(await countConsecutiveReactiveRotations(db, ws.workspaceId, sessionId)).toBe(1);
  });

  test("(2) the streak RESETS after a successful turn (turn.completed moves the anchor past prior failovers)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    // Two failovers, then a SUCCESS, then one more failover.
    await appendEvent(ws, sessionId, "turn.failed", { rotated: true });
    await appendEvent(ws, sessionId, "turn.failed", { rotated: true });
    await appendEvent(ws, sessionId, "turn.completed", { output: "done" }); // real progress → resets the anchor
    await appendEvent(ws, sessionId, "turn.failed", { rotated: true });
    // Only the failover AFTER the success counts — the pre-success streak is forgotten.
    expect(await countConsecutiveReactiveRotations(db, ws.workspaceId, sessionId)).toBe(1);
  });

  test("(2) a success with NO subsequent failover returns 0 (fully reset)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    await appendEvent(ws, sessionId, "turn.failed", { rotated: true });
    await appendEvent(ws, sessionId, "turn.failed", { rotated: true });
    await appendEvent(ws, sessionId, "turn.completed", { output: "done" });
    expect(await countConsecutiveReactiveRotations(db, ws.workspaceId, sessionId)).toBe(0);
  });
});

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

describe("Finding 2 — evaluateGoalContinuation freezes the rotation-wait on BOTH paths", () => {
  const CONFIG = { noProgressLimit: 3, defaultMaxAutoContinuations: 100 } as const;

  test("(3) a rotated:true continuation FREEZES autoContinuations (reactive AND proactive all-capped, post-fix)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const turnId = await seedGoalOnFinishedTurn(ws, sessionId);
    // The turn.failed shape BOTH all-capped paths now emit: recovery=goal_continuation + rotated:true.
    await appendEvent(
      ws,
      sessionId,
      "turn.failed",
      { rotated: true, recovery: "goal_continuation", code: "codex_usage_limit_reached" },
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

  test("(3) a NORMAL non-rotation goal continuation still INCREMENTS (the pre-fix proactive shape / normal backpressure)", async () => {
    if (!available) return;
    const ws = await freshWorkspace();
    const sessionId = await seedSession(ws);
    const turnId = await seedGoalOnFinishedTurn(ws, sessionId);
    // recovery=goal_continuation but NO rotated marker — exactly the proactive all-capped
    // payload BEFORE Finding 2, and a normal (non-rotation) continuation in general.
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
    // Not a rotation wait → the budget advances as before (proves the freeze is scoped to rotation).
    expect(decision.decision === "continue" ? decision.autoContinuation : -1).toBe(1);
  });
});
