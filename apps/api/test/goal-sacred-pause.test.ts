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
// getSessionTurn resolves BY turn id, so a test can give the caller turn and the
// session's active turn different classifications and prove the guard reads the
// CALLER, not the active pointer.
let turnsById: Record<string, any> = {};

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
    db === fakeDb
      ? (turnsById[args[1] as string] ?? null)
      : (realDbFns.getSessionTurn as any)(db, ...args),
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
  turnsById = {};
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

describe("assertGoalReactivationAllowed (sacred user pause, by caller identity)", () => {
  test("REFUSES reactivation when the CALLER is a child-notification turn on a user-paused goal", async () => {
    goal = { status: "paused", pausedReason: "user_interrupt" };
    turnsById["caller"] = { source: "child_notification", metadata: { childCompletion: {} } };
    await expect(assertGoalReactivationAllowed(deps, "ws", "session-1", "caller")).rejects.toThrow(
      /paused by the user/,
    );
  });

  test("ALLOWS when the CALLER is a genuine user turn (user re-directs)", async () => {
    goal = { status: "paused", pausedReason: "user_interrupt" };
    turnsById["caller"] = { source: "user", metadata: {} };
    await expect(
      assertGoalReactivationAllowed(deps, "ws", "session-1", "caller"),
    ).resolves.toBeUndefined();
  });

  test("RACE (inverse — the real, worse hole): a dying MACHINE caller is REFUSED even after the user's turn became active", async () => {
    // The scenario that actually reproduces: a cancelled machine
    // child-notification turn's agent keeps running (~50s cooperative-cancel
    // lag) and calls goal_set AFTER a human turn has already become active.
    // Reading active_turn_id would read the HUMAN turn, classify the caller as
    // human, and wrongly ALLOW the dying machine to resurrect the user-paused
    // goal — the exact hole lever 2 closes. Caller-identity refuses it.
    goal = { status: "paused", pausedReason: "user_interrupt" };
    turnsById["dying-machine"] = {
      source: "child_notification",
      metadata: { childCompletion: {} },
    };
    turnsById["user-active"] = { source: "user", metadata: {} };
    session = { id: "session-1", activeTurnId: "user-active" };
    await expect(
      assertGoalReactivationAllowed(deps, "ws", "session-1", "dying-machine"),
    ).rejects.toThrow(/paused by the user/);
  });

  test("RACE (forward — Bugbot's, thinner): a human caller is ALLOWED even while a machine turn is momentarily active", async () => {
    // The guard must classify the CALLER (a human turn), not the session's
    // active pointer — which here still shows a machine child-notification turn.
    // Reading active_turn_id would misclassify and wrongly refuse the human.
    goal = { status: "paused", pausedReason: "user_interrupt" };
    turnsById["human-caller"] = { source: "user", metadata: {} };
    turnsById["machine-active"] = {
      source: "child_notification",
      metadata: { childCompletion: {} },
    };
    session = { id: "session-1", activeTurnId: "machine-active" };
    await expect(
      assertGoalReactivationAllowed(deps, "ws", "session-1", "human-caller"),
    ).resolves.toBeUndefined();
  });

  test("ALLOWS when the pause was the agent's own (not user_interrupt)", async () => {
    goal = { status: "paused", pausedReason: "agent" };
    turnsById["caller"] = { source: "child_notification", metadata: { childCompletion: {} } };
    await expect(
      assertGoalReactivationAllowed(deps, "ws", "session-1", "caller"),
    ).resolves.toBeUndefined();
  });

  test("ALLOWS when there is no goal or the goal is active", async () => {
    turnsById["caller"] = { source: "child_notification", metadata: { childCompletion: {} } };
    goal = null;
    await expect(
      assertGoalReactivationAllowed(deps, "ws", "session-1", "caller"),
    ).resolves.toBeUndefined();
    goal = { status: "active", pausedReason: null };
    await expect(
      assertGoalReactivationAllowed(deps, "ws", "session-1", "caller"),
    ).resolves.toBeUndefined();
  });

  test("fail-open: no caller identity on the token ⇒ never blocks", async () => {
    goal = { status: "paused", pausedReason: "user_interrupt" };
    turnsById["caller"] = { source: "child_notification", metadata: { childCompletion: {} } };
    await expect(
      assertGoalReactivationAllowed(deps, "ws", "session-1", null),
    ).resolves.toBeUndefined();
  });
});
