import { describe, expect, mock, test } from "bun:test";
import { createSessionStateActivities } from "../src/activities/session-state";

const publishedEvents: unknown[] = [];
const recoveryCalls: unknown[] = [];
const parentWakeCalls: unknown[] = [];
let turn: {
  id: string;
  triggerEventId: string;
  executionGeneration: number;
} | null;
let recoveryResult:
  | { action: "recovering"; events: unknown[] }
  | { action: "stale"; events: []; turnStatus: string | null; activeTurnId: string | null };

function makeActivities() {
  return createSessionStateActivities(
    async () =>
      ({
        db: {},
        bus: { publish: async () => undefined },
        settings: {},
        observability: {},
        wakeSessionWorkflow: null,
      }) as any,
    {
      getSessionTurnForAttempt: mock(async () => turn as any),
      requestSessionTurnRecovery: mock(async (...args: unknown[]) => {
        recoveryCalls.push(args[2]);
        return recoveryResult as any;
      }),
      publishDurableSessionEvents: mock(
        async (_bus, _workspaceId, _sessionId, events: unknown[]) => {
          publishedEvents.push(...events);
        },
      ),
      deliverFailedChildTurnToParent: mock(async (...args: unknown[]) => {
        parentWakeCalls.push(args);
      }),
      recordTurnsQueuedGauge: mock(() => undefined),
    },
  );
}

const input = {
  accountId: "account-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  attemptId: "attempt-2",
  turnId: "turn-1",
  triggerEventId: "trigger-1",
  executionGeneration: 2,
};

describe("recoverEscapedMcpTimeout", () => {
  test("keeps the exact generation-2 turn recovering without a child terminal callback", async () => {
    publishedEvents.length = 0;
    recoveryCalls.length = 0;
    parentWakeCalls.length = 0;
    turn = {
      id: input.turnId,
      triggerEventId: input.triggerEventId,
      executionGeneration: input.executionGeneration,
    };
    recoveryResult = {
      action: "recovering",
      events: [{ id: "recovery-2", type: "turn.recovery.requested" }],
    };

    expect(await makeActivities().recoverEscapedMcpTimeout(input)).toEqual({
      action: "recovering",
    });
    expect(recoveryCalls).toEqual([
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        triggerEventId: input.triggerEventId,
        attemptId: input.attemptId,
        reason: "mcp_transport_timeout",
        detail: {
          code: "mcp_transport_timeout",
          retryable: true,
          continueDelayMs: 60_000,
          recoverySource: "workflow_activity_failure",
        },
        fromStatuses: ["running"],
      },
    ]);
    expect(publishedEvents).toEqual([{ id: "recovery-2", type: "turn.recovery.requested" }]);
    expect(parentWakeCalls).toHaveLength(0);
  });

  test("rejects generation 1 or mismatched immutable identity without mutation", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    turn = {
      id: input.turnId,
      triggerEventId: input.triggerEventId,
      executionGeneration: 1,
    };
    expect(
      await makeActivities().recoverEscapedMcpTimeout({
        ...input,
        executionGeneration: 1,
      }),
    ).toEqual({ action: "ineligible" });

    turn = {
      id: input.turnId,
      triggerEventId: "different-trigger",
      executionGeneration: input.executionGeneration,
    };
    expect(await makeActivities().recoverEscapedMcpTimeout(input)).toEqual({
      action: "ineligible",
    });
    expect(recoveryCalls).toHaveLength(0);
    expect(publishedEvents).toHaveLength(0);
  });

  test("treats a checkpoint already committed by the turn activity as stale and side-effect free", async () => {
    recoveryCalls.length = 0;
    publishedEvents.length = 0;
    parentWakeCalls.length = 0;
    turn = null;
    expect(await makeActivities().recoverEscapedMcpTimeout(input)).toEqual({ action: "stale" });
    expect(recoveryCalls).toHaveLength(0);
    expect(publishedEvents).toHaveLength(0);
    expect(parentWakeCalls).toHaveLength(0);
  });
});
