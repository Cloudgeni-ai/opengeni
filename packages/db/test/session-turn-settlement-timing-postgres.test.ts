import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  initializeSessionStartAtomically,
  type SessionTurnSettlementTiming,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-turn-settlement-timing");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

async function claimedTurn() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `account-${suffix}`,
    accountName: "Settlement timing",
    workspaceExternalSource: "test",
    workspaceExternalId: `workspace-${suffix}`,
    workspaceName: "Settlement timing",
    subjectId: `subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "work",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await initializeSessionStartAtomically(client.db, {
    accountId: grant.accountId,
    workspaceId,
    sessionId: session.id,
    reasoningEffortFallback: "low",
    createdEventPayload: {},
  });
  const attemptId = crypto.randomUUID();
  const claimed = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    attemptId,
    dispatchId: crypto.randomUUID(),
    trigger: { kind: "next" },
  });
  if (claimed.action !== "claimed") throw new Error(`could not claim fixture: ${claimed.reason}`);
  return { workspaceId, sessionId: session.id, attemptId, turn: claimed.turn };
}

async function cancelTurn(
  fixture: Awaited<ReturnType<typeof claimedTurn>>,
  onTiming: (timing: SessionTurnSettlementTiming) => unknown,
) {
  return await applySessionTurnSettlement(
    client.db,
    fixture.workspaceId,
    {
      sessionId: fixture.sessionId,
      turnId: fixture.turn.id,
      triggerEventId: fixture.turn.triggerEventId,
      attemptId: fixture.attemptId,
      turnStatus: "cancelled",
      sessionStatus: "idle",
      activeTurnId: null,
      events: [
        { type: "turn.cancelled", payload: { reason: "user" } },
        { type: "session.status.changed", payload: { status: "idle" } },
      ],
    },
    { onTiming },
  );
}

describe("turn settlement timing", () => {
  test("attributes a wait behind another session-row holder to the lock phase", async () => {
    const fixture = await claimedTurn();
    const holdMs = 1_200;
    let locked!: () => void;
    const rowLocked = new Promise<void>((resolve) => (locked = resolve));
    const holder = shared.admin.begin(async (sql) => {
      await sql`select id from sessions where id = ${fixture.sessionId} for update`;
      locked();
      await Bun.sleep(holdMs);
    });
    await rowLocked;

    const timings: SessionTurnSettlementTiming[] = [];
    const settled = await cancelTurn(fixture, (timing) => timings.push(timing));
    await holder;

    expect(settled.action).toBe("settled");
    expect(timings).toHaveLength(1);
    const [timing] = timings;
    expect(timing).toMatchObject({ action: "settled", attempts: 1 });
    expect(timing!.lockWaitMs).toBeGreaterThanOrEqual(holdMs - 100);
    expect(timing!.validateMs).not.toBeNull();
    expect(timing!.writeMs).not.toBeNull();
    expect(timing!.totalMs).toBeGreaterThanOrEqual(
      timing!.admissionMs + timing!.lockWaitMs + timing!.validateMs! + timing!.writeMs! - 2,
    );
    // The wait is the other holder's, not the settlement's own work.
    expect(timing!.writeMs! + timing!.commitMs).toBeLessThan(holdMs);
  }, 60_000);

  test("reports a stale settlement's time without write phases", async () => {
    const fixture = await claimedTurn();
    expect((await cancelTurn(fixture, () => undefined)).action).toBe("settled");

    const timings: SessionTurnSettlementTiming[] = [];
    const stale = await cancelTurn(fixture, (timing) => timings.push(timing));
    expect(stale.action).toBe("stale");
    expect(timings).toHaveLength(1);
    expect(timings[0]).toMatchObject({ action: "stale", attempts: 1, writeMs: null });
    expect(timings[0]!.totalMs).toBeLessThan(1_000);
  }, 60_000);

  test("a throwing observer never changes the settlement", async () => {
    const fixture = await claimedTurn();
    const settled = await cancelTurn(fixture, () => {
      throw new Error("observer failure");
    });
    expect(settled.action).toBe("settled");
  }, 60_000);

  test("a rejecting async observer never changes the settlement or escapes", async () => {
    const fixture = await claimedTurn();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const settled = await cancelTurn(fixture, async () => {
        throw new Error("async observer failure");
      });
      expect(settled.action).toBe("settled");
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  }, 60_000);
});
