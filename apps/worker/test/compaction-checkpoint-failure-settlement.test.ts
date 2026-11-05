import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import * as database from "@opengeni/db";
import { GitHubRestAuthorityError } from "@opengeni/runtime/github-rest-mcp";
import * as parentWake from "../src/activities/parent-wake";
import { settleTurnFailure } from "../src/activities/agent-turn/failure-settlement";

// The idle compaction checkpoint after a person's turn failed while preparing
// its tools ("Personal GitHub delegation is unavailable"). The generic failure
// path marked the whole session failed and left the request pending, so it was
// claimed and failed a second time.

const COMPACTION_TRIGGER = "session.context.compaction.requested";

function failureDeps(error: unknown, triggerType: string) {
  const settle = mock(async (_input: unknown) => true);
  const control = {
    cancellationRequestedAt: null,
    activityStatus: "unknown",
    turnMetricOutcome: null as string | null,
    activityError: null as unknown,
    acknowledgeQuiescence: false,
  };
  const deps = {
    error,
    input: {
      accountId: "account-1",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      attemptId: "attempt-1",
      workflowId: "session-session-1",
    },
    settings: {},
    db: {},
    bus: {},
    observability: {
      incrementCounter: () => undefined,
      observeHistogram: () => undefined,
      warn: mock((_message: string, _attributes?: Record<string, unknown>) => undefined),
      error: () => undefined,
    },
    wakeSessionWorkflow: async () => undefined,
    cancellationSignal: undefined,
    sandboxRotationController: new AbortController(),
    noteCancellationRequested: () => undefined,
    codexWorkspaceKey: "workspace-key",
    control,
    attempt: {
      turnId: "turn-1",
      dispatchId: "dispatch-1",
      triggerEventId: "trigger-1",
      executionGeneration: 1,
      providerRecoveryCount: 0,
      modelRequestStarted: false,
      redispatchesAtDispatch: 0,
      triggerType,
    },
    billingState: { isCodexTurn: false, isXaiTurn: false, isClaudeTurn: false },
    eventing: { publish: async () => [], turnStartedPublished: true, settle },
    providerTurn: {
      effectiveCodexCredentialId: null,
      codexCredentialFailoverLimit: 0,
      latestCodexUsage: null,
    },
    leases: {
      codex: { lost: false, held: false },
      xai: { lost: false },
      claude: { lost: false },
    },
    historySink: { reconcileConversationTruth: async () => undefined },
    claimedResult: (value: Record<string, unknown>) => ({
      ...value,
      turnId: "turn-1",
      attemptId: "attempt-1",
    }),
    flushRuntimeBatcher: async () => undefined,
    acknowledgeLostAttemptOwnership: () => undefined,
    acknowledgeRecoveryQuiescence: () => undefined,
  };
  return { deps, control, settle };
}

type Settlement = {
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  turnStatus: string;
  sessionStatus: string;
  activeTurnId: string | null;
  consumeRequestedCompactionFailure?: boolean;
};

function delegationUnavailable(): GitHubRestAuthorityError {
  return new GitHubRestAuthorityError("Personal GitHub delegation is unavailable");
}

