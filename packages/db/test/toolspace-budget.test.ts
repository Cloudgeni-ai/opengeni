// reserveToolspaceCallForAttempt — the attempt-fenced toolspace call budget.
//
// The budget used to be read-count-then-compare (count `agent.toolCall.created`
// toolspace events, compare to the limit, then append the next event). Under
// concurrency every simultaneous tools/call read the same stale count and all
// passed. The reservation is now a single conditional UPDATE on
// session_turns.toolspace_call_count; the row lock serializes concurrent
// reservations so exactly `limit` of N parallel callers win.
//
// Run against a THROWAWAY migrated database from the shared test container.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  createDb,
  createSession,
  reserveToolspaceCallForAttempt,
  type Database,
  type DbClient,
} from "../src/index";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let db: Database;
let admin: SharedTestDatabase["admin"];
let available = true;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("toolspace-budget");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[toolspace-budget] docker unavailable, skipping");
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

async function freshTurn(): Promise<{
  workspaceId: string;
  accountId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
}> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  await admin`insert into workspace_inference_controls (workspace_id, account_id) values (${workspace!.id}, ${account!.id})`;
  const session = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "hello",
    resources: [],
    metadata: {},
    model: "gpt-5.6-sol",
    sandboxBackend: "none",
  });
  const attemptId = crypto.randomUUID();
  const [turn] = await admin<{ id: string }[]>`
    insert into session_turns
      (account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
       status, position, prompt, model, reasoning_effort, sandbox_backend,
       execution_generation, active_attempt_id)
    values
      (${account!.id}, ${workspace!.id}, ${session.id}, gen_random_uuid(), 'wf-1',
       'running', 0, 'hello', 'gpt-5.6-sol', 'medium', 'none', 1, null)
    returning id`;
  await admin`
    insert into session_turn_attempts (
      id, account_id, workspace_id, session_id, turn_id, execution_generation,
      state, temporal_workflow_id, temporal_workflow_run_id, temporal_activity_id,
      verified_control_revision, mcp_approval_policies
    ) values (
      ${attemptId}, ${account!.id}, ${workspace!.id}, ${session.id}, ${turn!.id}, 1,
      'running', 'wf-1', ${`run-${attemptId}`}, ${`activity-${attemptId}`}, 0,
      '{}'::jsonb
    )`;
  await admin`
    update session_turns
    set active_attempt_id = ${attemptId}
    where id = ${turn!.id}`;
  await admin`
    update sessions
    set active_turn_id = ${turn!.id}, status = 'running'
    where id = ${session.id}`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    sessionId: session.id,
    turnId: turn!.id,
    attemptId,
  };
}

async function currentCount(turnId: string): Promise<number> {
  const [row] = await admin<{ toolspace_call_count: number }[]>`
    select toolspace_call_count from session_turns where id = ${turnId}`;
  return Number(row!.toolspace_call_count);
}

function reservationInput(
  seed: Awaited<ReturnType<typeof freshTurn>>,
  limit: number,
): Parameters<typeof reserveToolspaceCallForAttempt>[1] {
  return {
    ...seed,
    executionGeneration: 1,
    limit,
  };
}

describe("reserveToolspaceCallForAttempt", () => {
  test("N parallel reservations with limit < N: exactly `limit` succeed", async () => {
    if (!available) return;
    const seed = await freshTurn();
    const limit = 5;
    const parallel = 40;

    const results = await Promise.all(
      Array.from({ length: parallel }, () =>
        reserveToolspaceCallForAttempt(db, reservationInput(seed, limit)),
      ),
    );

    const reserved = results.filter((r) => r.reserved);
    expect(reserved.length).toBe(limit);
    expect(reserved.every((result) => result.turn.activeAttemptId === seed.attemptId)).toBe(true);
    expect(results.length - reserved.length).toBe(parallel - limit);
    // The returned counts are the distinct post-increment values 1..limit.
    expect(reserved.map((r) => (r as { count: number }).count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // The persisted counter never overshoots the limit.
    expect(await currentCount(seed.turnId)).toBe(limit);
  }, 60_000);

  test("sequential reservations increment then stop at the limit", async () => {
    if (!available) return;
    const seed = await freshTurn();
    const limit = 3;

    const first = await reserveToolspaceCallForAttempt(db, reservationInput(seed, limit));
    const second = await reserveToolspaceCallForAttempt(db, reservationInput(seed, limit));
    const third = await reserveToolspaceCallForAttempt(db, reservationInput(seed, limit));
    const fourth = await reserveToolspaceCallForAttempt(db, reservationInput(seed, limit));

    expect(first.reserved && first.count).toBe(1);
    expect(second.reserved && second.count).toBe(2);
    expect(third.reserved && third.count).toBe(3);
    expect(fourth).toEqual({ reserved: false, reason: "budget_exhausted" });
    expect(await currentCount(seed.turnId)).toBe(limit);
  }, 60_000);

  test("an unknown turn id never reserves", async () => {
    if (!available) return;
    const seed = await freshTurn();
    const result = await reserveToolspaceCallForAttempt(db, {
      ...reservationInput(seed, 10),
      turnId: crypto.randomUUID(),
    });
    expect(result).toEqual({ reserved: false, reason: "not_found" });
  }, 60_000);
});
