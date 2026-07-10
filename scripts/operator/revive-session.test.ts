import { describe, expect, test } from "bun:test";
import type { Session, SessionEvent, SessionStatus, SessionTurn } from "@opengeni/contracts";
import {
  deterministicOperatorClientEventId,
  runOperatorSessionRevival,
  validateOperatorSessionRevivalInput,
  type OperatorSessionRevivalDependencies,
  type OperatorSessionRevivalInput,
} from "./revive-session";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionId = "22222222-2222-4222-8222-222222222222";
const accountId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const turnId = "55555555-5555-4555-8555-555555555555";
const clientEventId = deterministicOperatorClientEventId(workspaceId, sessionId, "ope-22-revive-1");
const message = "Resume the failed session from its durable conversation history.";
const model = "codex/gpt-5.6-sol";
const reasoningEffort = "xhigh";

describe("operator session revival", () => {
  test("dry-run preflights but never invokes the write/core port", async () => {
    const harness = dependencies({ session: session("failed") });

    const result = await runOperatorSessionRevival(harness.deps, dryRunInput());

    expect(result).toMatchObject({
      mode: "dry_run",
      status: "ready",
      workspaceId,
      sessionId,
      clientEventId,
      sessionStatus: "failed",
      pendingTurns: [],
    });
    expect(harness.accepted).toHaveLength(0);
  });

  test("a duplicate client event is refused with its stable event ID and no write", async () => {
    const existingEvent = userMessageEvent();
    const existingTurn = turn("queued");
    const harness = dependencies({
      session: session("queued"),
      pendingTurns: [existingTurn],
      existingEvent,
    });

    const result = await runOperatorSessionRevival(harness.deps, applyInput());

    expect(result).toMatchObject({
      status: "refused",
      refusal: "duplicate_client_event",
      eventId,
    });
    expect(harness.accepted).toHaveLength(0);
  });

  test("refuses a missing or mismatched workspace/session target", async () => {
    const missing = dependencies({ session: null });
    expect(await runOperatorSessionRevival(missing.deps, dryRunInput())).toMatchObject({
      status: "refused",
      refusal: "session_not_found_in_workspace",
    });

    const mismatched = dependencies({
      session: { ...session("failed"), workspaceId: otherWorkspaceId },
    });
    expect(await runOperatorSessionRevival(mismatched.deps, dryRunInput())).toMatchObject({
      status: "refused",
      refusal: "scope_mismatch",
    });
    expect(missing.accepted).toHaveLength(0);
    expect(mismatched.accepted).toHaveLength(0);
  });

  for (const status of ["queued", "running", "requires_action"] as const) {
    test(`refuses ${status} work unless append is explicitly selected`, async () => {
      const pendingTurn = turn(status);
      const harness = dependencies({
        session: session(status),
        pendingTurns: [pendingTurn],
      });

      const refused = await runOperatorSessionRevival(harness.deps, applyInput());
      expect(refused).toMatchObject({ status: "refused", refusal: "conflicting_work" });
      expect(harness.accepted).toHaveLength(0);

      const accepted = await runOperatorSessionRevival(harness.deps, {
        ...applyInput(),
        queuePolicy: "append",
      });
      expect(accepted).toMatchObject({ status: "accepted", eventId, turnId });
      expect(harness.accepted).toHaveLength(1);
      expect(harness.accepted[0]?.queuePolicy).toBe("append");
    });
  }

  for (const status of ["failed", "idle"] as const) {
    test(`${status} revival delegates to shared admission with the exact synthetic grant`, async () => {
      const harness = dependencies({ session: session(status) });

      const result = await runOperatorSessionRevival(harness.deps, applyInput());

      expect(result).toMatchObject({
        mode: "apply",
        status: "accepted",
        sessionStatus: status,
        eventId,
        turnId,
      });
      expect(harness.accepted).toHaveLength(1);
      expect(harness.accepted[0]).toMatchObject({
        workspaceId,
        sessionId,
        text: message,
        model,
        reasoningEffort,
        clientEventId,
        queuePolicy: "reject_conflicts",
        grant: {
          workspaceId,
          accountId,
          subjectId: "operator:session-revival",
          permissions: ["workspace:admin"],
        },
      });
      expect(harness.accepted[0]?.grant.permissions).toEqual(["workspace:admin"]);
    });
  }

  test("an apply-time busy race is reported as a refusal instead of appending", async () => {
    let pendingReads = 0;
    const harness = dependencies({ session: session("idle") });
    harness.deps.listPendingTurns = async () => {
      pendingReads += 1;
      return pendingReads === 1 ? [] : [turn("running")];
    };
    harness.deps.acceptUserMessage = async () => {
      throw Object.assign(new Error("redacted"), { status: 409 });
    };

    const result = await runOperatorSessionRevival(harness.deps, applyInput());

    expect(result).toMatchObject({
      status: "refused",
      refusal: "conflicting_work",
      pendingTurns: [{ turnId, status: "running" }],
    });
  });

  test("a concurrent identical apply returns the winner event instead of conflicting work", async () => {
    let currentSession = session("idle");
    let currentEvent: SessionEvent | null = null;
    let currentTurns: SessionTurn[] = [];
    let acceptCalls = 0;
    let durableWrites = 0;
    let eventReads = 0;
    const secondAcceptEntered = deferred<void>();
    const winnerCommitted = deferred<void>();
    const deps: OperatorSessionRevivalDependencies = {
      getSession: async () => currentSession,
      getEventByClientEventId: async () => {
        eventReads += 1;
        return currentEvent;
      },
      listPendingTurns: async () => currentTurns,
      acceptUserMessage: async () => {
        acceptCalls += 1;
        if (acceptCalls === 1) {
          await secondAcceptEntered.promise;
          durableWrites += 1;
          currentEvent = userMessageEvent();
          currentTurns = [turn("queued")];
          currentSession = session("queued");
          winnerCommitted.resolve();
          return { accepted: currentEvent, turn: currentTurns[0] as SessionTurn };
        }
        secondAcceptEntered.resolve();
        await winnerCommitted.promise;
        throw Object.assign(new Error("redacted"), { status: 409 });
      },
    };

    const results = await Promise.all([
      runOperatorSessionRevival(deps, applyInput()),
      runOperatorSessionRevival(deps, applyInput()),
    ]);

    expect(results).toContainEqual(
      expect.objectContaining({ status: "accepted", eventId, turnId }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        status: "refused",
        refusal: "duplicate_client_event",
        eventId,
      }),
    );
    expect(results).not.toContainEqual(expect.objectContaining({ refusal: "conflicting_work" }));
    expect(acceptCalls).toBe(2);
    expect(durableWrites).toBe(1);
    expect(eventReads).toBe(3);
    expect(currentTurns).toHaveLength(1);
  });

  test("apply requires an explicit model and reasoning effort", () => {
    const { model: _model, ...withoutModel } = applyInput();
    expect(() => validateOperatorSessionRevivalInput(withoutModel)).toThrow();
    const { reasoningEffort: _reasoningEffort, ...withoutReasoningEffort } = applyInput();
    expect(() => validateOperatorSessionRevivalInput(withoutReasoningEffort)).toThrow();
  });

  test("requires a deterministic client event ID bound to the exact target", () => {
    expect(() =>
      validateOperatorSessionRevivalInput({
        ...dryRunInput(),
        clientEventId: "operator-revival:wrong-target",
      }),
    ).toThrow();
    expect(clientEventId).toBe(`operator-revival:${workspaceId}:${sessionId}:ope-22-revive-1`);
  });

  test("never emits an accepted result returned outside the requested scope", async () => {
    const harness = dependencies({ session: session("failed") });
    harness.deps.acceptUserMessage = async () => ({
      accepted: { ...userMessageEvent(), workspaceId: otherWorkspaceId },
      turn: turn("queued"),
    });

    await expect(runOperatorSessionRevival(harness.deps, applyInput())).rejects.toThrow();
  });
});