/** A lost database connection, with the driver provenance recovery requires. */
function databaseConnectionLost(): Error {
  return new DrizzleQueryError(
    "select compact_requested from sessions where id = $1",
    ["session-1"],
    Object.assign(new Error("connection lost"), { name: "PostgresError", code: "40P01" }),
  );
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

function stubDependencies(requestPending: boolean | Error) {
  const deliver = spyOn(parentWake, "deliverFailedChildTurnToParent").mockResolvedValue(
    undefined as never,
  );
  const pending = spyOn(database, "isSessionCompactionRequested").mockImplementation(async () => {
    if (requestPending instanceof Error) throw requestPending;
    return requestPending;
  });
  restores.push(
    () => deliver.mockRestore(),
    () => pending.mockRestore(),
  );
  return { deliver, pending };
}

describe("a compaction checkpoint that fails", () => {
  test("settles as a failed compaction, keeps the session usable and consumes the request", async () => {
    const { deliver, pending } = stubDependencies(true);
    const { deps, control, settle } = failureDeps(delegationUnavailable(), COMPACTION_TRIGGER);

    const result = await settleTurnFailure(deps as never);

    expect(result).toMatchObject({ status: "idle", turnId: "turn-1" });
    expect(pending).toHaveBeenCalledWith(deps.db as never, "workspace-1", "session-1");
    expect(settle).toHaveBeenCalledTimes(1);
    const settlement = settle.mock.calls[0]![0] as Settlement;
    expect(settlement).toMatchObject({
      turnStatus: "failed",
      sessionStatus: "idle",
      activeTurnId: null,
      consumeRequestedCompactionFailure: true,
    });
    expect(settlement.events.map((event) => event.type)).toEqual([
      "turn.failed",
      "session.status.changed",
    ]);
    expect(settlement.events[0]!.payload).toMatchObject({
      code: "context_compaction_failed",
      retryable: false,
      recovery: "user_message",
      compacted: false,
    });
    // The internal authority message is not the recorded reason.
    expect(String(settlement.events[0]!.payload.error)).not.toContain("delegation");
    expect(settlement.events[1]!.payload).toEqual({ status: "idle" });
    expect(control.activityStatus).toBe("idle");
    expect(control.turnMetricOutcome).toBe("failed");
    // Not delivered to a parent right away; the settlement's own failed-child
    // notice still reaches it through the reconciler.
    expect(deliver).not.toHaveBeenCalled();
    // The classification goes to telemetry, without the error message.
    const warn = deps.observability.warn;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({
      sessionId: "session-1",
      errorName: "GitHubRestAuthorityError",
    });
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain("delegation");
  });

  test("leaves an already consumed request alone", async () => {
    stubDependencies(false);
    const { deps, settle } = failureDeps(delegationUnavailable(), COMPACTION_TRIGGER);

    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "idle" });
    const settlement = settle.mock.calls[0]![0] as Settlement;
    expect(settlement.sessionStatus).toBe("idle");
    expect(settlement).not.toHaveProperty("consumeRequestedCompactionFailure");
  });

  test("an unreadable request goes to database recovery, not idle where it would be claimed again", async () => {
    stubDependencies(databaseConnectionLost());
    const { deps, control, settle } = failureDeps(delegationUnavailable(), COMPACTION_TRIGGER);

    await expect(settleTurnFailure(deps as never)).rejects.toMatchObject({
      type: "OpenGeniPostClaimDatabaseRecovery",
    });
    expect(settle).not.toHaveBeenCalled();
    expect(control.activityStatus).toBe("recovering");
  });

  test("a recoverable error still recovers before the checkpoint is settled", async () => {
    const { pending } = stubDependencies(true);
    const { deps, control, settle } = failureDeps(databaseConnectionLost(), COMPACTION_TRIGGER);

    await expect(settleTurnFailure(deps as never)).rejects.toMatchObject({
      type: "OpenGeniPostClaimDatabaseRecovery",
    });
    expect(settle).not.toHaveBeenCalled();
    expect(pending).not.toHaveBeenCalled();
    expect(control.activityStatus).toBe("recovering");
  });

  test("a superseded settlement stays cancelled", async () => {
    stubDependencies(true);
    const { deps, settle } = failureDeps(delegationUnavailable(), COMPACTION_TRIGGER);
    settle.mockImplementation(async () => false);

    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "cancelled" });
  });

  test("an ordinary turn with the same error still fails the session", async () => {
    const { deliver, pending } = stubDependencies(true);
    const { deps, settle } = failureDeps(delegationUnavailable(), "user.message");

    expect(await settleTurnFailure(deps as never)).toMatchObject({ status: "failed" });
    const settlement = settle.mock.calls[0]![0] as Settlement;
    expect(settlement.sessionStatus).toBe("failed");
    expect(settlement).not.toHaveProperty("consumeRequestedCompactionFailure");
    expect(pending).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});
