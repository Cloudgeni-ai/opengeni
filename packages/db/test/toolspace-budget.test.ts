// reserveToolspaceCallForTurn — the atomic per-turn toolspace call budget.
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
  reserveToolspaceCallForTurn,
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

async function freshTurn(): Promise<{ workspaceId: string; sessionId: string; turnId: string }> {
  const [account] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('acct') returning id`;
  const [workspace] = await admin<{ id: string }[]>`
    insert into workspaces (account_id, name) values (${account!.id}, 'ws') returning id`;
  const session = await createSession(db, {
    accountId: account!.id,
    workspaceId: workspace!.id,
    initialMessage: "hello",
    resources: [],
    metadata: {},
    model: "gpt-5.5",
    sandboxBackend: "none",
  });
  const [turn] = await admin<{ id: string }[]>`
    insert into session_turns
      (account_id, workspace_id, session_id, trigger_event_id, temporal_workflow_id,
       status, position, prompt, model, reasoning_effort, sandbox_backend)
    values
      (${account!.id}, ${workspace!.id}, ${session.id}, gen_random_uuid(), 'wf-1',
       'running', 0, 'hello', 'gpt-5.5', 'medium', 'none')
    returning id`;
  return { workspaceId: workspace!.id, sessionId: session.id, turnId: turn!.id };
}

async function currentCount(turnId: string): Promise<number> {
  const [row] = await admin<{ toolspace_call_count: number }[]>`
    select toolspace_call_count from session_turns where id = ${turnId}`;
  return Number(row!.toolspace_call_count);
}

describe("reserveToolspaceCallForTurn", () => {
  test("N parallel reservations with limit < N: exactly `limit` succeed", async () => {
    if (!available) return;
    const { workspaceId, sessionId, turnId } = await freshTurn();
    const limit = 5;
    const parallel = 40;

    const results = await Promise.all(
      Array.from({ length: parallel }, () =>
        reserveToolspaceCallForTurn(db, workspaceId, sessionId, turnId, limit),
      ),
    );

    const reserved = results.filter((r) => r.reserved);
    expect(reserved.length).toBe(limit);
    expect(results.length - reserved.length).toBe(parallel - limit);
    // The returned counts are the distinct post-increment values 1..limit.
    expect(reserved.map((r) => (r as { count: number }).count).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // The persisted counter never overshoots the limit.
    expect(await currentCount(turnId)).toBe(limit);
  }, 60_000);

  test("sequential reservations increment then stop at the limit", async () => {
    if (!available) return;
    const { workspaceId, sessionId, turnId } = await freshTurn();
    const limit = 3;

    const first = await reserveToolspaceCallForTurn(db, workspaceId, sessionId, turnId, limit);
    const second = await reserveToolspaceCallForTurn(db, workspaceId, sessionId, turnId, limit);
    const third = await reserveToolspaceCallForTurn(db, workspaceId, sessionId, turnId, limit);
    const fourth = await reserveToolspaceCallForTurn(db, workspaceId, sessionId, turnId, limit);

    expect(first).toEqual({ reserved: true, count: 1 });
    expect(second).toEqual({ reserved: true, count: 2 });
    expect(third).toEqual({ reserved: true, count: 3 });
    expect(fourth).toEqual({ reserved: false });
    expect(await currentCount(turnId)).toBe(limit);
  }, 60_000);

  test("an unknown turn id never reserves", async () => {
    if (!available) return;
    const { workspaceId, sessionId } = await freshTurn();
    const result = await reserveToolspaceCallForTurn(
      db,
      workspaceId,
      sessionId,
      crypto.randomUUID(),
      10,
    );
    expect(result).toEqual({ reserved: false });
  }, 60_000);
});
