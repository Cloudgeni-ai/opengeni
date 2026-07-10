import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// A user-paused goal is sacred: a MACHINE child-notification turn must not
// resurrect it via goal_set, while a genuine user turn still redirects freely.
//
// The db-read mocks are keyed on a `fakeDb` sentinel and delegate to the REAL
// implementation for every other db handle. `mock.module` is process-global and
// does not fully unwind across test files, so a mock that returned fixtures
// unconditionally would corrupt real-db reads in later suites (it did — it fed
// "session-1" into a real createSessionForRequest insert). Delegating keeps the
// override invisible to everyone but this suite.
const fakeDb = {};
let goal: any = null;
let session: any = null;
let turn: any = null;

const realDb = await import("@opengeni/db");
// Capture the real function references BEFORE mock.module replaces them —
// bun's mock.module mutates the module namespace in place, so reading
// `realDb.getSessionGoal` at call time would resolve to the mock itself
// (unbounded recursion). The frozen refs let delegation reach the real impl.
const realDbFns = {
  getSessionGoal: realDb.getSessionGoal,
  getSession: realDb.getSession,
  getSessionTurn: realDb.getSessionTurn,
};
mock.module("@opengeni/db", () => ({
  ...realDb,
  getSessionGoal: mock(async (db: unknown, ...args: unknown[]) =>
    db === fakeDb ? goal : (realDbFns.getSessionGoal as any)(db, ...args),
  ),
  getSession: mock(async (db: unknown, ...args: unknown[]) =>
    db === fakeDb ? session : (realDbFns.getSession as any)(db, ...args),
  ),
  getSessionTurn: mock(async (db: unknown, ...args: unknown[]) =>
    db === fakeDb ? turn : (realDbFns.getSessionTurn as any)(db, ...args),
  ),
}));

const { assertGoalReactivationAllowed, isMachineChildNotificationTurn } =
  await import("../src/mcp/server");

const deps = { db: fakeDb } as any;

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  goal = null;
  session = { id: "session-1", activeTurnId: "turn-1" };
  turn = null;
});

describe("isMachineChildNotificationTurn", () => {
  test("true for the coalesced digest source", () => {
    expect(isMachineChildNotificationTurn({ source: "child_notification", metadata: {} })).toBe(
      true,
    );
  });
  test("true for a legacy per-child wake (childCompletion marker)", () => {
    expect(
      isMachineChildNotificationTurn({ source: "user", metadata: { childCompletion: {} } }),
    ).toBe(true);
  });
  test("false for a genuine user message and a goal continuation", () => {
    expect(isMachineChildNotificationTurn({ source: "user", metadata: {} })).toBe(false);
    expect(isMachineChildNotificationTurn({ source: "goal", metadata: { goalId: "g" } })).toBe(
      false,
    );
  });
});

describe("assertGoalReactivationAllowed (sacred user pause)", () => {
  test("REFUSES reactivation from a child-notification turn on a user-paused goal", async () => {
    goal = { status: "paused", pausedReason: "user_interrupt" };
    turn = { source: "child_notification", metadata: { childCompletion: {} } };
    await expect(assertGoalReactivationAllowed(deps, "ws", "session-1")).rejects.toThrow(
      /paused by the user/,
    );
  });

  test("ALLOWS reactivation from a genuine user turn (user re-directs)", async () => {
    goal = { status: "paused", pausedReason: "user_interrupt" };
    turn = { source: "user", metadata: {} };
    await expect(assertGoalReactivationAllowed(deps, "ws", "session-1")).resolves.toBeUndefined();
  });

  test("ALLOWS when the pause was the agent's own (not user_interrupt)", async () => {
    goal = { status: "paused", pausedReason: "agent" };
    turn = { source: "child_notification", metadata: { childCompletion: {} } };
    await expect(assertGoalReactivationAllowed(deps, "ws", "session-1")).resolves.toBeUndefined();
  });

  test("ALLOWS when there is no goal or the goal is active", async () => {
    goal = null;
    turn = { source: "child_notification", metadata: { childCompletion: {} } };
    await expect(assertGoalReactivationAllowed(deps, "ws", "session-1")).resolves.toBeUndefined();
    goal = { status: "active", pausedReason: null };
    await expect(assertGoalReactivationAllowed(deps, "ws", "session-1")).resolves.toBeUndefined();
  });

  test("ALLOWS when the session has no active turn", async () => {
    goal = { status: "paused", pausedReason: "user_interrupt" };
    session = { id: "session-1", activeTurnId: null };
    await expect(assertGoalReactivationAllowed(deps, "ws", "session-1")).resolves.toBeUndefined();
  });
});