function dryRunInput(): OperatorSessionRevivalInput {
  return {
    workspaceId,
    sessionId,
    clientEventId,
    apply: false,
  };
}

function applyInput(): OperatorSessionRevivalInput {
  return {
    workspaceId,
    sessionId,
    clientEventId,
    apply: true,
    message,
    model,
    reasoningEffort,
  };
}

function dependencies(options: {
  session: Session | null;
  pendingTurns?: SessionTurn[];
  existingEvent?: SessionEvent | null;
}): {
  deps: OperatorSessionRevivalDependencies;
  accepted: Parameters<OperatorSessionRevivalDependencies["acceptUserMessage"]>[0][];
} {
  const accepted: Parameters<OperatorSessionRevivalDependencies["acceptUserMessage"]>[0][] = [];
  return {
    accepted,
    deps: {
      getSession: async () => options.session,
      getEventByClientEventId: async () => options.existingEvent ?? null,
      listPendingTurns: async () => options.pendingTurns ?? [],
      acceptUserMessage: async (input) => {
        accepted.push(input);
        return { accepted: userMessageEvent(), turn: turn("queued") };
      },
    },
  };
}

function session(status: SessionStatus): Session {
  return {
    id: sessionId,
    workspaceId,
    accountId,
    status,
    initialMessage: "initial",
    title: null,
    titleSource: null,
    instructions: null,
    resources: [],
    tools: [],
    metadata: {},
    model,
    sandboxBackend: "modal",
    sandboxOs: "linux",
    sandboxGroupId: sessionId,
    activeSandboxId: null,
    activeEpoch: 0,
    variableSetId: null,
    environmentId: null,
    rigId: null,
    rigVersionId: null,
    firstPartyMcpPermissions: null,
    mcpServers: [],
    parentSessionId: null,
    createIdempotencyKey: null,
    temporalWorkflowId: `session-${sessionId}`,
    activeTurnId: status === "running" || status === "requires_action" ? turnId : null,
    lastInputTokens: null,
    lastSequence: 1,
    codexPinnedCredentialId: null,
    codexLastCredentialId: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function turn(status: SessionTurn["status"]): SessionTurn {
  return {
    id: turnId,
    workspaceId,
    sessionId,
    triggerEventId: eventId,
    temporalWorkflowId: `session-${sessionId}`,
    status,
    source: "user",
    position: 1,
    prompt: message,
    resources: [],
    tools: [],
    model,
    reasoningEffort,
    sandboxBackend: "modal",
    sandboxOs: "linux",
    metadata: {},
    startedAt: status === "queued" ? null : "2026-07-10T00:00:01.000Z",
    finishedAt: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

function userMessageEvent(): SessionEvent {
  return {
    id: eventId,
    workspaceId,
    sessionId,
    sequence: 1,
    type: "user.message",
    payload: { text: message, model, reasoningEffort },
    occurredAt: "2026-07-10T00:00:00.000Z",
    clientEventId,
    turnId: null,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}
