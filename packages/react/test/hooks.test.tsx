/* ----------------------------------------------------------------------------
   Rendered-hook tests for the workspace + queue + goal hooks, on the minimal
   happy-dom harness in ./render-hook. All hook tests live in this one file so
   DOM globals are registered exactly once for the bun test process slice that
   needs them and restored afterwards.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { act as reactAct } from "react";
import { startTransition, Suspense, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type {
  ComposerDraft,
  SendMessageInput,
  SessionCommandReceipt,
  SessionEvent,
  SessionControlResponse,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionListResponse,
  SessionMcpApprovalPolicy,
  SessionMcpServerMetadata,
  SessionTurn,
  SteerMessageResult,
  WorkspaceEnvironment,
} from "@opengeni/sdk";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, fakeGoal, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import type { EmbeddedSessionMcpApprovalPolicyClientLike } from "../src/client";
import { OpenGeniApiError, OpenGeniClient } from "@opengeni/sdk";
import { useAvailableModels } from "../src/hooks/use-available-models";
import { useBillingUsage } from "../src/hooks/use-billing-usage";
import { FILE_ONLY_MESSAGE_TEXT, useComposer } from "../src/hooks/use-composer";
import { useEnvironments } from "../src/hooks/use-environments";
import { useGoal } from "../src/hooks/use-goal";
import { usePacks } from "../src/hooks/use-packs";
import { useWorkspaceSessions } from "../src/hooks/use-workspace-sessions";
import { useSessionControl } from "../src/hooks/use-session-control";
import { useSessionLineage } from "../src/hooks/use-session-lineage";
import { useSessionMcpApprovalPolicy } from "../src/hooks/use-session-mcp-approval-policy";
import { useTurnQueue } from "../src/hooks/use-turn-queue";
import { useWorkspaces } from "../src/hooks/use-workspaces";
import { createEmbeddedSessionClient } from "../src/embedded-session-client";

registerDom();

function makeEvent(
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date().toISOString(),
  };
}

function promptReceipt(turnId: string | null, action = "prompt.submit"): SessionCommandReceipt {
  return {
    id: crypto.randomUUID(),
    action,
    operationKey: crypto.randomUUID(),
    targetSessionId: SESSION_ID,
    targetTurnId: turnId,
    appliedControlRevision: null,
    appliedQueueVersion: 2,
    appliedTurnVersion: 1,
    appliedDraftRevision: null,
    createdAt: new Date().toISOString(),
  };
}

function steerResult(
  accepted: SessionEvent = makeEvent(1, "user.message"),
  turn: SessionTurn = fakeTurn(),
  overrides: Partial<SteerMessageResult> = {},
): SteerMessageResult {
  return {
    accepted,
    turn,
    receipt: promptReceipt(turn.id),
    routing: "accepted_for_steering",
    interruptionCount: 0,
    replay: false,
    ...overrides,
  };
}

const noEvents: SessionEvent[] = [];
const INITIAL_COMPOSER_POLICY = {
  model: "scripted-model",
  reasoningEffort: "medium" as const,
  latencyMode: "standard" as const,
};

function gatewayError(status = 502): OpenGeniApiError {
  return new OpenGeniApiError(status, "", {
    code: "upstream_unavailable",
    retryable: true,
    correlationId: `edge-${status}-safe`,
    outcomeUnknown: true,
    displayMessage: "OpenGeni is temporarily unavailable — retry.",
  });
}

function paymentRequiredError(): OpenGeniApiError {
  return new OpenGeniApiError(
    402,
    JSON.stringify({
      error: {
        status: 402,
        code: "payment_required",
        message: "insufficient OpenGeni credits",
        retryable: false,
      },
    }),
    { mutation: true },
  );
}

function personalAttachmentConflict(): OpenGeniApiError {
  return new OpenGeniApiError(
    409,
    JSON.stringify({
      error: {
        message: "The personal-resource attachment conflicts with accepted work",
        retryable: true,
      },
    }),
    { mutation: true },
  );
}

function queueSnapshot(
  items: SessionTurn[],
  overrides: Partial<SessionQueueSnapshot> = {},
): SessionQueueSnapshot {
  return {
    version: 1,
    effectiveControl: {
      state: "active",
      controlVersion: 3,
      controlEtag: "control-3",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    stoppingPreviousAttempt: false,
    items,
    pendingInputs: [],
    pendingInputAttachment: null,
    ...overrides,
    activePersonalConnections: overrides.activePersonalConnections ?? [],
  };
}

describe("useWorkspaceSessions", () => {
  test("forwards pins-only mode without changing the historical visible-row projection", async () => {
    const pinned = { id: "pin-only", pinned: true } as never;
    let observedPinsOnly = false;
    const client = fakeClient({
      listSessionPage: async (_workspaceId, options) => {
        observedPinsOnly = options?.pinsOnly === true;
        return { pinned: [pinned], sessions: [], nextCursor: null };
      },
    });
    const hook = await renderHook(
      () =>
        useWorkspaceSessions({
          client,
          workspaceId: WORKSPACE_ID,
          pinsOnly: true,
        }),
      undefined,
    );
    await flush();

    expect(observedPinsOnly).toBe(true);
    expect(hook.result.current.sessions).toEqual([pinned]);
    expect(hook.result.current.pinned).toEqual([pinned]);
    await hook.unmount();
  });

  test("keeps pinned rows in the historical sessions result while exposing the section", async () => {
    const pinned = { id: "pinned", pinned: true } as never;
    const ordinary = { id: "ordinary", pinned: false } as never;
    const client = fakeClient({
      listSessionPage: async () => ({
        pinned: [pinned],
        pinnedTruncated: true,
        sessions: [ordinary],
        nextCursor: "next-page",
      }),
    });
    const hook = await renderHook(
      () => useWorkspaceSessions({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();

    expect(hook.result.current.sessions.map((session) => session.id)).toEqual([
      "pinned",
      "ordinary",
    ]);
    expect(hook.result.current.readRevision).toBe(1);
    expect(hook.result.current.pinned.map((session) => session.id)).toEqual(["pinned"]);
    expect(hook.result.current.pinnedTruncated).toBe(true);
    expect(hook.result.current.nextCursor).toBe("next-page");
    await hook.unmount();
  });

  test("treats the query-key transition render as loading", async () => {
    const initial = { id: "initial", pinned: false } as never;
    const searched = { id: "searched", pinned: false } as never;
    let resolveSearch: (() => void) | null = null;
    const client = fakeClient({
      listSessionPage: async (_workspaceId, options) => {
        if (options?.search === "needle") {
          return await new Promise<SessionListResponse>((resolve) => {
            resolveSearch = () =>
              resolve({
                pinned: [],
                sessions: [searched],
                nextCursor: null,
              } as SessionListResponse);
          });
        }
        return { pinned: [], sessions: [initial], nextCursor: null };
      },
    });
    const hook = await renderHook(
      (search: string) => useWorkspaceSessions({ client, workspaceId: WORKSPACE_ID, search }),
      "" as string,
    );
    await flush();
    expect(hook.result.current.sessions.map((session) => session.id)).toEqual(["initial"]);

    await hook.rerender("needle");
    await flush();
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.sessions).toEqual([]);

    await reactAct(async () => {
      resolveSearch!();
    });
    await flush();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.sessions.map((session) => session.id)).toEqual(["searched"]);
    await hook.unmount();
  });

  test("keeps the last successful page visible when a poll fails", async () => {
    const stable = { id: "stable", pinned: false } as never;
    let calls = 0;
    const client = fakeClient({
      listSessionPage: async () => {
        calls += 1;
        if (calls > 1) throw new Error("poll unavailable");
        return { pinned: [], sessions: [stable], nextCursor: null };
      },
    });
    const hook = await renderHook(
      () => useWorkspaceSessions({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.loading).toBe(false);
    await reactAct(async () => {
      await hook.result.current.refresh();
    });
    await flush();
    expect(hook.result.current.sessions.map((session) => session.id)).toEqual(["stable"]);
    expect(hook.result.current.readRevision).toBe(1);
    expect(hook.result.current.error?.message).toBe("poll unavailable");
    expect(hook.result.current.loading).toBe(false);
    await hook.unmount();
  });

  test("increments the authoritative list revision only after successful reads", async () => {
    let calls = 0;
    const client = fakeClient({
      listSessionPage: async () => {
        calls += 1;
        return {
          pinned: [],
          sessions: [{ id: `session-${calls}` } as never],
          nextCursor: null,
        };
      },
    });
    const hook = await renderHook(
      () => useWorkspaceSessions({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.readRevision).toBe(1);

    await reactAct(async () => {
      await hook.result.current.refresh();
    });
    await flush();
    expect(hook.result.current.readRevision).toBe(2);
    expect(hook.result.current.sessions.map((session) => session.id)).toEqual(["session-2"]);
    await hook.unmount();
  });

  test("captures a shared causal generation when each list request starts", async () => {
    let releaseInitial: (() => void) | null = null;
    let nextGeneration = 40;
    const started: number[] = [];
    const beginRead = () => {
      const generation = ++nextGeneration;
      started.push(generation);
      return generation;
    };
    const client = fakeClient({
      listSessionPage: async () => {
        if (started.length === 1) {
          await new Promise<void>((resolve) => {
            releaseInitial = resolve;
          });
        }
        return {
          pinned: [],
          sessions: [{ id: `session-${started.length}` } as never],
          nextCursor: null,
        };
      },
    });
    const hook = await renderHook(
      () => useWorkspaceSessions({ client, workspaceId: WORKSPACE_ID, beginRead }),
      undefined,
    );
    await flush();

    expect(started).toEqual([41]);
    expect(hook.result.current.readGeneration).toBe(0);
    await reactAct(async () => releaseInitial!());
    await flush();
    expect(hook.result.current.readGeneration).toBe(41);

    await reactAct(async () => {
      await hook.result.current.refresh();
    });
    await flush();
    expect(started).toEqual([41, 42]);
    expect(hook.result.current.readGeneration).toBe(42);
    await hook.unmount();
  });

  test("does not report a query transition as loading while disabled", async () => {
    const client = fakeClient({
      listSessionPage: async () => ({
        pinned: [],
        sessions: [],
        nextCursor: null,
      }),
    });
    const hook = await renderHook(
      (search: string) =>
        useWorkspaceSessions({
          client,
          workspaceId: WORKSPACE_ID,
          search,
          enabled: false,
        }),
      "" as string,
    );
    await flush();
    expect(hook.result.current.loading).toBe(false);

    await hook.rerender("disabled-transition");
    expect(hook.result.current.loading).toBe(false);
    await hook.unmount();
  });
});

describe("useTurnQueue", () => {
  test("renders the authoritative server queue verbatim", async () => {
    const turns = [fakeTurn({ id: "second", position: 2 }), fakeTurn({ id: "first", position: 1 })];
    const client = fakeClient({ getQueue: async () => queueSnapshot(turns) });
    const hook = await renderHook(
      () =>
        useTurnQueue(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["second", "first"]);
    expect(hook.result.current.effectiveControl?.controlVersion).toBe(3);
    await hook.unmount();
  });

  test("a failed mutation rolls back by refetching and surfaces mutationError", async () => {
    const queued = fakeTurn({ id: "victim", prompt: "original" });
    let listCalls = 0;
    const client = fakeClient({
      getQueue: async () => {
        listCalls += 1;
        return queueSnapshot([queued]);
      },
      deleteQueueItem: async () => {
        throw new OpenGeniApiError(409, "turn already claimed");
      },
    });
    const hook = await renderHook(
      () =>
        useTurnQueue(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    expect(listCalls).toBe(1);
    await flushing(async () => {
      const removed = await hook.result.current.removeTurn("victim");
      expect(removed).toBe(false);
    });
    await flush();
    // The authoritative snapshot remains unchanged after the failed delete.
    expect(listCalls).toBe(2);
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["victim"]);
    expect(hook.result.current.mutationError?.message).toContain("409");
    await hook.unmount();
  });

  test("a steer race that already advanced the prompt reconciles as success", async () => {
    const queued = fakeTurn({ id: "steer-race", prompt: "already advancing" });
    let reads = 0;
    const client = fakeClient({
      getQueue: async () => {
        reads += 1;
        return queueSnapshot(reads === 1 ? [queued] : [], { version: reads });
      },
      steerQueueItem: async () => {
        throw new OpenGeniApiError(409, "turn already claimed");
      },
    });
    const hook = await renderHook(
      () =>
        useTurnQueue(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();

    await flushing(async () => {
      expect(await hook.result.current.steerTurn(queued.id)).toBe(true);
    });

    expect(reads).toBe(2);
    expect(hook.result.current.queue).toEqual([]);
    expect(hook.result.current.acceptedSteers).toEqual([]);
    expect(hook.result.current.mutationError).toBeNull();
    await hook.unmount();
  });

  test("replays an uncertain queue mutation once with the same command key", async () => {
    const queued = fakeTurn({ id: "victim", prompt: "remove me" });
    const keys: string[] = [];
    const client = fakeClient({
      getQueue: async () => queueSnapshot([queued]),
      deleteQueueItem: async (_workspaceId, _sessionId, _turnId, request) => {
        keys.push(request.clientEventId);
        if (keys.length === 1) throw gatewayError(504);
        return {
          receipt: {
            id: crypto.randomUUID(),
            action: "queue.delete",
            operationKey: request.clientEventId,
            targetSessionId: SESSION_ID,
            targetTurnId: queued.id,
            appliedControlRevision: null,
            appliedQueueVersion: 4,
            appliedTurnVersion: 2,
            appliedDraftRevision: null,
            createdAt: new Date().toISOString(),
          },
          snapshot: queueSnapshot([], { version: 4 }),
        };
      },
    });
    const hook = await renderHook(
      () =>
        useTurnQueue(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();

    await flushing(async () => expect(await hook.result.current.removeTurn("victim")).toBe(true));

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(hook.result.current.queue).toEqual([]);
    expect(hook.result.current.mutating).toBe(false);
    await hook.unmount();
  });

  test("turn.* events on a shared event log trigger a debounced refetch", async () => {
    let listCalls = 0;
    const client = fakeClient({
      getQueue: async () => {
        listCalls += 1;
        return queueSnapshot([fakeTurn({ id: `turn-${listCalls}` })]);
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    expect(listCalls).toBe(1);
    // Unrelated events do not refetch.
    await hook.rerender([makeEvent(1, "agent.message.delta")]);
    await flush(200);
    expect(listCalls).toBe(1);
    // A burst of turn events coalesces into one refetch.
    await hook.rerender([
      makeEvent(1, "agent.message.delta"),
      makeEvent(2, "turn.queued"),
      makeEvent(3, "turn.updated"),
    ]);
    await flush(250);
    expect(listCalls).toBe(2);
    expect(hook.result.current.queue[0]?.id).toBe("turn-2");
    await hook.unmount();
  });

  test("without a shared log it tails the session stream from lastSequence", async () => {
    let listCalls = 0;
    const streamedAfter: { value: number | null } = { value: null };
    let push: ((event: SessionEvent) => void) | null = null;
    const client = fakeClient({
      getQueue: async () => {
        listCalls += 1;
        return queueSnapshot([fakeTurn({ id: `turn-${listCalls}` })]);
      },
      getSession: async () => ({ lastSequence: 41 }) as never,
      streamEvents: (_ws, _session, options) => {
        streamedAfter.value = options?.after ?? null;
        return (async function* () {
          options?.onOpen?.();
          while (true) {
            const event = await new Promise<SessionEvent | null>((resolve) => {
              push = resolve;
              options?.signal?.addEventListener("abort", () => resolve(null), {
                once: true,
              });
            });
            if (!event) {
              return;
            }
            yield event;
          }
        })();
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    // The authoritative queue is loaded once for first paint, then once more
    // after the SSE connection opens. An update included in lastSequence but
    // missed by the first GET therefore cannot leave providerless hooks stale.
    expect(listCalls).toBe(2);
    expect(streamedAfter.value).toBe(41);
    expect(hook.result.current.queue[0]?.id).toBe("turn-2");
    await flushing(async () => {
      push!(makeEvent(42, "turn.queued"));
    });
    await flush(250);
    expect(listCalls).toBe(3);
    await hook.unmount();
  });

  test("a failed non-blocking queue handoff surfaces the error, then a live event recovers", async () => {
    let reads = 0;
    let push: ((event: SessionEvent) => void) | null = null;
    const client = fakeClient({
      getQueue: async () => {
        reads += 1;
        if (reads === 2) throw new TypeError("queue handoff unavailable");
        return queueSnapshot([fakeTurn({ id: reads === 1 ? "stale" : "recovered" })]);
      },
      getSession: async () => ({ lastSequence: 41 }) as never,
      streamEvents: (_workspaceId, _sessionId, options) =>
        (async function* () {
          options?.onOpen?.();
          const event = await new Promise<SessionEvent | null>((resolve) => {
            push = resolve;
            options?.signal?.addEventListener("abort", () => resolve(null), {
              once: true,
            });
          });
          if (event) yield event;
        })(),
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();

    expect(hook.result.current.queue[0]?.id).toBe("stale");
    expect(hook.result.current.error?.message).toContain("queue handoff unavailable");

    await flushing(async () => {
      push!(makeEvent(42, "turn.queued"));
    });
    await flush(250);
    expect(reads).toBe(3);
    expect(hook.result.current.queue[0]?.id).toBe("recovered");
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("the queue handoff commits before a superseding ordinary read can fail", async () => {
    let reads = 0;
    let resolveHandoffRead: ((snapshot: SessionQueueSnapshot) => void) | null = null;
    let rejectSupersedingRead: ((cause: Error) => void) | null = null;
    let markHandoffComplete: (() => void) | null = null;
    const handoffRead = new Promise<SessionQueueSnapshot>((resolve) => {
      resolveHandoffRead = resolve;
    });
    const supersedingRead = new Promise<SessionQueueSnapshot>((_resolve, reject) => {
      rejectSupersedingRead = reject;
    });
    const handoffComplete = new Promise<void>((resolve) => {
      markHandoffComplete = resolve;
    });
    const client = fakeClient({
      getQueue: async () => {
        reads += 1;
        if (reads === 1) return queueSnapshot([fakeTurn({ id: "stale" })], { version: 1 });
        if (reads === 2) {
          const value = await handoffRead;
          markHandoffComplete?.();
          return value;
        }
        return await supersedingRead;
      },
      getSession: async () => ({ lastSequence: 41 }) as never,
      streamEvents: (_workspaceId, _sessionId, options) =>
        (async function* () {
          options?.onOpen?.();
          const event = await new Promise<SessionEvent | null>((resolve) => {
            options?.signal?.addEventListener("abort", () => resolve(null), {
              once: true,
            });
          });
          if (event) yield event;
        })(),
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(reads).toBe(2);
    expect(hook.result.current.queue[0]?.id).toBe("stale");

    let laterRefresh: Promise<void> | null = null;
    await flushing(() => {
      laterRefresh = hook.result.current.refresh();
    });
    expect(reads).toBe(3);

    await flushing(async () => {
      resolveHandoffRead?.(
        queueSnapshot([fakeTurn({ id: "handoff" })], {
          version: 2,
          effectiveControl: {
            ...queueSnapshot([]).effectiveControl,
            controlVersion: 4,
          },
        }),
      );
      await handoffComplete;
    });
    expect(hook.result.current.queue[0]?.id).toBe("handoff");
    expect(hook.result.current.snapshot?.version).toBe(2);

    await flushing(async () => {
      rejectSupersedingRead?.(new TypeError("later ordinary read failed"));
      await laterRefresh;
    });
    expect(hook.result.current.error?.message).toContain("later ordinary read failed");
    expect(hook.result.current.queue[0]?.id).toBe("handoff");
    expect(hook.result.current.snapshot?.version).toBe(2);
    await hook.unmount();
  });

  test("move, Edit, Steer, and Delete bind the displayed versions and accept server order", async () => {
    const first = fakeTurn({
      id: "11111111-aaaa-4aaa-8aaa-111111111111",
      version: 2,
    });
    const second = fakeTurn({
      id: "22222222-bbbb-4bbb-8bbb-222222222222",
      version: 4,
    });
    let current = queueSnapshot([first, second], { version: 5 });
    const calls: Array<{ action: string; request: unknown }> = [];
    const response = (items: SessionTurn[], version: number, draft?: ComposerDraft) => ({
      receipt: {
        id: crypto.randomUUID(),
        action: "queue.test",
        operationKey: crypto.randomUUID(),
        targetSessionId: SESSION_ID,
        targetTurnId: null,
        appliedControlRevision: null,
        appliedQueueVersion: version,
        appliedTurnVersion: null,
        appliedDraftRevision: null,
        createdAt: new Date().toISOString(),
      },
      snapshot: queueSnapshot(items, { version }),
      ...(draft ? { draft } : {}),
    });
    const client = fakeClient({
      getQueue: async () => current,
      moveQueueItem: async (_ws, _session, _turn, request) => {
        calls.push({ action: "move", request });
        current = queueSnapshot([second, first], { version: 6 });
        return response(current.items, 6);
      },
      editQueueItem: async (_ws, _session, _turn, request) => {
        calls.push({ action: "edit", request });
        const draft = {
          revision: 3,
          text: second.prompt,
          resources: [],
          tools: [],
          toolsProvided: false,
          model: second.model,
          reasoningEffort: second.reasoningEffort,
          latencyMode: "standard" as const,
          sourceTurnId: second.id,
          sourceTurnVersion: second.version,
          updatedAt: new Date().toISOString(),
        };
        current = queueSnapshot([first], { version: 7 });
        return response(current.items, 7, draft);
      },
      steerQueueItem: async (_ws, _session, _turn, request) => {
        calls.push({ action: "steer", request });
        return response(current.items, 8);
      },
      deleteQueueItem: async (_ws, _session, _turn, request) => {
        calls.push({ action: "delete", request });
        current = queueSnapshot([], { version: 9 });
        return response([], 9);
      },
    });
    const hook = await renderHook(
      () =>
        useTurnQueue(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    await flushing(async () =>
      expect(await hook.result.current.moveTurn(first.id, null)).toBe(true),
    );
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual([second.id, first.id]);
    let checkedOut = null;
    await flushing(async () => {
      checkedOut = await hook.result.current.editTurn(second.id, {
        expectedDraftRevision: 2,
        replaceDraft: true,
      });
    });
    expect(checkedOut).toMatchObject({ sourceTurnId: second.id, revision: 3 });
    await flushing(async () => expect(await hook.result.current.steerTurn(first.id)).toBe(true));
    expect(hook.result.current.acceptedSteers).toEqual([
      expect.objectContaining({
        turnId: first.id,
        triggerEventId: first.triggerEventId,
        text: first.prompt,
        state: "queued",
      }),
    ]);
    await flushing(async () => expect(await hook.result.current.removeTurn(first.id)).toBe(true));
    expect(calls.map((call) => call.action)).toEqual(["move", "edit", "steer", "delete"]);
    expect(calls[0]?.request).toMatchObject({
      expectedQueueVersion: 5,
      beforeTurnId: null,
    });
    expect(calls[1]?.request).toMatchObject({
      expectedTurnVersion: 4,
      expectedDraftRevision: 2,
    });
    expect(calls[2]?.request).toMatchObject({
      expectedTurnVersion: 2,
      controlEtag: "control-3",
    });
    expect(calls[3]?.request).toMatchObject({ expectedTurnVersion: 2 });
    await hook.unmount();
  });

  test("queue Steer stays bridged into chat until the replacement turn starts", async () => {
    const turn = fakeTurn({ id: "steered-turn", prompt: "New direction" });
    let current = queueSnapshot([turn], { version: 5 });
    const client = fakeClient({
      getQueue: async () => current,
      steerQueueItem: async () => {
        current = queueSnapshot([], { version: 6 });
        return {
          receipt: promptReceipt(turn.id, "queue.steer"),
          snapshot: current,
        };
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();

    await flushing(async () => expect(await hook.result.current.steerTurn(turn.id)).toBe(true));
    expect(hook.result.current.acceptedSteers).toEqual([
      expect.objectContaining({ turnId: turn.id, text: "New direction", state: "queued" }),
    ]);

    await hook.rerender([
      makeEvent(10, "session.control.steer_requested", { targetTurnId: turn.id }),
    ]);
    await flush();
    expect(hook.result.current.acceptedSteers).toHaveLength(1);

    await hook.rerender([
      makeEvent(10, "session.control.steer_requested", { targetTurnId: turn.id }),
      {
        ...makeEvent(11, "turn.started", { triggerEventId: turn.triggerEventId }),
        turnId: turn.id,
      },
    ]);
    await flush();
    expect(hook.result.current.acceptedSteers).toEqual([]);
    await hook.unmount();
  });

  test("a delayed older GET cannot overwrite a newer mutation snapshot", async () => {
    const old = queueSnapshot([fakeTurn({ id: "old" })], { version: 1 });
    let resolveRead!: (snapshot: SessionQueueSnapshot) => void;
    let reads = 0;
    const client = fakeClient({
      getQueue: async () => {
        reads += 1;
        if (reads === 1) return old;
        return await new Promise<SessionQueueSnapshot>((resolve) => (resolveRead = resolve));
      },
      deleteQueueItem: async () => ({
        receipt: {
          id: crypto.randomUUID(),
          action: "queue.delete",
          operationKey: "delete",
          targetSessionId: SESSION_ID,
          targetTurnId: "old",
          appliedControlRevision: null,
          appliedQueueVersion: 2,
          appliedTurnVersion: 2,
          appliedDraftRevision: null,
          createdAt: new Date().toISOString(),
        },
        snapshot: queueSnapshot([], { version: 2 }),
      }),
    });
    const hook = await renderHook(
      () =>
        useTurnQueue(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    const staleRead = hook.result.current.refresh();
    await flushing(async () => expect(await hook.result.current.removeTurn("old")).toBe(true));
    await flushing(async () => {
      resolveRead(old);
      await staleRead;
    });
    await flush();
    expect(hook.result.current.snapshot?.version).toBe(2);
    expect(hook.result.current.queue).toEqual([]);
    await hook.unmount();
  });

  test("a delayed queue mutation cannot regress newer effective-control truth", async () => {
    const queued = fakeTurn({ id: "control-race" });
    const snapshot = (version: number, controlVersion: number, items: SessionTurn[]) => {
      const base = queueSnapshot(items, { version });
      return {
        ...base,
        effectiveControl: {
          ...base.effectiveControl,
          controlVersion,
          controlEtag: `control-${controlVersion}`,
        },
      };
    };
    let read = snapshot(5, 5, [queued]);
    let resolveMutation!: (response: SessionQueueMutationResponse) => void;
    const client = fakeClient({
      getQueue: async () => read,
      deleteQueueItem: async () =>
        await new Promise<SessionQueueMutationResponse>((resolve) => {
          resolveMutation = resolve;
        }),
    });
    const hook = await renderHook(
      () =>
        useTurnQueue(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();

    let deletion!: Promise<boolean>;
    await flushing(() => {
      deletion = hook.result.current.removeTurn(queued.id);
    });
    read = snapshot(5, 6, [queued]);
    await flushing(async () => await hook.result.current.refresh());
    await flushing(async () => {
      resolveMutation({
        receipt: {
          id: crypto.randomUUID(),
          action: "queue.delete",
          operationKey: "control-race-delete",
          targetSessionId: SESSION_ID,
          targetTurnId: queued.id,
          appliedControlRevision: null,
          appliedQueueVersion: 6,
          appliedTurnVersion: 2,
          appliedDraftRevision: null,
          createdAt: new Date().toISOString(),
        },
        snapshot: snapshot(6, 5, []),
      });
      expect(await deletion).toBe(true);
    });

    expect(hook.result.current.snapshot?.effectiveControl.controlVersion).toBe(6);
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual([queued.id]);
    await hook.unmount();
  });

  test("a session switch hides the old queue and drops its delayed mutation settlement", async () => {
    const sessionA: string = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const turnA = fakeTurn({
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      prompt: "A PRIVATE",
    });
    const turnB = fakeTurn({
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      prompt: "B PRIVATE",
    });
    let resolveBRead!: (snapshot: SessionQueueSnapshot) => void;
    let resolveAMutation!: (result: SessionQueueMutationResponse) => void;
    const client = fakeClient({
      getQueue: async (_workspaceId, sessionId) => {
        if (sessionId === sessionA) return queueSnapshot([turnA]);
        return await new Promise<SessionQueueSnapshot>((resolve) => {
          resolveBRead = resolve;
        });
      },
      deleteQueueItem: async () =>
        await new Promise<SessionQueueMutationResponse>((resolve) => {
          resolveAMutation = resolve;
        }),
    });
    const hook = await renderHook(
      (sessionId: string) =>
        useTurnQueue(sessionId, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      sessionA,
    );
    await flush();
    expect(hook.result.current.queue.map((turn) => turn.prompt)).toEqual(["A PRIVATE"]);

    let staleMutation!: Promise<boolean>;
    await flushing(() => {
      staleMutation = hook.result.current.removeTurn(turnA.id);
    });
    await hook.rerender(sessionB);
    expect(hook.result.current.queue).toEqual([]);
    expect(hook.result.current.loading).toBe(true);

    await flushing(() => resolveBRead(queueSnapshot([turnB])));
    expect(hook.result.current.queue.map((turn) => turn.prompt)).toEqual(["B PRIVATE"]);

    await flushing(async () => {
      resolveAMutation({
        receipt: {
          id: crypto.randomUUID(),
          action: "queue.delete",
          operationKey: "stale-a-delete",
          targetSessionId: sessionA,
          targetTurnId: turnA.id,
          appliedControlRevision: null,
          appliedQueueVersion: 2,
          appliedTurnVersion: 2,
          appliedDraftRevision: null,
          createdAt: new Date().toISOString(),
        },
        snapshot: queueSnapshot([], { version: 2 }),
      });
      expect(await staleMutation).toBe(false);
    });
    expect(hook.result.current.queue.map((turn) => turn.prompt)).toEqual(["B PRIVATE"]);
    expect(hook.result.current.mutationError).toBeNull();
    await hook.unmount();
  });
});

describe("useSessionLineage", () => {
  test("cancels its lineage read when the hook unmounts", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = fakeClient({
      getSessionLineage: async (_workspaceId, _sessionId, options) => {
        requestSignal = options?.signal;
        return await new Promise(() => {});
      },
    });
    const hook = await renderHook(
      () => useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();

    expect(requestSignal?.aborted).toBe(false);
    await hook.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  test("captures a shared causal generation when each lineage request starts", async () => {
    let releaseInitial: (() => void) | null = null;
    let nextGeneration = 70;
    let reads = 0;
    const started: number[] = [];
    const beginRead = () => {
      const generation = ++nextGeneration;
      started.push(generation);
      return generation;
    };
    const client = fakeClient({
      getSessionLineage: async (_workspaceId, _sessionId, options) => {
        options?.onRequestStart?.();
        reads += 1;
        if (reads === 1) {
          await new Promise<void>((resolve) => {
            releaseInitial = resolve;
          });
        }
        return {
          ancestors: [{ id: `ancestor-${reads}` }],
          children: [],
          truncated: false,
        } as never;
      },
    });
    const hook = await renderHook(
      () =>
        useSessionLineage(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          beginRead,
        }),
      undefined,
    );
    await flush();

    expect(started).toEqual([71]);
    expect(hook.result.current.readGeneration).toBe(0);
    await reactAct(async () => releaseInitial!());
    await flush();
    expect(hook.result.current.readGeneration).toBe(71);

    await reactAct(async () => {
      await hook.result.current.refresh();
    });
    await flush();
    expect(started).toEqual([71, 72]);
    expect(hook.result.current.readGeneration).toBe(72);
    await hook.unmount();
  });

  test("does not assign a post-move generation when a remount joins a pre-move lineage GET", async () => {
    let requests = 0;
    let channelId = "channel-a";
    let causalGeneration = 0;
    const beginRead = () => ++causalGeneration;
    let releaseInitial!: () => void;
    let markInitialStarted!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const initialStarted = new Promise<void>((resolve) => {
      markInitialStarted = resolve;
    });
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      beginSharedRead: beginRead,
      fetch: async () => {
        requests += 1;
        const request = requests;
        const snapshotChannelId = channelId;
        if (request === 1) {
          markInitialStarted();
          await initialGate;
        }
        return new Response(
          JSON.stringify({
            ancestors: [
              {
                id: "ancestor",
                workspaceId: WORKSPACE_ID,
                channelId: snapshotChannelId,
              },
            ],
            children: [],
            truncated: false,
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    // A non-authority consumer keeps the pre-move shared lineage request alive
    // while the authority-bearing rail is collapsed.
    const collapsedRail = await renderHook(
      () => useSessionLineage(null, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await collapsedRail.unmount();
    const preMoveConsumer = client.getSessionLineage(WORKSPACE_ID, SESSION_ID);
    await initialStarted;

    channelId = "channel-b";
    const acceptedMoveGeneration = beginRead();
    const remountedRail = await renderHook(
      () =>
        useSessionLineage(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          beginRead,
        }),
      undefined,
    );
    await flush();

    expect(requests).toBe(1);
    expect(causalGeneration).toBe(acceptedMoveGeneration);
    releaseInitial();
    await preMoveConsumer;
    await flush();

    expect(remountedRail.result.current.lineage?.ancestors[0]?.channelId).toBe("channel-a");
    expect(remountedRail.result.current.readGeneration).toBeGreaterThan(0);
    expect(remountedRail.result.current.readGeneration).toBeLessThan(acceptedMoveGeneration);

    await reactAct(async () => {
      await remountedRail.result.current.refresh();
    });
    await flush();
    expect(requests).toBe(2);
    expect(remountedRail.result.current.lineage?.ancestors[0]?.channelId).toBe("channel-b");
    expect(remountedRail.result.current.readGeneration).toBeGreaterThan(acceptedMoveGeneration);
    await remountedRail.unmount();
  });

  test("uses a post-settlement generation when the rail joins a non-authority lineage GET", async () => {
    let requests = 0;
    let causalGeneration = 0;
    const beginRead = () => ++causalGeneration;
    const acceptedMoveGeneration = beginRead();
    let releaseInitial!: () => void;
    let markInitialStarted!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    const initialStarted = new Promise<void>((resolve) => {
      markInitialStarted = resolve;
    });
    const client = new OpenGeniClient({
      baseUrl: "https://api.example.test",
      beginSharedRead: beginRead,
      fetch: async () => {
        requests += 1;
        markInitialStarted();
        await initialGate;
        return new Response(
          JSON.stringify({
            ancestors: [
              {
                id: "ancestor",
                workspaceId: WORKSPACE_ID,
                channelId: "channel-c",
              },
            ],
            children: [],
            truncated: false,
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });

    // A mounted route/header poll starts the shared request after B settles;
    // the authority-bearing rail joins only after that actual network start.
    const nonAuthorityConsumer = client.getSessionLineage(WORKSPACE_ID, SESSION_ID);
    await initialStarted;
    const remountedRail = await renderHook(
      () =>
        useSessionLineage(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          beginRead,
        }),
      undefined,
    );
    await flush();

    expect(requests).toBe(1);
    expect(causalGeneration).toBe(acceptedMoveGeneration + 1);
    releaseInitial();
    await nonAuthorityConsumer;
    await flush();

    expect(remountedRail.result.current.lineage?.ancestors[0]?.channelId).toBe("channel-c");
    expect(remountedRail.result.current.readGeneration).toBeGreaterThan(acceptedMoveGeneration);
    expect(remountedRail.result.current.readGeneration).toBe(causalGeneration);
    await remountedRail.unmount();
  });

  test("loads lineage and refreshes on session lineage events", async () => {
    let reads = 0;
    const client = fakeClient({
      getSessionLineage: async () => {
        reads += 1;
        return {
          ancestors: [],
          children: [{ session: { id: `child-${reads}` }, children: [] }],
          truncated: false,
        } as never;
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useSessionLineage(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events,
        }),
      [] as SessionEvent[],
    );
    await flush();
    expect(hook.result.current.lineage?.children[0]?.session.id).toBe("child-1");
    await hook.rerender([makeEvent(1, "agent.message.delta")]);
    await flush(200);
    expect(reads).toBe(1);
    await hook.rerender([
      makeEvent(1, "agent.message.delta"),
      makeEvent(2, "session.status.changed"),
    ]);
    await flush(250);
    expect(reads).toBe(2);
    expect(hook.result.current.lineage?.children[0]?.session.id).toBe("child-2");
    await hook.unmount();
  });

  test("refreshes immediately and once later when a child session create tool starts", async () => {
    let reads = 0;
    const client = fakeClient({
      getSessionLineage: async () => {
        reads += 1;
        return {
          ancestors: [],
          children: [{ session: { id: `child-${reads}` }, children: [] }],
          truncated: false,
        } as never;
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useSessionLineage(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events,
        }),
      [] as SessionEvent[],
    );
    await flush();
    expect(reads).toBe(1);

    await hook.rerender([makeEvent(1, "agent.toolCall.created", { name: "session_create" })]);
    await flush(50);
    expect(reads).toBe(2);
    expect(hook.result.current.lineage?.children[0]?.session.id).toBe("child-2");

    await flush(2700);
    expect(reads).toBe(3);
    expect(hook.result.current.lineage?.children[0]?.session.id).toBe("child-3");
    await hook.unmount();
  });
});

describe("useGoal", () => {
  test("cancels its goal read when the hook unmounts", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = fakeClient({
      getGoal: async (_workspaceId, _sessionId, options) => {
        requestSignal = options?.signal;
        return await new Promise(() => {});
      },
    });
    const hook = await renderHook(
      () => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();

    expect(requestSignal?.aborted).toBe(false);
    await hook.unmount();
    expect(requestSignal?.aborted).toBe(true);
  });

  test("exposes the goal with its autonomy counters", async () => {
    const goal = fakeGoal({ autoContinuations: 7, noProgressStreak: 2 });
    const client = fakeClient({ getGoal: async () => goal });
    const hook = await renderHook(
      () => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.goal?.autoContinuations).toBe(7);
    expect(hook.result.current.goal?.noProgressStreak).toBe(2);
    expect(hook.result.current.isActive).toBe(true);
    await hook.unmount();
  });

  test("a 404 means no goal, not an error", async () => {
    const client = fakeClient({
      getGoal: async () => {
        throw new OpenGeniApiError(404, "session goal not found");
      },
    });
    const hook = await renderHook(
      () => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.goal).toBeNull();
    expect(hook.result.current.error).toBeNull();
    expect(hook.result.current.loading).toBe(false);
    await hook.unmount();
  });

  test("shared empty event logs do not probe the goal endpoint", async () => {
    let reads = 0;
    const client = fakeClient({
      getGoal: async () => {
        reads += 1;
        return fakeGoal();
      },
    });
    const hook = await renderHook(
      () =>
        useGoal(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    expect(reads).toBe(0);
    expect(hook.result.current.goal).toBeNull();
    expect(hook.result.current.loading).toBe(false);
    await hook.unmount();
  });

  test("pause and resume PATCH the goal and update local state", async () => {
    const calls: { status: string; rationale?: string | undefined }[] = [];
    const client = fakeClient({
      getGoal: async () => fakeGoal(),
      updateGoal: async (_ws, _session, request) => {
        if (!("status" in request)) throw new Error("expected status mutation");
        calls.push({ status: request.status, rationale: request.rationale });
        return fakeGoal({
          status: request.status === "paused" ? "paused" : "active",
          pausedReason: request.status === "paused" ? "api" : null,
        });
      },
    });
    const hook = await renderHook(
      () =>
        useGoal(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    await flushing(async () => {
      await hook.result.current.pause("operator break");
    });
    expect(hook.result.current.isPaused).toBe(true);
    await flushing(async () => {
      await hook.result.current.resume();
    });
    expect(hook.result.current.isActive).toBe(true);
    expect(calls).toEqual([
      { status: "paused", rationale: "operator break" },
      { status: "active", rationale: undefined },
    ]);
    await hook.unmount();
  });

  test("clearGoal DELETEs the goal and clears local state", async () => {
    let deletes = 0;
    const client = fakeClient({
      getGoal: async () => fakeGoal(),
      deleteGoal: async () => {
        deletes += 1;
      },
    });
    const hook = await renderHook(
      () =>
        useGoal(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    await flushing(async () => {
      await hook.result.current.clearGoal();
    });
    expect(deletes).toBe(1);
    expect(hook.result.current.goal).toBeNull();
    expect(hook.result.current.isActive).toBe(false);
    await hook.unmount();
  });

  test("a FAILED clearGoal keeps the goal (and surfaces the error), never hides the pill", async () => {
    const client = fakeClient({
      getGoal: async () => fakeGoal(),
      deleteGoal: async () => {
        throw new Error("server 5xx");
      },
    });
    const hook = await renderHook(
      () =>
        useGoal(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    // Populate the goal (shared-feed skips the initial auto-load).
    await flushing(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.goal).not.toBeNull();
    await flushing(async () => {
      await hook.result.current.clearGoal();
    });
    // The delete failed → the goal must remain so the panel's mutationError renders.
    expect(hook.result.current.goal).not.toBeNull();
    expect(hook.result.current.mutationError).not.toBeNull();
    await hook.unmount();
  });

  test("goal.* events on a shared log refetch the goal", async () => {
    let reads = 0;
    const client = fakeClient({
      getGoal: async () => {
        reads += 1;
        return fakeGoal({ status: "paused" });
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    expect(reads).toBe(0);
    await hook.rerender([makeEvent(1, "goal.paused")]);
    await flush(250);
    expect(reads).toBe(1);
    expect(hook.result.current.isPaused).toBe(true);
    await hook.unmount();
  });

  test("turn, session, control, and system-update events refresh continuation truth", async () => {
    let reads = 0;
    const client = fakeClient({
      getGoal: async () => {
        reads += 1;
        return fakeGoal({
          continuation: {
            state: "scheduled",
            reason: "wake_pending",
            wakeRevision: reads,
            observedRevision: reads,
            nextAttemptAt: null,
            lastError: null,
          },
        });
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    expect(reads).toBe(0);

    await hook.rerender([
      makeEvent(1, "agent.message.delta"),
      makeEvent(2, "turn.started"),
      makeEvent(3, "session.status.changed"),
      makeEvent(4, "session.control.paused"),
      makeEvent(5, "system.update.pending"),
    ]);
    await flush(250);

    expect(reads).toBe(1);
    expect(hook.result.current.goal?.continuation?.state).toBe("scheduled");
    await hook.unmount();
  });

  test("shared-feed goal refreshes are discarded after the session changes", async () => {
    const initialSessionId: string = SESSION_ID;
    const otherSessionId = "33333333-3333-4333-8333-333333333333";
    const reads: string[] = [];
    let resolveGoal: ((goal: ReturnType<typeof fakeGoal>) => void) | null = null;
    const client = fakeClient({
      getGoal: async (_workspaceId, sessionId) => {
        reads.push(sessionId);
        return await new Promise<ReturnType<typeof fakeGoal>>((resolve) => {
          resolveGoal = resolve;
        });
      },
    });
    const hook = await renderHook(
      (sessionId: string) =>
        useGoal(sessionId, {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      initialSessionId,
    );
    await flush();

    const pendingRefresh = hook.result.current.refresh();
    expect(reads).toEqual([SESSION_ID]);
    await hook.rerender(otherSessionId);
    await flushing(async () => {
      resolveGoal!(fakeGoal({ text: "stale goal from the previous session" }));
      await pendingRefresh;
    });

    expect(hook.result.current.goal).toBeNull();
    await hook.unmount();
  });
});

describe("useSessionMcpApprovalPolicy", () => {
  test("updates optimistically and reconciles the authoritative policy event", async () => {
    let reads = 0;
    let currentPolicy: SessionMcpApprovalPolicy = false;
    const metadata = (): SessionMcpServerMetadata => ({
      id: "external_tools",
      name: "External tools",
      url: "https://tools.example.test/mcp",
      headerNames: [],
      credentialVersion: 1,
      requireApproval: currentPolicy,
      connectionRef: null,
    });
    const client = {
      ...fakeClient({
        getSession: async () => {
          reads += 1;
          return {
            id: SESSION_ID,
            lastSequence: reads,
            mcpServers: [metadata()],
          } as never;
        },
      }),
      updateSessionMcpApprovalPolicy: async (_workspaceId, _sessionId, serverId, request) => {
        expect(serverId).toBe("external_tools");
        currentPolicy = request.requireApproval;
        return { server: metadata(), effectiveFrom: "next_attempt" };
      },
    } satisfies EmbeddedSessionMcpApprovalPolicyClientLike;
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useSessionMcpApprovalPolicy(SESSION_ID, "external_tools", {
          client,
          workspaceId: WORKSPACE_ID,
          events,
        }),
      [] as SessionEvent[],
    );
    await flush();
    expect(hook.result.current.policy).toBe(false);
    expect(reads).toBe(1);

    await flushing(async () => {
      const response = await hook.result.current.update(["write_record"]);
      expect(response?.effectiveFrom).toBe("next_attempt");
    });
    expect(hook.result.current.policy).toEqual(["write_record"]);

    currentPolicy = ["write_record", "delete_record"];
    await hook.rerender([
      makeEvent(1, "session.mcp.approval_policy.updated", {
        serverId: "another_server",
        requireApproval: true,
        effectiveFrom: "next_attempt",
      }),
    ]);
    await flush(200);
    expect(reads).toBe(2);
    await hook.rerender([
      makeEvent(1, "session.mcp.approval_policy.updated", {
        serverId: "another_server",
        requireApproval: true,
        effectiveFrom: "next_attempt",
      }),
      makeEvent(2, "session.mcp.approval_policy.updated", {
        serverId: "external_tools",
        requireApproval: currentPolicy,
        effectiveFrom: "next_attempt",
      }),
    ]);
    await flush(250);
    expect(reads).toBe(3);
    expect(hook.result.current.policy).toEqual(["write_record", "delete_record"]);
    await hook.unmount();
  });

  test("a delayed pre-mutation read cannot clear the newer policy response", async () => {
    const metadata = (requireApproval: SessionMcpApprovalPolicy): SessionMcpServerMetadata => ({
      id: "external_tools",
      name: "External tools",
      url: "https://tools.example.test/mcp",
      headerNames: [],
      credentialVersion: 1,
      requireApproval,
      connectionRef: null,
    });
    let reads = 0;
    let resolveInitialRead:
      | ((session: {
          id: string;
          lastSequence: number;
          mcpServers: SessionMcpServerMetadata[];
        }) => void)
      | null = null;
    let resolveReconcileRead:
      | ((session: {
          id: string;
          lastSequence: number;
          mcpServers: SessionMcpServerMetadata[];
        }) => void)
      | null = null;
    const initialRead = new Promise<{
      id: string;
      lastSequence: number;
      mcpServers: SessionMcpServerMetadata[];
    }>((resolve) => {
      resolveInitialRead = resolve;
    });
    const reconcileRead = new Promise<{
      id: string;
      lastSequence: number;
      mcpServers: SessionMcpServerMetadata[];
    }>((resolve) => {
      resolveReconcileRead = resolve;
    });
    const client = {
      ...fakeClient({
        getSession: async () => {
          reads += 1;
          return (await (reads === 1 ? initialRead : reconcileRead)) as never;
        },
      }),
      updateSessionMcpApprovalPolicy: async () => ({
        server: metadata(["write_record"]),
        effectiveFrom: "next_attempt" as const,
      }),
    } satisfies EmbeddedSessionMcpApprovalPolicyClientLike;
    const hook = await renderHook(
      () =>
        useSessionMcpApprovalPolicy(SESSION_ID, "external_tools", {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      undefined,
    );
    await flush();
    expect(reads).toBe(1);

    await flushing(async () => {
      await hook.result.current.update(["write_record"]);
    });
    // The authoritative post-mutation read queues behind the older read rather
    // than overlapping it. The mutation response remains the visible truth.
    expect(reads).toBe(1);
    expect(hook.result.current.policy).toEqual(["write_record"]);

    await flushing(() => {
      resolveInitialRead?.({
        id: SESSION_ID,
        lastSequence: 1,
        mcpServers: [metadata(false)],
      });
    });
    expect(reads).toBe(2);
    expect(hook.result.current.policy).toEqual(["write_record"]);

    await flushing(() => {
      resolveReconcileRead?.({
        id: SESSION_ID,
        lastSequence: 2,
        mcpServers: [metadata(["write_record"])],
      });
    });
    expect(hook.result.current.policy).toEqual(["write_record"]);
    await hook.unmount();
  });

  test("providerless stream open reconciles policy state without blocking live delivery", async () => {
    let reads = 0;
    let currentPolicy: SessionMcpApprovalPolicy = false;
    const metadata = (): SessionMcpServerMetadata => ({
      id: "external_tools",
      name: "External tools",
      url: "https://tools.example.test/mcp",
      headerNames: [],
      credentialVersion: 1,
      requireApproval: currentPolicy,
      connectionRef: null,
    });
    const client = {
      ...fakeClient({
        getSession: async () => {
          reads += 1;
          return {
            id: SESSION_ID,
            lastSequence: 41,
            mcpServers: [metadata()],
          } as never;
        },
        streamEvents: (_workspaceId, _sessionId, options) =>
          (async function* () {
            currentPolicy = ["write_record"];
            options?.onOpen?.();
            const event = await new Promise<SessionEvent | null>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(null), {
                once: true,
              });
            });
            if (event) yield event;
          })(),
      }),
      updateSessionMcpApprovalPolicy: async () => ({
        server: metadata(),
        effectiveFrom: "next_attempt" as const,
      }),
    } satisfies EmbeddedSessionMcpApprovalPolicyClientLike;
    const hook = await renderHook(
      () =>
        useSessionMcpApprovalPolicy(SESSION_ID, "external_tools", {
          client,
          workspaceId: WORKSPACE_ID,
        }),
      undefined,
    );
    await flush();

    expect(reads).toBe(3);
    expect(hook.result.current.policy).toEqual(["write_record"]);
    await hook.unmount();
  });

  test("a target switch drops settlement from the previous policy mutation", async () => {
    const initialSessionId: string = SESSION_ID;
    const otherSessionId = "33333333-3333-4333-8333-333333333333";
    const metadata = (requireApproval: SessionMcpApprovalPolicy): SessionMcpServerMetadata => ({
      id: "external_tools",
      name: "External tools",
      url: "https://tools.example.test/mcp",
      headerNames: [],
      credentialVersion: 1,
      requireApproval,
      connectionRef: null,
    });
    let resolveMutation:
      | ((response: { server: SessionMcpServerMetadata; effectiveFrom: "next_attempt" }) => void)
      | null = null;
    const mutation = new Promise<{
      server: SessionMcpServerMetadata;
      effectiveFrom: "next_attempt";
    }>((resolve) => {
      resolveMutation = resolve;
    });
    const client = {
      ...fakeClient({
        getSession: async (_workspaceId, sessionId) =>
          ({
            id: sessionId,
            lastSequence: 1,
            mcpServers: [metadata(sessionId !== SESSION_ID)],
          }) as never,
      }),
      updateSessionMcpApprovalPolicy: async () => await mutation,
    } satisfies EmbeddedSessionMcpApprovalPolicyClientLike;
    const hook = await renderHook(
      (sessionId: string) =>
        useSessionMcpApprovalPolicy(sessionId, "external_tools", {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      initialSessionId,
    );
    await flush();
    expect(hook.result.current.policy).toBe(false);

    let pending: ReturnType<typeof hook.result.current.update> | null = null;
    await flushing(() => {
      pending = hook.result.current.update(["obsolete_write"]);
    });
    await hook.rerender(otherSessionId);
    await flush();
    expect(hook.result.current.policy).toBe(true);

    await flushing(() => {
      resolveMutation?.({
        server: metadata(["obsolete_write"]),
        effectiveFrom: "next_attempt",
      });
    });
    expect(await pending).toBeNull();
    expect(hook.result.current.policy).toBe(true);
    await hook.unmount();
  });

  test("a client switch drops settlement from the previous policy mutation", async () => {
    const metadata = (requireApproval: SessionMcpApprovalPolicy): SessionMcpServerMetadata => ({
      id: "external_tools",
      name: "External tools",
      url: "https://tools.example.test/mcp",
      headerNames: [],
      credentialVersion: 1,
      requireApproval,
      connectionRef: null,
    });
    let resolveMutation:
      | ((response: { server: SessionMcpServerMetadata; effectiveFrom: "next_attempt" }) => void)
      | null = null;
    const mutation = new Promise<{
      server: SessionMcpServerMetadata;
      effectiveFrom: "next_attempt";
    }>((resolve) => {
      resolveMutation = resolve;
    });
    const previousClient = {
      ...fakeClient({
        getSession: async () =>
          ({
            id: SESSION_ID,
            lastSequence: 1,
            mcpServers: [metadata(false)],
          }) as never,
      }),
      updateSessionMcpApprovalPolicy: async () => await mutation,
    } satisfies EmbeddedSessionMcpApprovalPolicyClientLike;
    const nextClient = {
      ...fakeClient({
        getSession: async () =>
          ({
            id: SESSION_ID,
            lastSequence: 2,
            mcpServers: [metadata(true)],
          }) as never,
      }),
      updateSessionMcpApprovalPolicy: async () => ({
        server: metadata(true),
        effectiveFrom: "next_attempt" as const,
      }),
    } satisfies EmbeddedSessionMcpApprovalPolicyClientLike;
    const hook = await renderHook(
      (client: EmbeddedSessionMcpApprovalPolicyClientLike) =>
        useSessionMcpApprovalPolicy(SESSION_ID, "external_tools", {
          client,
          workspaceId: WORKSPACE_ID,
          events: noEvents,
        }),
      previousClient,
    );
    await flush();
    expect(hook.result.current.policy).toBe(false);

    let pending: ReturnType<typeof hook.result.current.update> | null = null;
    await flushing(() => {
      pending = hook.result.current.update(["obsolete_write"]);
    });
    await hook.rerender(nextClient);
    await flush();
    expect(hook.result.current.policy).toBe(true);

    await flushing(() => {
      resolveMutation?.({
        server: metadata(["obsolete_write"]),
        effectiveFrom: "next_attempt",
      });
    });
    expect(await pending).toBeNull();
    expect(hook.result.current.policy).toBe(true);
    await hook.unmount();
  });
});

describe("useSessionControl", () => {
  test("pause, resume, and approval decisions use the one control plane", async () => {
    const sent: unknown[] = [];
    const response = (controlState: "active" | "paused") => ({
      receipt: {
        id: crypto.randomUUID(),
        action: `session.${controlState}`,
        operationKey: crypto.randomUUID(),
        targetSessionId: SESSION_ID,
        targetTurnId: null,
        appliedControlRevision: 1,
        appliedQueueVersion: null,
        appliedTurnVersion: null,
        appliedDraftRevision: null,
        createdAt: new Date().toISOString(),
      },
      effectiveControl: {
        ...queueSnapshot([]).effectiveControl,
        state: controlState,
        directState: controlState,
      },
      interruptionCount: 0,
      wakeCount: controlState === "active" ? 1 : 0,
      cancelledSessionCount: 0,
      cancelledTurnCount: 0,
    });
    const client = fakeClient({
      pauseSession: async (_ws, _session, options) => {
        sent.push({ kind: "pause", ...options });
        return response("paused");
      },
      resumeSession: async (_ws, _session, options) => {
        sent.push({ kind: "resume", ...options });
        return response("active");
      },
      sendApprovalDecision: async (_ws, _session, decision) => {
        sent.push({ kind: "decision", ...decision });
        return makeEvent(3, "user.approvalDecision");
      },
    });
    const hook = await renderHook(
      () => useSessionControl(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flushing(async () => {
      await hook.result.current.pause("stop now");
      await hook.result.current.resume("continue");
      await hook.result.current.approve("ap-1", "looks safe");
      await hook.result.current.reject("ap-2");
    });
    expect(sent).toEqual([
      { kind: "pause", reason: "stop now" },
      { kind: "resume", reason: "continue" },
      {
        kind: "decision",
        approvalId: "ap-1",
        decision: "approve",
        message: "looks safe",
        clientEventId: expect.any(String),
      },
      {
        kind: "decision",
        approvalId: "ap-2",
        decision: "reject",
        clientEventId: expect.any(String),
      },
    ]);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("reuses an approval idempotency key after a lost response", async () => {
    const clientEventIds: string[] = [];
    let attempts = 0;
    const client = fakeClient({
      sendApprovalDecision: async (_ws, _session, decision) => {
        clientEventIds.push(decision.clientEventId ?? "");
        attempts += 1;
        if (attempts === 1) throw new Error("response lost");
        return makeEvent(3, "user.approvalDecision");
      },
    });
    const hook = await renderHook(
      () => useSessionControl(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flushing(async () => {
      expect(await hook.result.current.approve("ap-1", "looks safe")).toBeNull();
      expect(await hook.result.current.approve("ap-1", "looks safe")).not.toBeNull();
    });

    expect(clientEventIds).toHaveLength(2);
    expect(clientEventIds[0]).not.toBe("");
    expect(clientEventIds[1]).toBe(clientEventIds[0]);
    await hook.unmount();
  });

  test("a session switch drops stale control loading and error settlement", async () => {
    const sessionA: string = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let rejectPause!: (cause: Error) => void;
    const client = fakeClient({
      pauseSession: async () =>
        await new Promise((_resolve, reject) => {
          rejectPause = reject;
        }),
    });
    const hook = await renderHook(
      (sessionId: string) => useSessionControl(sessionId, { client, workspaceId: WORKSPACE_ID }),
      sessionA,
    );

    let stalePause!: Promise<unknown>;
    await flushing(() => {
      stalePause = hook.result.current.pause();
    });
    expect(hook.result.current.controlling).toBe(true);
    await hook.rerender(sessionB);
    expect(hook.result.current.controlling).toBe(false);
    expect(hook.result.current.error).toBeNull();

    await flushing(async () => {
      rejectPause(new Error("A PRIVATE CONTROL ERROR"));
      expect(await stalePause).toBeNull();
    });
    expect(hook.result.current.controlling).toBe(false);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("a session switch returns null for a successful stale control settlement", async () => {
    const sessionA: string = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let resolvePause!: (response: SessionControlResponse) => void;
    const client = fakeClient({
      pauseSession: async () =>
        await new Promise<SessionControlResponse>((resolve) => {
          resolvePause = resolve;
        }),
    });
    const hook = await renderHook(
      (sessionId: string) => useSessionControl(sessionId, { client, workspaceId: WORKSPACE_ID }),
      sessionA,
    );

    let stalePause!: Promise<SessionControlResponse | null>;
    await flushing(() => {
      stalePause = hook.result.current.pause();
    });
    await hook.rerender(sessionB);
    await flushing(async () => {
      resolvePause({
        receipt: {
          id: crypto.randomUUID(),
          action: "session.paused",
          operationKey: crypto.randomUUID(),
          targetSessionId: sessionA,
          targetTurnId: null,
          appliedControlRevision: 1,
          appliedQueueVersion: null,
          appliedTurnVersion: null,
          appliedDraftRevision: null,
          createdAt: new Date().toISOString(),
        },
        effectiveControl: {
          ...queueSnapshot([]).effectiveControl,
          state: "paused",
          directState: "paused",
        },
        interruptionCount: 1,
        wakeCount: 0,
        cancelledSessionCount: 0,
        cancelledTurnCount: 0,
      });
      expect(await stalePause).toBeNull();
    });
    expect(hook.result.current.controlling).toBe(false);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });
});

describe("useComposer queue-vs-steer", () => {
  test("defaults to Send and appends through sendMessage", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      sendMessage: async () => {
        calls.push("send");
        return makeEvent(1, "user.message");
      },
      steerMessage: async () => {
        calls.push("steer");
        return steerResult();
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flushing(async () => {
      await hook.result.current.send("queued message");
    });
    expect(calls).toEqual(["send"]);
    await hook.unmount();
  });

  test("projects a busy Send into the queue rather than the chat timeline", async () => {
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => ({
        ...makeEvent(1, "user.message"),
        clientEventId: typeof input === "string" ? null : (input.clientEventId ?? null),
      }),
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendDestination: () => "queue",
        }),
      undefined,
    );

    await flushing(async () => {
      expect(await hook.result.current.send("run after current work")).toBe(true);
    });
    await flush();

    expect(hook.result.current.optimisticMessages?.[0]).toMatchObject({
      delivery: "send",
      destination: "queue",
      state: "queued",
      text: "run after current work",
    });
    await hook.unmount();
  });

  test("moves a normal Send into chat when the server promotes a human wait to Steer", async () => {
    let serverDraft: ComposerDraft = {
      revision: 0,
      text: "",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: null,
    };
    const client = fakeClient({
      getComposerDraft: async () => serverDraft,
      saveComposerDraft: async (_workspaceId, _sessionId, request) => {
        serverDraft = {
          ...serverDraft,
          ...request,
          revision: request.expectedRevision + 1,
          updatedAt: new Date().toISOString(),
        };
        return serverDraft;
      },
      submitComposerDraft: async (_workspaceId, _sessionId, request) => {
        const turn = fakeTurn({
          prompt: request.text,
          metadata: { delivery: "steer" },
        });
        const accepted = {
          ...makeEvent(2, "user.message", {
            text: request.text,
            delivery: "steer",
            routing: "accepted_for_steering",
          }),
          clientEventId: request.clientEventId,
        };
        serverDraft = {
          ...serverDraft,
          revision: request.expectedDraftRevision + 1,
          text: "",
          resources: [],
        };
        return {
          accepted,
          turn,
          draft: serverDraft,
          receipt: promptReceipt(turn.id),
          routing: "accepted_for_steering" as const,
          interruptionCount: 0,
          replay: false,
        };
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: [],
          sendDestination: () => "queue",
        }),
      undefined,
    );
    await flush();
    await flushing(() => hook.result.current.setValue("answer conversationally"));
    await flush(600);
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();

    expect(hook.result.current.optimisticMessages?.[0]).toMatchObject({
      delivery: "send",
      destination: "chat",
      state: "queued",
      text: "answer conversationally",
    });
    await hook.unmount();
  });

  test("moves a non-durable Send into chat when the accepted event reports promoted Steer", async () => {
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => ({
        ...makeEvent(2, "user.message", {
          text: typeof input === "string" ? input : input.text,
          delivery: "steer",
          routing: "accepted_for_steering",
        }),
        clientEventId: typeof input === "string" ? null : (input.clientEventId ?? null),
      }),
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: [],
          sendDestination: () => "queue",
          draftPersistence: "disabled",
          initialPolicy: INITIAL_COMPOSER_POLICY,
        }),
      undefined,
    );

    await flushing(async () =>
      expect(await hook.result.current.send("answer without durable drafts")).toBe(true),
    );
    await flush();

    expect(hook.result.current.optimisticMessages?.[0]).toMatchObject({
      delivery: "send",
      destination: "chat",
      state: "queued",
      text: "answer without durable drafts",
    });
    await hook.unmount();
  });

  test("keeps rapid first and second Sends on stable chat and queue surfaces", async () => {
    const resolvers: Array<(event: SessionEvent) => void> = [];
    const inputs: SendMessageInput[] = [];
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => {
        const typed = typeof input === "string" ? { text: input } : input;
        inputs.push(typed);
        return await new Promise<SessionEvent>((resolve) => resolvers.push(resolve));
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: INITIAL_COMPOSER_POLICY,
          events: [],
          sendDestination: () => "chat",
        }),
      undefined,
    );

    await flushing(async () => {
      expect(await hook.result.current.send("first now")).toBe(true);
      expect(await hook.result.current.send("second later")).toBe(true);
    });
    expect(
      hook.result.current.optimisticMessages?.map(({ text, destination }) => ({
        text,
        destination,
      })),
    ).toEqual([
      { text: "first now", destination: "chat" },
      { text: "second later", destination: "queue" },
    ]);
    expect(inputs).toHaveLength(1);

    await flushing(() =>
      resolvers[0]?.({
        ...makeEvent(10, "user.message"),
        clientEventId: inputs[0]?.clientEventId ?? null,
      }),
    );
    await flush();
    expect(inputs).toHaveLength(2);
    expect(
      hook.result.current.optimisticMessages?.map(({ text, destination }) => ({
        text,
        destination,
      })),
    ).toEqual([
      { text: "first now", destination: "chat" },
      { text: "second later", destination: "queue" },
    ]);

    await flushing(() =>
      resolvers[1]?.({
        ...makeEvent(11, "user.message"),
        clientEventId: inputs[1]?.clientEventId ?? null,
      }),
    );
    await flush();
    await hook.unmount();
  });

  test("moves an SSE-confirmed promoted Send into chat even when the HTTP response is lost", async () => {
    let rejectSend!: (cause: unknown) => void;
    const pendingSend = new Promise<SessionEvent>((_resolve, reject) => {
      rejectSend = reject;
    });
    const sent = { input: null as SendMessageInput | null };
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => {
        sent.input = typeof input === "string" ? { text: input } : input;
        return await pendingSend;
      },
    });
    type Props = { events: SessionEvent[] };
    const hook = await renderHook(
      (props: Props) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: INITIAL_COMPOSER_POLICY,
          events: props.events,
          sendDestination: () => "queue",
        }),
      { events: [] as SessionEvent[] },
    );

    await flushing(async () => expect(await hook.result.current.send("start now")).toBe(true));
    await flush();
    const clientEventId = sent.input?.clientEventId;
    expect(clientEventId).toBeString();
    const turn = fakeTurn({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const accepted = {
      ...makeEvent(20, "user.message", {
        delivery: "steer",
        routing: "accepted_for_steering",
      }),
      clientEventId,
    };
    const queued = {
      ...makeEvent(21, "turn.queued", { triggerEventId: accepted.id, turnId: turn.id }),
      turnId: turn.id,
    };
    await hook.rerender({ events: [accepted, queued] });
    expect(hook.result.current.optimisticMessages?.[0]).toMatchObject({
      state: "queued",
      destination: "chat",
      turnId: turn.id,
      triggerEventId: accepted.id,
      outcomeUnknown: false,
    });

    await flushing(async () => rejectSend(gatewayError(504)));
    await flush();
    expect(hook.result.current.optimisticMessages?.[0]).toMatchObject({
      state: "queued",
      destination: "chat",
    });

    await hook.rerender({
      events: [
        accepted,
        queued,
        {
          ...makeEvent(22, "turn.started", { triggerEventId: accepted.id }),
          turnId: turn.id,
        },
      ],
    });
    expect(hook.result.current.optimisticMessages).toEqual([]);
    await hook.unmount();
  });

  test("reconciles a promoted Send into chat after an outcome-unknown remount", async () => {
    const sent = { input: null as SendMessageInput | null };
    let reconciliationEvents: SessionEvent[] = [];
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => {
        sent.input = typeof input === "string" ? { text: input } : input;
        throw gatewayError(503);
      },
      listEvents: async () => reconciliationEvents,
    });
    const composerOptions = {
      client,
      workspaceId: WORKSPACE_ID,
      draftPersistence: "disabled" as const,
      initialPolicy: INITIAL_COMPOSER_POLICY,
      events: [] as SessionEvent[],
      sendDestination: () => "queue" as const,
    };
    const first = await renderHook(() => useComposer(SESSION_ID, composerOptions), undefined);

    await flushing(async () =>
      expect(await first.result.current.send("answer after reload")).toBe(true),
    );
    await flush();
    const failed = first.result.current.optimisticMessages?.[0];
    expect(failed).toMatchObject({ destination: "queue", state: "failed", outcomeUnknown: true });
    const clientEventId = sent.input?.clientEventId;
    expect(clientEventId).toBeString();
    await first.unmount();

    const turn = fakeTurn({ id: "abababab-abab-4bab-8bab-abababababab" });
    const accepted = {
      ...makeEvent(23, "user.message", {
        delivery: "steer",
        routing: "accepted_for_steering",
      }),
      clientEventId,
    };
    reconciliationEvents = [
      accepted,
      {
        ...makeEvent(24, "turn.queued", { triggerEventId: accepted.id, turnId: turn.id }),
        turnId: turn.id,
      },
    ];

    const second = await renderHook(() => useComposer(SESSION_ID, composerOptions), undefined);
    const restored = second.result.current.optimisticMessages?.[0];
    expect(restored).toMatchObject({ destination: "queue", state: "failed", outcomeUnknown: true });
    await flushing(() => second.result.current.retryOptimisticMessage?.(restored!.clientEventId));
    await flush();

    expect(second.result.current.optimisticMessages?.[0]).toMatchObject({
      destination: "chat",
      state: "queued",
      outcomeUnknown: false,
      turnId: turn.id,
    });
    await second.unmount();
  });

  test("reconciles a lost queued Send as admitted, then retires it if withdrawn before start", async () => {
    const sent = { input: null as SendMessageInput | null };
    let reconciliationEvents: SessionEvent[] = [];
    const client = fakeClient({
      sendMessage: async (_workspaceId, _sessionId, input) => {
        sent.input = typeof input === "string" ? { text: input } : input;
        throw gatewayError(504);
      },
      listEvents: async () => reconciliationEvents,
    });
    type Props = { events: SessionEvent[] };
    const hook = await renderHook(
      (props: Props) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: INITIAL_COMPOSER_POLICY,
          events: props.events,
          sendDestination: () => "queue",
        }),
      { events: [] as SessionEvent[] },
    );

    await flushing(async () => expect(await hook.result.current.send("run later")).toBe(true));
    await flush();
    const failed = hook.result.current.optimisticMessages?.[0];
    expect(failed).toMatchObject({ state: "failed", outcomeUnknown: true });
    const clientEventId = sent.input?.clientEventId;
    expect(clientEventId).toBeString();
    const turn = fakeTurn({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    const accepted = { ...makeEvent(30, "user.message"), clientEventId };
    const queued = {
      ...makeEvent(31, "turn.queued", { triggerEventId: accepted.id, turnId: turn.id }),
      turnId: turn.id,
    };
    reconciliationEvents = [accepted, queued];

    await flushing(() => hook.result.current.retryOptimisticMessage?.(failed!.clientEventId));
    await flush();
    expect(hook.result.current.optimisticMessages?.[0]).toMatchObject({
      state: "queued",
      destination: "queue",
      turnId: turn.id,
      outcomeUnknown: false,
    });

    await hook.rerender({
      events: [accepted, queued, { ...makeEvent(32, "turn.superseded"), turnId: turn.id }],
    });
    expect(hook.result.current.optimisticMessages).toEqual([]);
    await hook.unmount();
  });

  test("a mutation-confirmed Pause forces the next Send into queue placement", async () => {
    const paused = {
      ...queueSnapshot([]).effectiveControl,
      state: "paused" as const,
      directState: "paused" as const,
      controlVersion: 4,
      controlEtag: "control-4",
    };
    const client = fakeClient({
      pauseSession: async (_workspaceId, _sessionId, _options) => ({
        receipt: promptReceipt(null, "session.paused"),
        effectiveControl: paused,
        interruptionCount: 0,
        wakeCount: 0,
        cancelledSessionCount: 0,
        cancelledTurnCount: 0,
      }),
      sendMessage: async (_workspaceId, _sessionId, input) => ({
        ...makeEvent(40, "user.message"),
        clientEventId: typeof input === "string" ? null : (input.clientEventId ?? null),
      }),
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: INITIAL_COMPOSER_POLICY,
          effectiveControl: queueSnapshot([]).effectiveControl,
          sendDestination: () => "chat",
        }),
      undefined,
    );

    await flushing(async () => await hook.result.current.pause());
    await flushing(async () =>
      expect(await hook.result.current.send("resume with this")).toBe(true),
    );
    await flush();
    expect(hook.result.current.optimisticMessages?.[0]).toMatchObject({
      destination: "queue",
      state: "queued",
    });
    await hook.unmount();
  });

  test("an explicit steer routes the send through steerMessage", async () => {
    const steered: unknown[] = [];
    const client = fakeClient({
      steerMessage: async (_ws, _session, message) => {
        steered.push(message);
        return steerResult();
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flushing(async () => {
      const sent = await hook.result.current.steer("do this immediately");
      expect(sent).toBe(true);
    });
    expect(steered).toHaveLength(1);
    const input = steered[0] as { text: string; clientEventId?: string };
    expect(input.text).toBe("do this immediately");
    expect(typeof input.clientEventId).toBe("string");
    await hook.unmount();
  });

  test("projects Steer immediately, keeps it accepted, then settles when execution starts", async () => {
    let resolveSteer!: (value: SteerMessageResult) => void;
    const pendingSteer = new Promise<SteerMessageResult>((resolve) => {
      resolveSteer = resolve;
    });
    const turn = fakeTurn({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const accepted = makeEvent(10, "user.message", { delivery: "steer" });
    const client = fakeClient({
      steerMessage: async () => await pendingSteer,
    });
    type Props = { events: SessionEvent[] };
    const hook = await renderHook(
      (props: Props) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events: props.events,
        }),
      { events: [] as SessionEvent[] },
    );
    await flush();

    let result!: Promise<boolean>;
    await reactAct(async () => {
      result = hook.result.current.steer("Focus on the authentication failure first");
      await Promise.resolve();
    });
    expect(hook.result.current.steering).toMatchObject({
      phase: "submitting",
      text: "Focus on the authentication failure first",
      turnId: null,
    });

    await reactAct(async () => {
      resolveSteer(steerResult(accepted, turn, { interruptionCount: 1 }));
      expect(await result).toBe(true);
    });
    expect(hook.result.current.steering).toMatchObject({
      phase: "accepted",
      triggerEventId: accepted.id,
      turnId: turn.id,
      stoppingPreviousAttempt: true,
    });
    expect(hook.result.current.stoppingAttempt).toBe("previous");

    await hook.rerender({
      events: [
        accepted,
        {
          ...makeEvent(11, "turn.started", { triggerEventId: accepted.id }),
          turnId: turn.id,
        },
      ],
    });
    expect(hook.result.current.steering).toBeNull();
    expect(hook.result.current.stoppingAttempt).toBeNull();
    await hook.unmount();
  });

  test("does not resurrect physical stopping from an idempotent Steer replay", async () => {
    const client = fakeClient({
      steerMessage: async () =>
        steerResult(
          makeEvent(10, "user.message", { delivery: "steer" }),
          fakeTurn({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
          { interruptionCount: 1, replay: true },
        ),
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();

    await flushing(async () => {
      expect(await hook.result.current.steer("Retry the accepted direction")).toBe(true);
    });
    expect(hook.result.current.steering?.phase).toBe("accepted");
    expect(hook.result.current.stoppingAttempt).toBeNull();
    await hook.unmount();
  });

  test("projects a confirmed Pause immediately while the queue snapshot catches up", async () => {
    const pendingControl = {
      ...queueSnapshot([]).effectiveControl,
      state: "paused" as const,
      directState: "paused" as const,
      controlVersion: 4,
      controlEtag: "control-4",
      settlement: {
        state: "stopping" as const,
        attemptCount: 1,
        interruptionPendingCount: 0,
        quiescencePendingCount: 1,
      },
    };
    const client = fakeClient({
      pauseSession: async () => ({
        receipt: {
          id: crypto.randomUUID(),
          action: "session.paused",
          operationKey: crypto.randomUUID(),
          targetSessionId: SESSION_ID,
          targetTurnId: null,
          appliedControlRevision: 4,
          appliedQueueVersion: null,
          appliedTurnVersion: null,
          appliedDraftRevision: null,
          createdAt: new Date().toISOString(),
        },
        effectiveControl: pendingControl,
        interruptionCount: 1,
        wakeCount: 0,
        cancelledSessionCount: 0,
        cancelledTurnCount: 0,
      }),
    });
    const hook = await renderHook(
      (effectiveControl: SessionQueueSnapshot["effectiveControl"]) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          effectiveControl,
        }),
      queueSnapshot([]).effectiveControl,
    );
    await flush();

    await flushing(async () => await hook.result.current.pause());
    expect(hook.result.current.stoppingAttempt).toBeNull();
    expect(hook.result.current.effectiveControl).toMatchObject({
      state: "paused",
      controlVersion: 4,
    });

    await hook.rerender({ ...pendingControl, settlement: null });
    expect(hook.result.current.effectiveControl?.state).toBe("paused");
    await hook.unmount();
  });

  test("an immediate Resume after Pause binds the mutation-confirmed control version", async () => {
    const active = queueSnapshot([]).effectiveControl;
    const paused = {
      ...active,
      state: "paused" as const,
      directState: "paused" as const,
      controlVersion: 4,
      controlEtag: "control-4",
    };
    const resumed = {
      ...active,
      controlVersion: 5,
      controlEtag: "control-5",
    };
    const resumeEtags: Array<string | undefined> = [];
    const client = fakeClient({
      pauseSession: async () => ({
        receipt: promptReceipt(null, "session.paused"),
        effectiveControl: paused,
        interruptionCount: 0,
        wakeCount: 0,
        cancelledSessionCount: 0,
        cancelledTurnCount: 0,
      }),
      resumeSession: async (_workspaceId, _sessionId, options) => {
        resumeEtags.push(options?.expectedControlEtag);
        return {
          receipt: promptReceipt(null, "session.resumed"),
          effectiveControl: resumed,
          interruptionCount: 0,
          wakeCount: 1,
          cancelledSessionCount: 0,
          cancelledTurnCount: 0,
        };
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          effectiveControl: active,
        }),
      undefined,
    );
    await flush();

    await flushing(async () => await hook.result.current.pause());
    expect(hook.result.current.effectiveControl?.controlEtag).toBe("control-4");
    await flushing(async () => await hook.result.current.resume());

    expect(resumeEtags).toEqual(["control-4"]);
    expect(hook.result.current.effectiveControl?.controlEtag).toBe("control-5");
    await hook.unmount();
  });

  test("replays a lost Pause response once with the same command key", async () => {
    const control = {
      ...queueSnapshot([]).effectiveControl,
      state: "paused" as const,
      directState: "paused" as const,
      controlVersion: 4,
      controlEtag: "control-4",
    };
    const keys: string[] = [];
    const client = fakeClient({
      pauseSession: async (_workspaceId, _sessionId, options) => {
        const clientEventId = options?.clientEventId;
        if (!clientEventId) throw new Error("Pause command key is required");
        keys.push(clientEventId);
        if (keys.length === 1) throw gatewayError(504);
        return {
          receipt: {
            id: crypto.randomUUID(),
            action: "session.paused",
            operationKey: clientEventId,
            targetSessionId: SESSION_ID,
            targetTurnId: null,
            appliedControlRevision: 4,
            appliedQueueVersion: null,
            appliedTurnVersion: null,
            appliedDraftRevision: null,
            createdAt: new Date().toISOString(),
          },
          effectiveControl: control,
          interruptionCount: 1,
          wakeCount: 0,
          cancelledSessionCount: 0,
          cancelledTurnCount: 0,
        };
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          effectiveControl: queueSnapshot([]).effectiveControl,
        }),
      undefined,
    );
    await flush();

    await flushing(async () => await hook.result.current.pause());

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(hook.result.current.pausing).toBe(false);
    expect(hook.result.current.effectiveControl?.state).toBe("paused");
    await hook.unmount();
  });

  test("replaces a confirmed Pause projection with newer control truth", async () => {
    const pendingControl = {
      ...queueSnapshot([]).effectiveControl,
      state: "paused" as const,
      directState: "paused" as const,
      controlVersion: 4,
      controlEtag: "control-4",
      settlement: {
        state: "stopping" as const,
        attemptCount: 1,
        interruptionPendingCount: 0,
        quiescencePendingCount: 1,
      },
    };
    const client = fakeClient({
      pauseSession: async () => ({
        receipt: {
          id: crypto.randomUUID(),
          action: "session.paused",
          operationKey: crypto.randomUUID(),
          targetSessionId: SESSION_ID,
          targetTurnId: null,
          appliedControlRevision: 4,
          appliedQueueVersion: null,
          appliedTurnVersion: null,
          appliedDraftRevision: null,
          createdAt: new Date().toISOString(),
        },
        effectiveControl: pendingControl,
        interruptionCount: 1,
        wakeCount: 0,
        cancelledSessionCount: 0,
        cancelledTurnCount: 0,
      }),
    });
    const hook = await renderHook(
      (effectiveControl: SessionQueueSnapshot["effectiveControl"]) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          effectiveControl,
        }),
      queueSnapshot([]).effectiveControl,
    );
    await flush();

    await flushing(async () => await hook.result.current.pause());
    expect(hook.result.current.effectiveControl?.state).toBe("paused");

    await hook.rerender({
      ...pendingControl,
      state: "active",
      directState: "active",
      controlVersion: 5,
      controlEtag: "control-5",
    });
    expect(hook.result.current.effectiveControl).toMatchObject({
      state: "active",
      controlVersion: 5,
    });
    await hook.unmount();
  });

  test("reconciles a Steer that started before a standalone event stream went live", async () => {
    const turn = fakeTurn({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    let accepted: SessionEvent | null = null;
    let reconciliations = 0;
    const client = fakeClient({
      steerMessage: async (_workspaceId, _sessionId, input) => {
        accepted = {
          ...makeEvent(20, "user.message", { delivery: "steer" }),
          clientEventId: typeof input === "string" ? undefined : input.clientEventId,
        };
        return steerResult(accepted, turn);
      },
      getSession: async () => ({ lastSequence: 21 }) as never,
      listEvents: async () => {
        reconciliations += 1;
        return accepted
          ? [
              accepted,
              {
                ...makeEvent(21, "turn.started", {
                  triggerEventId: accepted.id,
                }),
                turnId: turn.id,
              },
            ]
          : [];
      },
      streamEvents: (_workspaceId, _sessionId, options) =>
        (async function* () {
          options?.onOpen?.();
          yield* [] as SessionEvent[];
        })(),
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          draftPersistence: "disabled",
          initialPolicy: {
            model: "scripted-model",
            reasoningEffort: "medium",
            latencyMode: "standard" as const,
          },
        }),
      undefined,
    );

    await flushing(async () => {
      expect(await hook.result.current.steer("Use the smaller patch")).toBe(true);
    });
    await flush();

    expect(reconciliations).toBe(1);
    expect(hook.result.current.steering).toBeNull();
    await hook.unmount();
  });

  test("removes the optimistic Steer projection when admission fails", async () => {
    const client = fakeClient({
      steerMessage: async () => {
        throw new Error("Steer was rejected");
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    await reactAct(async () => hook.result.current.setValue("Keep this draft"));
    await flushing(async () => {
      expect(await hook.result.current.steer()).toBe(false);
    });
    expect(hook.result.current.steering).toBeNull();
    expect(hook.result.current.value).toBe("Keep this draft");
    expect(hook.result.current.error?.message).toBe("Steer was rejected");
    await hook.unmount();
  });
});

describe("useComposer durable draft and control binding", () => {
  test("a host submit response wins over an older in-flight draft read", async () => {
    const initial: ComposerDraft = {
      revision: 3,
      text: "ship through the host",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    let reads = 0;
    let releaseStaleRead: (() => void) | null = null;
    const staleReadGate = new Promise<void>((resolve) => {
      releaseStaleRead = resolve;
    });
    const base = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        if (reads === 1) return initial;
        await staleReadGate;
        return initial;
      },
    });
    const client = createEmbeddedSessionClient(base, {
      overrides: {
        submitComposerDraft: async (_workspaceId, _sessionId, request) => {
          const turn = fakeTurn({ prompt: request.text });
          return {
            accepted: {
              ...makeEvent(2, "user.message", { text: request.text }),
              clientEventId: request.clientEventId,
            },
            turn,
            draft: {
              ...initial,
              revision: request.expectedDraftRevision + 1,
              text: "",
            },
            receipt: promptReceipt(turn.id),
            routing: "accepted_for_execution",
            interruptionCount: 0,
            replay: false,
          };
        },
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events,
          effectiveControl: queueSnapshot([]).effectiveControl,
        }),
      noEvents,
    );
    await flush();
    expect(hook.result.current.value).toBe(initial.text);

    await hook.rerender([makeEvent(1, "session.queue.changed", { operation: "edit" })]);
    await flush();
    expect(reads).toBe(2);

    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    expect(hook.result.current.draftRevision).toBe(4);
    expect(hook.result.current.value).toBe("");

    await flushing(async () => {
      releaseStaleRead!();
      await staleReadGate;
    });
    await flush();
    expect(hook.result.current.draftRevision).toBe(4);
    expect(hook.result.current.value).toBe("");
    await hook.unmount();
  });

  test("historical feed hydration reconciles once without replaying every old event", async () => {
    let reads = 0;
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        return {
          revision: reads,
          text: `read-${reads}`,
          resources: [],
          model: "model-x",
          reasoningEffort: "medium",
          latencyMode: "standard" as const,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        } satisfies ComposerDraft;
      },
    });
    const historical = Array.from({ length: 1_000 }, (_, index) =>
      makeEvent(index + 1, "session.queue.changed", { operation: "edit" }),
    );
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      noEvents,
    );
    await flush();
    expect(reads).toBe(1);

    await hook.rerender(historical);
    await flush();
    expect(reads).toBe(2);

    await hook.rerender([
      ...historical,
      makeEvent(1_001, "session.queue.changed", { operation: "edit" }),
    ]);
    await flush();
    expect(reads).toBe(3);
    await hook.unmount();
  });

  test("soft draft reload after settle does not assert draftLoading", async () => {
    let reads = 0;
    let releaseSecond: (() => void) | null = null;
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        if (reads === 2) {
          await new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
        }
        return {
          revision: reads,
          text: `read-${reads}`,
          resources: [],
          model: "model-x",
          reasoningEffort: "medium",
          latencyMode: "standard" as const,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        } satisfies ComposerDraft;
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      noEvents,
    );
    await flush();
    expect(reads).toBe(1);
    expect(hook.result.current.draftLoading).toBe(false);

    // Reconcile / queue-changed soft reload (loadOlder SSE reconnect path).
    await hook.rerender([makeEvent(1, "session.queue.changed", { operation: "edit" })]);
    await flush();
    expect(reads).toBe(2);
    expect(hook.result.current.draftLoading).toBe(false);
    expect(releaseSecond).not.toBeNull();
    // Soft reload must not flip draftLoading. Resolve + settle under one act so
    // the deferred read's setState commits never escape the warning-free gate.
    await flushing(async () => {
      releaseSecond!();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.draftLoading).toBe(false);
    expect(hook.result.current.value).toBe("read-2");
    await hook.unmount();
  });

  test("explicit reloadDraft still asserts draftLoading while in flight", async () => {
    let reads = 0;
    let releaseReload: (() => void) | null = null;
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        if (reads === 2) {
          await new Promise<void>((resolve) => {
            releaseReload = resolve;
          });
        }
        return {
          revision: reads,
          text: `read-${reads}`,
          resources: [],
          model: "model-x",
          reasoningEffort: "medium",
          latencyMode: "standard" as const,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        } satisfies ComposerDraft;
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.draftLoading).toBe(false);

    let reloadDone: Promise<void> = Promise.resolve();
    await flushing(() => {
      reloadDone = hook.result.current.reloadDraft();
    });
    // In-flight hard reload must blank the picker (unlike soft reconcile).
    expect(hook.result.current.draftLoading).toBe(true);
    expect(reads).toBe(2);
    expect(releaseReload).not.toBeNull();
    // Resolving outside act was the clean-gate failure: draft setState escaped.
    await flushing(async () => {
      releaseReload!();
      await reloadDone;
    });
    expect(hook.result.current.draftLoading).toBe(false);
    await hook.unmount();
  });

  test("policy stays unavailable until the exact durable draft hydrates", async () => {
    let resolveDraft!: (draft: ComposerDraft) => void;
    const client = fakeClient({
      getComposerDraft: async () =>
        await new Promise<ComposerDraft>((resolve) => {
          resolveDraft = resolve;
        }),
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flush();
    expect(hook.result.current.policy).toBeNull();
    expect(hook.result.current.canSend).toBe(false);
    await flushing(() => hook.result.current.setLatencyMode("fast"));
    expect(hook.result.current.policy).toBeNull();
    await flushing(async () => {
      resolveDraft({
        revision: 1,
        text: "restored text",
        resources: [],
        model: "model-x",
        reasoningEffort: "medium",
        latencyMode: "standard" as const,
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: new Date().toISOString(),
      });
      await Promise.resolve();
    });

    expect(hook.result.current.value).toBe("restored text");
    expect(hook.result.current.policy).toEqual({
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
    });
    await hook.unmount();
  });

  test("durable policy hydration does not trigger a write-back", async () => {
    let resolveDraft!: (draft: ComposerDraft) => void;
    const saved: unknown[] = [];
    const client = fakeClient({
      getComposerDraft: async () =>
        await new Promise<ComposerDraft>((resolve) => {
          resolveDraft = resolve;
        }),
      saveComposerDraft: async (_workspaceId, _sessionId, request) => {
        saved.push(request);
        return {
          revision: request.expectedRevision + 1,
          text: request.text,
          resources: request.resources,
          annotations: request.annotations ?? [],
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          latencyMode: request.latencyMode,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        } satisfies ComposerDraft;
      },
    });
    const remoteDraft: ComposerDraft = {
      revision: 7,
      text: "durable draft",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );

    await flush();
    await flushing(async () => {
      resolveDraft(remoteDraft);
      await Promise.resolve();
    });
    await flush(600);

    expect(hook.result.current.value).toBe("durable draft");
    expect(hook.result.current.policy?.latencyMode).toBe("standard");
    expect(saved).toEqual([]);
    await hook.unmount();
  });

  test("typing before first hydrate still autosaves against the fetched OCC base", async () => {
    let resolveDraft!: (draft: ComposerDraft) => void;
    const saved: Array<{ text: string; model: string; expectedRevision: number }> = [];
    const client = fakeClient({
      getComposerDraft: async () =>
        await new Promise<ComposerDraft>((resolve) => {
          resolveDraft = resolve;
        }),
      saveComposerDraft: async (_workspaceId, _sessionId, request) => {
        saved.push({
          text: request.text,
          model: request.model,
          expectedRevision: request.expectedRevision,
        });
        return {
          revision: request.expectedRevision + 1,
          text: request.text,
          resources: request.resources,
          annotations: request.annotations ?? [],
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          latencyMode: request.latencyMode,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        } satisfies ComposerDraft;
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.draftLoading).toBe(true);
    await flushing(() => hook.result.current.setValue("Typed before the draft read returned"));
    await flushing(async () => {
      resolveDraft({
        revision: 0,
        text: "",
        resources: [],
        model: "scripted-model",
        reasoningEffort: "medium",
        latencyMode: "standard",
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: null,
      });
      await Promise.resolve();
    });
    await flush(600);
    expect(hook.result.current.value).toBe("Typed before the draft read returned");
    expect(hook.result.current.policy).toEqual({
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
    });
    expect(saved).toEqual([
      {
        text: "Typed before the draft read returned",
        model: "scripted-model",
        expectedRevision: 0,
      },
    ]);
    await hook.unmount();
  });

  test("history already present at mount is treated as a projection, not live traffic", async () => {
    let reads = 0;
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        return {
          revision: reads,
          text: `read-${reads}`,
          resources: [],
          model: "model-x",
          reasoningEffort: "medium",
          latencyMode: "standard" as const,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        } satisfies ComposerDraft;
      },
    });
    const historical = Array.from({ length: 1_000 }, (_, index) =>
      makeEvent(index + 1, "session.queue.changed", { operation: "edit" }),
    );
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      historical,
    );
    await flush();
    expect(reads).toBe(1);
    await hook.unmount();
  });

  test("same-revision soft reloads do not republish decoded draft state", async () => {
    let reads = 0;
    const authoritative: ComposerDraft = {
      revision: 7,
      text: "settled draft",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        return { ...authoritative, resources: [] };
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      noEvents,
    );
    await flush();
    const firstProjection = hook.result.current.draft;
    expect(firstProjection?.revision).toBe(7);

    await hook.rerender([makeEvent(1, "session.queue.changed", { operation: "edit" })]);
    await flush();

    expect(reads).toBe(2);
    expect(hook.result.current.draft).toBe(firstProjection);
    await hook.unmount();
  });

  test("rerenders do not reload drafts outside target, explicit, or event triggers", async () => {
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const reads: string[] = [];
    const client = fakeClient({
      getComposerDraft: async (_workspaceId, sessionId) => {
        reads.push(sessionId);
        return {
          revision: reads.length,
          text: `${sessionId}:read-${reads.length}`,
          resources: [],
          model: "model-x",
          reasoningEffort: "medium",
          latencyMode: "standard" as const,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: new Date().toISOString(),
        } satisfies ComposerDraft;
      },
    });
    type Props = {
      sessionId: string;
      policyVersion: number;
      events: SessionEvent[];
    };
    const hook = await renderHook(
      (props: Props) =>
        useComposer(props.sessionId, {
          client,
          workspaceId: WORKSPACE_ID,
          events: props.events,
        }),
      { sessionId: SESSION_ID, policyVersion: 0, events: noEvents },
    );
    await flush();
    expect(reads).toEqual([SESSION_ID]);
    expect(hook.result.current.value).toBe(`${SESSION_ID}:read-1`);

    await hook.rerender({
      sessionId: SESSION_ID,
      policyVersion: 1,
      events: noEvents,
    });
    await hook.rerender({
      sessionId: SESSION_ID,
      policyVersion: 2,
      events: noEvents,
    });
    await flush();
    expect(reads).toEqual([SESSION_ID]);

    await flushing(async () => await hook.result.current.reloadDraft());
    expect(reads).toEqual([SESSION_ID, SESSION_ID]);
    expect(hook.result.current.value).toBe(`${SESSION_ID}:read-2`);

    await hook.rerender({
      sessionId: SESSION_ID,
      policyVersion: 3,
      events: [makeEvent(1, "session.queue.changed", { operation: "edit" })],
    });
    await flush();
    expect(reads).toEqual([SESSION_ID, SESSION_ID, SESSION_ID]);
    expect(hook.result.current.value).toBe(`${SESSION_ID}:read-3`);

    await hook.rerender({
      sessionId: sessionB,
      policyVersion: 4,
      events: noEvents,
    });
    await flush();
    expect(reads).toEqual([SESSION_ID, SESSION_ID, SESSION_ID, sessionB]);
    expect(hook.result.current.value).toBe(`${sessionB}:read-4`);
    await hook.unmount();
  });

  test("a live queue mutation reloads the authoritative draft in another tab", async () => {
    let current: ComposerDraft = {
      revision: 1,
      text: "first tab state",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    let reads = 0;
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        return current;
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      noEvents,
    );
    await flush();
    expect(hook.result.current.value).toBe("first tab state");

    current = {
      ...current,
      revision: 2,
      text: "withdrawn queue prompt",
      sourceTurnId: "33333333-3333-4333-8333-333333333333",
      sourceTurnVersion: 1,
    };
    await hook.rerender([
      makeEvent(1, "session.queue.changed", {
        operation: "edit",
        queueVersion: 2,
      }),
    ]);
    await flush();
    expect(reads).toBe(2);
    expect(hook.result.current.value).toBe("withdrawn queue prompt");
    await hook.unmount();
  });

  test("hydrates, autosaves with OCC, and sends the acknowledged draft/control revision", async () => {
    const saved: unknown[] = [];
    const sent: unknown[] = [];
    const initial = {
      revision: 4,
      text: "restored text",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium" as const,
      latencyMode: "fast" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => initial,
      saveComposerDraft: async (_ws, _session, request) => {
        saved.push(request);
        return {
          ...initial,
          ...request,
          revision: request.expectedRevision + 1,
        };
      },
      sendMessage: async (_ws, _session, input) => {
        sent.push(input);
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          effectiveControl: queueSnapshot([]).effectiveControl,
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.value).toBe("restored text");
    await flushing(async () => hook.result.current.setValue("edited locally"));
    await flush(600);
    expect(saved.at(-1)).toMatchObject({
      expectedRevision: 4,
      text: "edited locally",
      latencyMode: "fast",
    });
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    expect(sent.at(-1)).toMatchObject({
      text: "edited locally",
      expectedDraftRevision: 5,
      controlEtag: "control-3",
      latencyMode: "fast",
    });
    await hook.unmount();
  });

  test("editing and re-sending a queued prompt cannot resurrect its submitted draft", async () => {
    let serverDraft: ComposerDraft = {
      revision: 0,
      text: "",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: null,
    };
    const accepted: SessionEvent[] = [];
    const turns: SessionTurn[] = [];
    const savesAfterSecondSubmit: string[] = [];
    let submissions = 0;
    const client = fakeClient({
      getComposerDraft: async () => serverDraft,
      saveComposerDraft: async (_workspaceId, _sessionId, request) => {
        if (submissions >= 2) savesAfterSecondSubmit.push(request.text);
        serverDraft = {
          ...serverDraft,
          ...request,
          revision: serverDraft.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        return serverDraft;
      },
      submitComposerDraft: async (_workspaceId, _sessionId, request) => {
        submissions += 1;
        const turn = fakeTurn({ id: crypto.randomUUID(), prompt: request.text });
        const event = {
          ...makeEvent(submissions * 10, "user.message", { text: request.text }),
          clientEventId: request.clientEventId,
        };
        accepted.push(event);
        turns.push(turn);
        serverDraft = {
          ...serverDraft,
          revision: request.expectedDraftRevision + 1,
          text: "",
          resources: [],
          sourceTurnId: null,
          sourceTurnVersion: null,
        };
        return {
          accepted: event,
          turn,
          draft: serverDraft,
          receipt: promptReceipt(turn.id),
          routing: "queued_for_execution" as const,
          interruptionCount: 0,
          replay: false,
        };
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          events,
          effectiveControl: queueSnapshot([], {
            effectiveControl: {
              ...queueSnapshot([]).effectiveControl,
              state: "paused",
              directState: "paused",
            },
          }).effectiveControl,
        }),
      noEvents,
    );
    await flush();

    await flushing(() => hook.result.current.setValue("edited queued prompt"));
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    expect(submissions).toBe(1);

    serverDraft = {
      ...serverDraft,
      revision: serverDraft.revision + 1,
      text: "edited queued prompt",
      sourceTurnId: turns[0]!.id,
      sourceTurnVersion: turns[0]!.version,
    };
    await flushing(() => hook.result.current.applyDraft(serverDraft));
    await hook.rerender([
      accepted[0]!,
      {
        ...makeEvent(11, "turn.queued", { turnId: turns[0]!.id }),
        turnId: turns[0]!.id,
      },
      makeEvent(12, "session.queue.changed", {
        operation: "edit",
        turnId: turns[0]!.id,
      }),
    ]);
    await flush();
    expect(hook.result.current.optimisticMessages).toEqual([]);

    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    expect(submissions).toBe(2);
    await hook.rerender([
      accepted[0]!,
      makeEvent(12, "session.queue.changed", {
        operation: "edit",
        turnId: turns[0]!.id,
      }),
      accepted[1]!,
      {
        ...makeEvent(21, "turn.queued", { turnId: turns[1]!.id }),
        turnId: turns[1]!.id,
      },
      { ...makeEvent(22, "turn.completed"), turnId: turns[1]!.id },
    ]);
    await flush(650);

    expect(hook.result.current.value).toBe("");
    expect(serverDraft.text).toBe("");
    expect(savesAfterSecondSubmit).toEqual([]);
    await hook.unmount();
  });

  test("a reconnect does not duplicate a ready file across the durable draft and live attachment", async () => {
    const fileId = "33333333-3333-4333-8333-333333333333";
    const canonicalFile = {
      kind: "file" as const,
      mountPath: `.opengeni/files/${fileId}`,
      fileId,
    };
    let serverDraft: ComposerDraft = {
      revision: 0,
      text: "",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: null,
    };
    const canonicalizeResources = (
      resources: ComposerDraft["resources"],
    ): ComposerDraft["resources"] =>
      resources.map((resource) =>
        resource.kind === "file"
          ? {
              kind: "file" as const,
              mountPath: resource.mountPath ?? `.opengeni/files/${resource.fileId}`,
              fileId: resource.fileId,
            }
          : resource,
      );
    const admissionMismatches: string[] = [];
    const client = fakeClient({
      getComposerDraft: async () => serverDraft,
      saveComposerDraft: async (_workspaceId, _sessionId, request) => {
        expect(request.expectedRevision).toBe(serverDraft.revision);
        serverDraft = {
          ...serverDraft,
          ...request,
          revision: serverDraft.revision + 1,
          resources: canonicalizeResources(request.resources),
          updatedAt: new Date().toISOString(),
        };
        return serverDraft;
      },
      sendMessage: async (_workspaceId, _sessionId, input) => {
        const submitted = input as SendMessageInput;
        const normalizedResources = canonicalizeResources(submitted.resources ?? []).filter(
          (resource, index, resources) =>
            resources.findIndex(
              (candidate) => JSON.stringify(candidate) === JSON.stringify(resource),
            ) === index,
        );
        const savedContent = JSON.stringify({
          text: serverDraft.text,
          resources: serverDraft.resources,
          model: serverDraft.model,
          reasoningEffort: serverDraft.reasoningEffort,
        });
        const submittedContent = JSON.stringify({
          text: submitted.text,
          resources: normalizedResources,
          model: submitted.model ?? "model-x",
          reasoningEffort: submitted.reasoningEffort ?? "medium",
        });
        if (
          submitted.expectedDraftRevision === serverDraft.revision &&
          savedContent !== submittedContent
        ) {
          admissionMismatches.push("Submitted content is not the saved draft");
          throw new Error("Submitted content is not the saved draft");
        }
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({
            resources: [{ kind: "file", fileId }],
          }),
        }),
      undefined,
    );
    await flush();

    await flushing(() => hook.result.current.setValue("Inspect the attached image."));
    await flush(600);
    expect(serverDraft).toMatchObject({
      revision: 1,
      resources: [canonicalFile],
    });

    // Reconnect reconciliation reloads the canonical server resource while
    // the browser-local ready attachment card still supplies its bare ref.
    await flushing(async () => await hook.result.current.reloadDraft());
    expect(hook.result.current.restoredResources).toEqual([canonicalFile]);

    let accepted = false;
    await flushing(async () => {
      accepted = await hook.result.current.send();
    });

    expect({ accepted, admissionMismatches }).toEqual({
      accepted: true,
      admissionMismatches: [],
    });
    await hook.unmount();
  });

  for (const delivery of ["send", "steer"] as const) {
    test(`${delivery} preserves the exact autosaved draft text`, async () => {
      const submitted: string[] = [];
      const initial: ComposerDraft = {
        revision: 4,
        text: "",
        resources: [],
        model: "model-x",
        reasoningEffort: "medium",
        latencyMode: "standard" as const,
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: new Date().toISOString(),
      };
      const client = fakeClient({
        getComposerDraft: async () => initial,
        saveComposerDraft: async (_ws, _session, request) => ({
          ...initial,
          text: request.text,
          resources: request.resources,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          revision: request.expectedRevision + 1,
        }),
        sendMessage: async (_ws, _session, input) => {
          submitted.push((input as { text: string }).text);
          return makeEvent(1, "user.message");
        },
        steerMessage: async (_ws, _session, input) => {
          submitted.push((input as { text: string }).text);
          return steerResult();
        },
      });
      const hook = await renderHook(
        () =>
          useComposer(SESSION_ID, {
            client,
            workspaceId: WORKSPACE_ID,
          }),
        undefined,
      );
      await flush();
      const exactText = "  first line\nsecond line\n\n";
      await flushing(async () => hook.result.current.setValue(exactText));
      await flush(600);
      await flushing(async () => expect(await hook.result.current[delivery]()).toBe(true));
      expect(submitted).toEqual([exactText]);
      await hook.unmount();
    });
  }

  test("durable Send forwards personal-resource intent and a definitive epoch retry requires fresh confirmed extras", async () => {
    let serverDraft: ComposerDraft = {
      revision: 4,
      text: "use my fixed environment",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const attempts: Array<Pick<SendMessageInput, "personalResourceAttachment" | "clientEventId">> =
      [];
    const failures: Array<{ input: SendMessageInput; delivery: string }> = [];
    let epoch = 3;
    let confirmed = true;
    const client = fakeClient({
      getComposerDraft: async () => serverDraft,
      saveComposerDraft: async (_workspaceId, _sessionId, request) => {
        serverDraft = {
          ...serverDraft,
          ...request,
          revision: request.expectedRevision + 1,
          updatedAt: new Date().toISOString(),
        };
        return serverDraft;
      },
      submitComposerDraft: async (_workspaceId, _sessionId, request) => {
        attempts.push(request);
        if (attempts.length === 1) throw personalAttachmentConflict();
        const turn = fakeTurn();
        return {
          accepted: makeEvent(2, "user.message"),
          turn,
          draft: { ...serverDraft, revision: request.expectedDraftRevision + 1, text: "" },
          receipt: promptReceipt(turn.id),
          routing: "accepted_for_execution",
          interruptionCount: 0,
          replay: false,
        };
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({
            personalResourceAttachment: {
              mode: "session",
              expectedAuthorityEpoch: epoch,
              workspaceSharedAcknowledged: true,
              sharedOutputWarningVersion: 1,
            },
          }),
          sendBlocked: () => !confirmed,
          onDeliveryError: (_error, input, delivery) => {
            failures.push({ input, delivery });
            confirmed = false;
          },
        }),
      undefined,
    );
    await flush();
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    expect(attempts[0]?.personalResourceAttachment?.expectedAuthorityEpoch).toBe(3);
    expect(failures).toEqual([{ input: expect.any(Object), delivery: "send" }]);
    const failed = hook.result.current.optimisticMessages?.find(
      (message) => message.state === "failed",
    );
    expect(failed).toBeDefined();

    await flushing(() => hook.result.current.retryOptimisticMessage?.(failed!.clientEventId));
    expect(attempts).toHaveLength(1);
    epoch = 4;
    confirmed = true;
    await flushing(() => hook.result.current.retryOptimisticMessage?.(failed!.clientEventId));
    await flush();

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.personalResourceAttachment?.expectedAuthorityEpoch).toBe(4);
    expect(attempts[1]?.clientEventId).not.toBe(attempts[0]?.clientEventId);
    await hook.unmount();
  });

  test("a whitespace-only file message saves and submits the same placeholder", async () => {
    const savedTexts: string[] = [];
    const submittedTexts: string[] = [];
    const resource = {
      kind: "file" as const,
      fileId: "33333333-3333-4333-8333-333333333333",
    };
    const initial: ComposerDraft = {
      revision: 1,
      text: "",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => initial,
      saveComposerDraft: async (_ws, _session, request) => {
        savedTexts.push(request.text);
        return {
          ...initial,
          text: request.text,
          resources: request.resources,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          revision: request.expectedRevision + 1,
        };
      },
      sendMessage: async (_ws, _session, input) => {
        submittedTexts.push((input as { text: string }).text);
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: {
            resources: [resource],
          },
        }),
      undefined,
    );
    await flush();
    await flushing(async () => hook.result.current.setValue(" \n"));
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    expect(savedTexts.at(-1)).toBe(FILE_ONLY_MESSAGE_TEXT);
    expect(submittedTexts).toEqual([FILE_ONLY_MESSAGE_TEXT]);
    await hook.unmount();
  });

  test("a transient draft save preserves text and resources without claiming a cross-tab conflict", async () => {
    const resource = {
      kind: "file" as const,
      fileId: "33333333-3333-4333-8333-333333333333",
    };
    const initial: ComposerDraft = {
      revision: 4,
      text: "local draft",
      resources: [resource],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => initial,
      saveComposerDraft: async () => {
        throw gatewayError(503);
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    await flushing(() => hook.result.current.setValue("local edit survives"));
    await flush(600);

    expect(hook.result.current.value).toBe("local edit survives");
    expect(hook.result.current.restoredResources).toEqual([resource]);
    expect(hook.result.current.draftConflict).toBeNull();
    expect(hook.result.current.error).toMatchObject({
      status: 503,
      retryable: true,
      outcomeUnknown: true,
    });
    expect(hook.result.current.error?.message).toBe(
      "OpenGeni is temporarily unavailable — retry. Reference: edge-503-safe.",
    );
    await hook.unmount();
  });

  test("retryable draft hydrate failures stay bounded across client identity churn", async () => {
    let reads = 0;
    const failingClient = () =>
      fakeClient({
        getComposerDraft: async () => {
          reads += 1;
          throw gatewayError(503);
        },
      });
    const hook = await renderHook(
      (client: ReturnType<typeof failingClient>) =>
        useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      failingClient(),
    );
    await flush();
    expect(reads).toBe(1);

    for (let index = 0; index < 10; index += 1) {
      await hook.rerender(failingClient());
    }
    await flush();

    expect(reads).toBe(1);
    expect(hook.result.current.error).toMatchObject({ status: 503, retryable: true });
    await hook.unmount();
  });

  test("a failed draft reload never replaces newer local text or restored resources", async () => {
    const resource = {
      kind: "file" as const,
      fileId: "44444444-4444-4444-8444-444444444444",
    };
    const initial: ComposerDraft = {
      revision: 2,
      text: "server draft",
      resources: [resource],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    let reads = 0;
    const client = fakeClient({
      getComposerDraft: async () => {
        reads += 1;
        if (reads === 1) return initial;
        throw gatewayError(504);
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    await flushing(() => hook.result.current.setValue("newer unsaved local edit"));
    await flushing(async () => await hook.result.current.reloadDraft());

    expect(hook.result.current.value).toBe("newer unsaved local edit");
    expect(hook.result.current.restoredResources).toEqual([resource]);
    expect(hook.result.current.error?.message).not.toContain("html");
    expect(hook.result.current.error?.message.length).toBeLessThan(160);
    await hook.unmount();
  });

  for (const delivery of ["send", "steer"] as const) {
    test(`${delivery} preserves its draft and file after a definite payment rejection, then retries once with Codex`, async () => {
      const resource = {
        kind: "file" as const,
        fileId: "55555555-5555-4555-8555-555555555555",
      };
      let serverDraft: ComposerDraft = {
        revision: 7,
        text: "read the exact attached bytes",
        resources: [resource],
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        latencyMode: "standard" as const,
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: new Date().toISOString(),
      };
      const attempts: SendMessageInput[] = [];
      let accepted = 0;
      const deliver = async (input: string | SendMessageInput) => {
        const typed = typeof input === "string" ? { text: input } : input;
        attempts.push(typed);
        if (attempts.length === 1) throw paymentRequiredError();
        accepted += 1;
        return makeEvent(1, "user.message");
      };
      const client = fakeClient({
        getComposerDraft: async () => serverDraft,
        saveComposerDraft: async (_workspaceId, _sessionId, request) => {
          serverDraft = {
            ...serverDraft,
            ...request,
            revision: request.expectedRevision + 1,
            updatedAt: new Date().toISOString(),
          };
          return serverDraft;
        },
        sendMessage: async (_workspaceId, _sessionId, input) => await deliver(input),
        steerMessage: async (_workspaceId, _sessionId, input) => steerResult(await deliver(input)),
      });
      const hook = await renderHook(
        () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      await flush();

      await flushing(async () =>
        expect(await hook.result.current[delivery]()).toBe(delivery === "send"),
      );
      await flush();
      if (delivery === "send") {
        expect(hook.result.current.value).toBe("");
        expect(hook.result.current.restoredResources).toEqual([]);
        expect(
          hook.result.current.optimisticMessages?.find(
            (message) =>
              message.resources[0]?.kind === "file" &&
              message.resources[0].fileId === resource.fileId,
          ),
        ).toMatchObject({
          state: "failed",
          resources: [resource],
          outcomeUnknown: false,
        });
      } else {
        expect(hook.result.current.error).toMatchObject({
          status: 402,
          code: "payment_required",
          retryable: false,
          outcomeUnknown: false,
        });
        expect(hook.result.current.value).toBe(serverDraft.text);
        expect(hook.result.current.restoredResources).toEqual([resource]);
      }
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        text: "read the exact attached bytes",
        resources: [resource],
        model: "gpt-5.6-sol",
      });

      await flushing(() => hook.result.current.setModel("codex/gpt-5.6-sol"));
      if (delivery === "send") {
        const failed = hook.result.current.optimisticMessages?.find(
          (message) =>
            message.resources[0]?.kind === "file" &&
            message.resources[0].fileId === resource.fileId,
        );
        expect(failed).toBeDefined();
        await flushing(() => hook.result.current.retryOptimisticMessage?.(failed!.clientEventId));
        await flush();
      } else {
        await flushing(async () => expect(await hook.result.current[delivery]()).toBe(true));
      }

      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toMatchObject({
        text: "read the exact attached bytes",
        resources: [resource],
        // Send retries the frozen failed operation; a rejected Steer restores
        // the composer, so the next explicit Steer uses its newly selected policy.
        model: delivery === "send" ? "gpt-5.6-sol" : "codex/gpt-5.6-sol",
      });
      expect(attempts[1]!.clientEventId).not.toBe(attempts[0]!.clientEventId);
      expect(accepted).toBe(1);
      expect(hook.result.current.value).toBe("");
      expect(hook.result.current.restoredResources).toEqual([]);
      await hook.unmount();
    });
  }

  for (const delivery of ["send", "steer"] as const) {
    test(`${delivery} retries an outcome-unknown gateway failure with one idempotency key`, async () => {
      const resource = {
        kind: "file" as const,
        fileId: "55555555-5555-4555-8555-555555555555",
      };
      const initial: ComposerDraft = {
        revision: 7,
        text: "do not duplicate this",
        resources: [resource],
        model: "model-x",
        reasoningEffort: "medium",
        latencyMode: "standard" as const,
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: new Date().toISOString(),
      };
      const attempts: SendMessageInput[] = [];
      const deliver = async (input: string | SendMessageInput) => {
        const typed = typeof input === "string" ? { text: input } : input;
        attempts.push(typed);
        if (attempts.length === 1) throw gatewayError(502);
        return makeEvent(1, "user.message");
      };
      const client = fakeClient({
        getComposerDraft: async () => initial,
        sendMessage: async (_workspaceId, _sessionId, input) => await deliver(input),
        steerMessage: async (_workspaceId, _sessionId, input) => steerResult(await deliver(input)),
      });
      const hook = await renderHook(
        () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      await flush();

      await flushing(async () =>
        expect(await hook.result.current[delivery]()).toBe(delivery === "send"),
      );
      await flush();
      if (delivery === "send") {
        const failed = hook.result.current.optimisticMessages?.find(
          (message) => message.outcomeUnknown,
        );
        expect(failed).toMatchObject({ state: "failed", outcomeUnknown: true });
        await flushing(() => hook.result.current.retryOptimisticMessage?.(failed!.clientEventId));
        await flush();
      } else {
        expect(hook.result.current.value).toBe(initial.text);
        expect(hook.result.current.restoredResources).toEqual([resource]);
        expect(hook.result.current.error).toMatchObject({
          outcomeUnknown: true,
        });
        await flushing(async () => expect(await hook.result.current[delivery]()).toBe(true));
      }
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.clientEventId).toBe(attempts[1]!.clientEventId);
      expect(attempts[0]!.resources).toEqual([resource]);
      expect(hook.result.current.value).toBe("");
      expect(hook.result.current.restoredResources).toEqual([]);
      await hook.unmount();
    });
  }

  test("Send preserves an uncertain mutation when its reconciliation read fails", async () => {
    const initial: ComposerDraft = {
      revision: 7,
      text: "do not duplicate accepted work",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const attempts: SendMessageInput[] = [];
    const deliveryFailures: Error[] = [];
    let reconciliationReads = 0;
    let failReconciliation = true;
    const client = fakeClient({
      getComposerDraft: async () => initial,
      listEvents: async () => {
        reconciliationReads += 1;
        if (failReconciliation) throw new TypeError("event reconciliation unavailable");
        return [];
      },
      sendMessage: async (_workspaceId, _sessionId, input) => {
        const typed = typeof input === "string" ? { text: input } : input;
        attempts.push(typed);
        if (attempts.length === 1) throw gatewayError(503);
        return makeEvent(2, "user.message");
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          onDeliveryError: (error) => deliveryFailures.push(error),
        }),
      undefined,
    );
    await flush();

    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    await flush();
    const uncertain = hook.result.current.optimisticMessages?.find(
      (message) => message.outcomeUnknown,
    );
    expect(uncertain).toBeDefined();
    const originalClientEventId = uncertain!.clientEventId;

    await flushing(() => hook.result.current.retryOptimisticMessage?.(originalClientEventId));
    await flush();
    expect({ reconciliationReads, mutationAttempts: attempts.length }).toEqual({
      reconciliationReads: 1,
      mutationAttempts: 1,
    });
    expect(deliveryFailures).toHaveLength(1);
    expect(
      hook.result.current.optimisticMessages?.find(
        (message) => message.clientEventId === originalClientEventId,
      ),
    ).toMatchObject({ state: "failed", outcomeUnknown: true });

    failReconciliation = false;
    await flushing(() => hook.result.current.retryOptimisticMessage?.(originalClientEventId));
    await flush();
    expect(reconciliationReads).toBe(2);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.clientEventId).toBe(originalClientEventId);
    expect(
      hook.result.current.optimisticMessages?.find(
        (message) => message.clientEventId === originalClientEventId,
      ),
    ).toBeUndefined();
    await hook.unmount();
  });

  for (const delivery of ["send", "steer"] as const) {
    test(`${delivery} turns an uncertain retry's definitive personal denial into a fresh reconfirmed operation`, async () => {
      const initial: ComposerDraft = {
        revision: 8,
        text: "use my personal setup once",
        resources: [],
        model: "model-x",
        reasoningEffort: "medium",
        latencyMode: "standard" as const,
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: new Date().toISOString(),
      };
      const attempts: SendMessageInput[] = [];
      let epoch = 3;
      let confirmed = true;
      const deliver = async (input: string | SendMessageInput) => {
        const typed = typeof input === "string" ? { text: input } : input;
        attempts.push(typed);
        if (attempts.length === 1) throw gatewayError(503);
        if (attempts.length === 2) throw personalAttachmentConflict();
        return makeEvent(3, "user.message");
      };
      const client = fakeClient({
        getComposerDraft: async () => initial,
        listEvents: async () => [],
        sendMessage: async (_workspaceId, _sessionId, input) => await deliver(input),
        steerMessage: async (_workspaceId, _sessionId, input) => steerResult(await deliver(input)),
      });
      const hook = await renderHook(
        () =>
          useComposer(SESSION_ID, {
            client,
            workspaceId: WORKSPACE_ID,
            sendExtras: () => ({
              personalResourceAttachment: {
                mode: "session",
                expectedAuthorityEpoch: epoch,
                workspaceSharedAcknowledged: true,
                sharedOutputWarningVersion: 1,
              },
            }),
            sendBlocked: () => !confirmed,
            onDeliveryError: (error) => {
              if ((error as OpenGeniApiError).outcomeUnknown !== true) confirmed = false;
            },
          }),
        undefined,
      );
      await flush();

      await flushing(async () =>
        expect(await hook.result.current[delivery]()).toBe(delivery === "send"),
      );
      await flush();
      const firstId = attempts[0]!.clientEventId;
      if (delivery === "send") {
        const uncertain = hook.result.current.optimisticMessages?.find(
          (message) => message.outcomeUnknown,
        );
        expect(uncertain).toBeDefined();
        await flushing(() =>
          hook.result.current.retryOptimisticMessage?.(uncertain!.clientEventId),
        );
        await flush();
      } else {
        await flushing(async () => expect(await hook.result.current.steer()).toBe(false));
      }
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.clientEventId).toBe(firstId);
      expect(attempts[1]!.personalResourceAttachment?.expectedAuthorityEpoch).toBe(3);
      expect(confirmed).toBe(false);

      if (delivery === "send") {
        const definitive = hook.result.current.optimisticMessages?.find(
          (message) => message.clientEventId === firstId,
        );
        expect(definitive).toMatchObject({ state: "failed", outcomeUnknown: false });
        await flushing(() =>
          hook.result.current.retryOptimisticMessage?.(definitive!.clientEventId),
        );
      } else {
        await flushing(async () => expect(await hook.result.current.steer()).toBe(false));
      }
      expect(attempts).toHaveLength(2);

      epoch = 4;
      confirmed = true;
      if (delivery === "send") {
        const definitive = hook.result.current.optimisticMessages?.find(
          (message) => message.clientEventId === firstId,
        );
        await flushing(() =>
          hook.result.current.retryOptimisticMessage?.(definitive!.clientEventId),
        );
        await flush();
      } else {
        await flushing(async () => expect(await hook.result.current.steer()).toBe(true));
      }

      expect(attempts).toHaveLength(3);
      expect(attempts[2]!.clientEventId).not.toBe(firstId);
      expect(attempts[2]!.personalResourceAttachment?.expectedAuthorityEpoch).toBe(4);
      await hook.unmount();
    });
  }

  for (const delivery of ["send", "steer"] as const) {
    test(`${delivery} reconciles an outcome-unknown request before retrying`, async () => {
      const initial: ComposerDraft = {
        revision: 9,
        text: "do not send twice",
        resources: [],
        model: "model-x",
        reasoningEffort: "medium",
        latencyMode: "standard" as const,
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: new Date().toISOString(),
      };
      const attempts: SendMessageInput[] = [];
      let acceptedEvent: SessionEvent | null = null;
      const client = fakeClient({
        getComposerDraft: async () => initial,
        listEvents: async () => (acceptedEvent ? [acceptedEvent] : []),
        sendMessage: async (_workspaceId, _sessionId, input) => {
          const typed = typeof input === "string" ? { text: input } : input;
          attempts.push(typed);
          if (attempts.length === 1) throw gatewayError(503);
          return makeEvent(2, "user.message");
        },
        steerMessage: async (_workspaceId, _sessionId, input) => {
          const typed = typeof input === "string" ? { text: input } : input;
          attempts.push(typed);
          if (attempts.length === 1) throw gatewayError(503);
          return steerResult(makeEvent(2, "user.message"));
        },
      });
      const hook = await renderHook(
        () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      await flush();

      await flushing(async () =>
        expect(await hook.result.current[delivery]()).toBe(delivery === "send"),
      );
      await flush();
      acceptedEvent = {
        ...makeEvent(1, "user.message"),
        clientEventId: attempts[0]!.clientEventId,
      };
      if (delivery === "send") {
        const failed = hook.result.current.optimisticMessages?.[0];
        await flushing(() => hook.result.current.retryOptimisticMessage?.(failed!.clientEventId));
        await flush();
      } else {
        await flushing(async () => expect(await hook.result.current[delivery]()).toBe(true));
      }

      expect(attempts).toHaveLength(1);
      expect(hook.result.current.value).toBe("");
      await hook.unmount();
    });
  }

  for (const delivery of ["send", "steer"] as const) {
    test(`${delivery} keeps the original key and payload across edit and remount`, async () => {
      const originalResource = {
        kind: "file" as const,
        fileId: "66666666-6666-4666-8666-666666666666",
      };
      const newerResource = {
        kind: "file" as const,
        fileId: "77777777-7777-4777-8777-777777777777",
      };
      const initial: ComposerDraft = {
        revision: 10,
        text: "original uncertain prompt",
        resources: [originalResource],
        model: "model-x",
        reasoningEffort: "medium",
        latencyMode: "standard" as const,
        sourceTurnId: null,
        sourceTurnVersion: null,
        updatedAt: new Date().toISOString(),
      };
      const attempts: SendMessageInput[] = [];
      const client = fakeClient({
        getComposerDraft: async () => initial,
        sendMessage: async (_workspaceId, _sessionId, input) => {
          const typed = typeof input === "string" ? { text: input } : input;
          attempts.push(typed);
          if (attempts.length === 1) throw gatewayError(502);
          return makeEvent(2, "user.message");
        },
        steerMessage: async (_workspaceId, _sessionId, input) => {
          const typed = typeof input === "string" ? { text: input } : input;
          attempts.push(typed);
          if (attempts.length === 1) throw gatewayError(502);
          return steerResult(makeEvent(2, "user.message"));
        },
      });

      const first = await renderHook(
        () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      await flush();
      await flushing(async () =>
        expect(await first.result.current[delivery]()).toBe(delivery === "send"),
      );
      await flush();
      await first.unmount();

      const second = await renderHook(
        () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
        undefined,
      );
      await flush();
      expect(second.result.current.value).toBe(
        delivery === "send" ? "" : "original uncertain prompt",
      );
      expect(second.result.current.restoredResources).toEqual(
        delivery === "send" ? [] : [originalResource],
      );
      if (delivery === "steer") {
        expect(second.result.current.steering).toMatchObject({
          phase: "failed",
          outcomeUnknown: true,
        });
        expect(
          second.result.current.optimisticMessages?.find((message) => message.delivery === "steer"),
        ).toMatchObject({ state: "failed", destination: "chat" });
      }
      await flushing(() =>
        second.result.current.applyDraft({
          ...initial,
          text: "edited after timeout",
          resources: [newerResource],
        }),
      );
      expect(second.result.current.value).toBe("edited after timeout");
      expect(second.result.current.restoredResources).toEqual([newerResource]);
      if (delivery === "send") {
        const failed = second.result.current.optimisticMessages?.find(
          (message) => message.outcomeUnknown,
        );
        expect(failed).toBeDefined();
        await flushing(() => second.result.current.retryOptimisticMessage?.(failed!.clientEventId));
        await flush();
      } else {
        await flushing(async () => expect(await second.result.current[delivery]()).toBe(true));
      }

      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.clientEventId).toBe(attempts[0]!.clientEventId);
      expect(attempts[1]!.text).toBe("original uncertain prompt");
      expect(attempts[1]!.resources).toEqual([originalResource]);
      expect(second.result.current.value).toBe("edited after timeout");
      expect(second.result.current.restoredResources).toEqual([newerResource]);
      await second.unmount();
    });
  }

  test("an autosave conflict preserves the local text and exposes both resolution choices", async () => {
    const initial = {
      revision: 1,
      text: "remote one",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => initial,
      saveComposerDraft: async () => {
        // A stale revision is surfaced directly; the hook never silently
        // adopts another tab's revision and overwrites its content.
        throw new OpenGeniApiError(
          409,
          JSON.stringify({
            code: "DRAFT_CHANGED",
            message: "Composer draft changed",
          }),
        );
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    await flushing(async () => hook.result.current.setValue("mine remains"));
    await flush(600);
    expect(hook.result.current.value).toBe("mine remains");
    expect(hook.result.current.draftConflict?.message).toContain("Composer draft changed");
    await hook.unmount();
  });

  test("autosave never overwrites another tab after a stale-revision conflict", async () => {
    const initial = {
      revision: 1,
      text: "remote one",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium" as const,
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    let saves = 0;
    const client = fakeClient({
      getComposerDraft: async () =>
        saves === 0
          ? initial
          : {
              ...initial,
              revision: 2,
              text: "remote one",
            },
      saveComposerDraft: async (_workspaceId, _sessionId, request) => {
        saves += 1;
        if (request.expectedRevision === 1) {
          throw new OpenGeniApiError(
            409,
            JSON.stringify({
              code: "DRAFT_CHANGED",
              message: "Composer draft changed",
            }),
          );
        }
        return {
          ...initial,
          revision: request.expectedRevision + 1,
          text: request.text,
        };
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    await flushing(async () => hook.result.current.setValue("mine remains"));
    await flush(600);
    expect(hook.result.current.value).toBe("mine remains");
    expect(hook.result.current.draftConflict?.message).toContain("Composer draft changed");
    expect(hook.result.current.draft?.revision).toBe(1);
    expect(saves).toBe(1);
    await hook.unmount();
  });

  test("a session switch hides the old draft and drops its delayed autosave settlement", async () => {
    const sessionA: string = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const makeDraft = (text: string): ComposerDraft => ({
      revision: 1,
      text,
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    });
    let resolveBRead!: (value: ComposerDraft) => void;
    let resolveASave!: (value: ComposerDraft) => void;
    let savedARequest: { text: string } | null = null;
    const client = fakeClient({
      getComposerDraft: async (_workspaceId, sessionId) => {
        if (sessionId === sessionA) return makeDraft("A PRIVATE");
        return await new Promise<ComposerDraft>((resolve) => {
          resolveBRead = resolve;
        });
      },
      saveComposerDraft: async (_workspaceId, sessionId, request) => {
        if (sessionId !== sessionA) throw new Error("unexpected B autosave");
        savedARequest = request;
        return await new Promise<ComposerDraft>((resolve) => {
          resolveASave = resolve;
        });
      },
    });
    const hook = await renderHook(
      (sessionId: string) => useComposer(sessionId, { client, workspaceId: WORKSPACE_ID }),
      sessionA,
    );
    await flush();
    expect(hook.result.current.value).toBe("A PRIVATE");

    await flushing(() => hook.result.current.setValue("A PRIVATE EDIT"));
    await flush(600);
    expect(savedARequest).toMatchObject({ text: "A PRIVATE EDIT" });

    await hook.rerender(sessionB);
    expect(hook.result.current.value).toBe("");
    expect(hook.result.current.draft).toBeNull();
    await flushing(() => resolveBRead(makeDraft("B PRIVATE")));
    expect(hook.result.current.value).toBe("B PRIVATE");

    await flushing(() =>
      resolveASave({
        ...makeDraft("A PRIVATE EDIT"),
        revision: 2,
      }),
    );
    expect(hook.result.current.value).toBe("B PRIVATE");
    expect(hook.result.current.draft?.text).toBe("B PRIVATE");
    expect(hook.result.current.draftConflict).toBeNull();
    await hook.unmount();
  });

  test("a session switch drops stale composer control settlement", async () => {
    const sessionA: string = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let rejectPause!: (cause: Error) => void;
    const client = fakeClient({
      pauseSession: async () =>
        await new Promise((_resolve, reject) => {
          rejectPause = reject;
        }),
    });
    const hook = await renderHook(
      (sessionId: string) => useComposer(sessionId, { client, workspaceId: WORKSPACE_ID }),
      sessionA,
    );
    await flush();

    let stalePause!: Promise<void>;
    await flushing(() => {
      stalePause = hook.result.current.pause();
    });
    expect(hook.result.current.pausing).toBe(true);
    await hook.rerender(sessionB);
    expect(hook.result.current.pausing).toBe(false);
    expect(hook.result.current.error).toBeNull();

    await flushing(async () => {
      rejectPause(new Error("A PRIVATE CONTROL ERROR"));
      await stalePause;
    });
    expect(hook.result.current.pausing).toBe(false);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("a session switch stops a stale scoped resume before its follow-up write", async () => {
    const sessionA: string = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const scopedSession: string = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    let resolveScopedQueue!: (value: SessionQueueSnapshot) => void;
    const resumedSessions: string[] = [];
    const client = fakeClient({
      getQueue: async (_workspaceId, sessionId) => {
        if (sessionId !== scopedSession) return queueSnapshot([]);
        return await new Promise<SessionQueueSnapshot>((resolve) => {
          resolveScopedQueue = resolve;
        });
      },
      resumeSession: async (_workspaceId, sessionId) => {
        resumedSessions.push(sessionId);
        throw new Error("unexpected stale resume");
      },
    });
    const hook = await renderHook(
      (sessionId: string) => useComposer(sessionId, { client, workspaceId: WORKSPACE_ID }),
      sessionA,
    );
    await flush();

    let staleResume!: Promise<void>;
    await flushing(() => {
      staleResume = hook.result.current.resumeScope({
        scope: "session",
        targetId: scopedSession,
        selectedStateAfter: "active",
        impactCopy: "Resume scoped session",
      });
    });
    await hook.rerender(sessionB);
    expect(hook.result.current.resuming).toBe(false);

    await flushing(async () => {
      resolveScopedQueue(queueSnapshot([]));
      await staleResume;
    });
    expect(resumedSessions).toEqual([]);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });
});

describe("session hook concurrent target ownership", () => {
  test("a suspended target transition leaves the committed session fully interactive", async () => {
    const sessionA: string = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const turn = fakeTurn({
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      prompt: "A queue item",
    });
    const draft: ComposerDraft = {
      revision: 1,
      text: "A draft",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    let deleteCalls = 0;
    let pauseCalls = 0;
    const client = fakeClient({
      getQueue: async () => queueSnapshot([turn]),
      getComposerDraft: async () => draft,
      deleteQueueItem: async () => {
        deleteCalls += 1;
        throw new Error("expected test rollback");
      },
      pauseSession: async () => {
        pauseCalls += 1;
        throw new Error("expected test rollback");
      },
    });
    let setTarget!: (target: string) => void;
    let renderedSessionB = false;
    let committed:
      | {
          queue: ReturnType<typeof useTurnQueue>;
          composer: ReturnType<typeof useComposer>;
          control: ReturnType<typeof useSessionControl>;
        }
      | undefined;
    const suspended = new Promise<never>(() => {});

    function Harness() {
      const [target, setTargetState] = useState(sessionA);
      setTarget = setTargetState;
      const queue = useTurnQueue(target, {
        client,
        workspaceId: WORKSPACE_ID,
        events: noEvents,
      });
      const composer = useComposer(target, {
        client,
        workspaceId: WORKSPACE_ID,
        events: noEvents,
      });
      const control = useSessionControl(target, {
        client,
        workspaceId: WORKSPACE_ID,
      });
      if (target === sessionB) {
        renderedSessionB = true;
        throw suspended;
      }
      committed = { queue, composer, control };
      return <div>{`${composer.value}|${queue.queue.map((item) => item.prompt).join(",")}`}</div>;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      flushSync(() => {
        root.render(
          <Suspense fallback={<div>Loading B</div>}>
            <Harness />
          </Suspense>,
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(committed?.composer.value).toBe("A draft");
      expect(committed?.queue.queue.map((item) => item.prompt)).toEqual(["A queue item"]);

      startTransition(() => setTarget(sessionB));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(renderedSessionB).toBe(true);
      expect(container.textContent).toBe("A draft|A queue item");

      committed?.composer.setValue("A edited while B waits");
      await new Promise((resolve) => setTimeout(resolve, 10));
      await committed?.queue.removeTurn(turn.id);
      await committed?.control.pause();

      expect(committed?.composer.value).toBe("A edited while B waits");
      expect(deleteCalls).toBe(1);
      expect(pauseCalls).toBe(1);
    } finally {
      flushSync(() => root.unmount());
      container.remove();
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });

  test("a suspended target render cannot retarget a committed draft callback", async () => {
    const sessionA: string = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sessionB: string = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const draftA: ComposerDraft = {
      revision: 1,
      text: "A draft",
      resources: [],
      model: "model-a",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    let resolveA!: (draft: ComposerDraft) => void;
    const client = fakeClient({
      getComposerDraft: async (_workspaceId, sessionId) => {
        if (sessionId !== sessionA) throw new Error("uncommitted B must not read");
        return await new Promise<ComposerDraft>((resolve) => {
          resolveA = resolve;
        });
      },
    });
    const applied: string[] = [];
    let setTarget!: (target: string) => void;
    let renderedB = false;
    const suspended = new Promise<never>(() => {});

    function Harness() {
      const [target, setTargetState] = useState(sessionA);
      setTarget = setTargetState;
      const composer = useComposer(target, {
        client,
        workspaceId: WORKSPACE_ID,
        events: noEvents,
      });
      useEffect(() => {
        if (composer.policy) applied.push(`${target}:${composer.value}`);
      }, [composer.policy, composer.value, target]);
      if (target === sessionB) {
        renderedB = true;
        throw suspended;
      }
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      flushSync(() => {
        root.render(
          <Suspense fallback={null}>
            <Harness />
          </Suspense>,
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      startTransition(() => setTarget(sessionB));
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(renderedB).toBe(true);

      resolveA(draftA);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(applied).toEqual([`${sessionA}:A draft`]);
    } finally {
      flushSync(() => root.unmount());
      container.remove();
      globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

describe("useComposer file-only send", () => {
  test("canSend lights up with a ready resource even when the draft is empty", async () => {
    const client = fakeClient({
      sendMessage: async () => makeEvent(1, "user.message"),
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({
            resources: [{ kind: "file", fileId: "file-1" }],
          }),
        }),
      undefined,
    );
    // Empty draft, but a resource is attached → sendable.
    expect(hook.result.current.value).toBe("");
    expect(hook.result.current.canSend).toBe(true);
    await hook.unmount();
  });

  test("canSend follows attachment additions and removals in the same session render", async () => {
    const client = fakeClient({});
    const hook = await renderHook(
      (attached: boolean) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({
            resources: attached ? [{ kind: "file", fileId: "file-1" }] : [],
          }),
        }),
      false as boolean,
    );
    expect(hook.result.current.canSend).toBe(false);
    await hook.rerender(true);
    expect(hook.result.current.canSend).toBe(true);
    await hook.rerender(false);
    expect(hook.result.current.canSend).toBe(false);
    await hook.unmount();
  });

  test("with no draft and no resources, canSend stays false and send() bails", async () => {
    const calls: unknown[] = [];
    const client = fakeClient({
      sendMessage: async (_ws, _session, message) => {
        calls.push(message);
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    expect(hook.result.current.canSend).toBe(false);
    let result = true;
    await flushing(async () => {
      result = await hook.result.current.send();
    });
    expect(result).toBe(false);
    expect(calls).toEqual([]);
    await hook.unmount();
  });

  test("sendBlocked gates canSend and direct send() calls until the host resolves attachments", async () => {
    const sent: unknown[] = [];
    const client = fakeClient({
      sendMessage: async (_ws, _session, message) => {
        sent.push(message);
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      (blocked: boolean) =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({
            resources: [{ kind: "file", fileId: "ready-file" }],
          }),
          sendBlocked: () => blocked,
        }),
      true as boolean,
    );

    expect(hook.result.current.canSend).toBe(false);
    await flushing(async () => expect(await hook.result.current.send()).toBe(false));
    expect(sent).toEqual([]);

    await hook.rerender(false);
    expect(hook.result.current.canSend).toBe(true);
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    expect(sent).toHaveLength(1);
    await hook.unmount();
  });

  test("sending a file-only message dispatches the resources with a minimal default text", async () => {
    const sent: { text: string; resources?: unknown }[] = [];
    const client = fakeClient({
      sendMessage: async (_ws, _session, message) => {
        sent.push(message as { text: string; resources?: unknown });
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({
            resources: [{ kind: "file", fileId: "file-1" }],
          }),
        }),
      undefined,
    );
    // Empty draft (no explicit text) — the send path must still go through.
    await flushing(async () => {
      const ok = await hook.result.current.send();
      expect(ok).toBe(true);
    });
    expect(sent).toHaveLength(1);
    // Resources ride along, and the wire text is non-empty (contract: min(1)).
    expect(sent[0]!.resources).toEqual([{ kind: "file", fileId: "file-1" }]);
    expect(sent[0]!.text.trim().length).toBeGreaterThan(0);
    await hook.unmount();
  });
  test("onSent receives the immutable input snapshot accepted before an in-flight edit", async () => {
    let currentFileId = "accepted-file";
    let releaseSend!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    let accepted: SendMessageInput | undefined;
    const client = fakeClient({
      sendMessage: async () => {
        markStarted();
        await pending;
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({
            resources: [{ kind: "file", fileId: currentFileId }],
          }),
          onSent: (_text, input) => {
            accepted = input;
          },
        }),
      undefined,
    );

    let result!: Promise<boolean>;
    await flushing(() => {
      result = hook.result.current.send();
    });
    await started;
    currentFileId = "later-file";
    await flushing(async () => {
      releaseSend();
      expect(await result).toBe(true);
    });

    expect(accepted?.resources).toEqual([{ kind: "file", fileId: "accepted-file" }]);
    await hook.unmount();
  });

  test("persists the same file-only text that it submits", async () => {
    const initial: ComposerDraft = {
      revision: 3,
      text: "",
      resources: [],
      model: "model-x",
      reasoningEffort: "medium",
      latencyMode: "standard" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: null,
    };
    const saved: unknown[] = [];
    const sent: unknown[] = [];
    const client = fakeClient({
      getComposerDraft: async () => initial,
      saveComposerDraft: async (_ws, _session, request) => {
        saved.push(request);
        return {
          ...initial,
          ...request,
          revision: request.expectedRevision + 1,
        };
      },
      sendMessage: async (_ws, _session, message) => {
        sent.push(message);
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({
            resources: [{ kind: "file", fileId: "file-1" }],
          }),
        }),
      undefined,
    );
    await flush();

    await flushing(async () => expect(await hook.result.current.send()).toBe(true));

    expect(saved).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect((saved[0] as { text: string }).text).toBe(FILE_ONLY_MESSAGE_TEXT);
    expect((sent[0] as { text: string }).text).toBe(FILE_ONLY_MESSAGE_TEXT);
    await hook.unmount();
  });
});

describe("useEnvironments", () => {
  test("lists environments and refreshes after each mutation", async () => {
    const log: string[] = [];
    let environments: WorkspaceEnvironment[] = [];
    const client = fakeClient({
      listEnvironments: async () => {
        log.push("list");
        return environments;
      },
      createEnvironment: async (_ws, request) => {
        log.push(`create:${request.name}`);
        const created: WorkspaceEnvironment = {
          id: "env-1",
          accountId: "acc",
          workspaceId: WORKSPACE_ID,
          scope: "workspace",
          generation: 1,
          status: "active",
          name: request.name,
          description: null,
          variables: [],
          createdAt: "",
          updatedAt: "",
        };
        environments = [created];
        return created;
      },
      setEnvironmentVariable: async (_ws, environmentId, name) => {
        log.push(`set:${environmentId}:${name}`);
        return { name, version: 1, createdAt: "", updatedAt: "" };
      },
      getVariableSetVariable: async (_ws, environmentId, name) => {
        log.push(`read:${environmentId}:${name}`);
        return {
          variableSetId: environmentId,
          name,
          version: 1,
          value: `const fake = "ghp_not_a_credential";\nprintf '%s\\n' "$VALUE"`,
        };
      },
      deleteEnvironmentVariable: async (_ws, environmentId, name) => {
        log.push(`unset:${environmentId}:${name}`);
      },
      deleteEnvironment: async (_ws, environmentId) => {
        log.push(`delete:${environmentId}`);
        environments = [];
      },
    });
    const hook = await renderHook(
      () => useEnvironments({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.environments).toEqual([]);
    await flushing(async () => {
      await hook.result.current.create({
        name: "staging",
        variables: [{ name: "EXAMPLE_TOKEN", value: "v" }],
      });
    });
    expect(hook.result.current.environments.map((environment) => environment.name)).toEqual([
      "staging",
    ]);
    await flushing(async () => {
      const secret = await hook.result.current.readVariable("env-1", "EXAMPLE_TOKEN");
      expect(secret?.value).toBe(`const fake = "ghp_not_a_credential";\nprintf '%s\\n' "$VALUE"`);
    });
    // Plaintext is returned directly to the caller and never triggers a
    // metadata-cache refresh that could retain it.
    expect(log.at(-1)).toBe("read:env-1:EXAMPLE_TOKEN");
    await flushing(async () => {
      await hook.result.current.setVariable("env-1", "EXAMPLE_TOKEN", "v2");
      await hook.result.current.deleteVariable("env-1", "EXAMPLE_TOKEN");
      await hook.result.current.remove("env-1");
    });
    expect(log).toEqual([
      "list",
      "create:staging",
      "list",
      "read:env-1:EXAMPLE_TOKEN",
      "set:env-1:EXAMPLE_TOKEN",
      "list",
      "unset:env-1:EXAMPLE_TOKEN",
      "list",
      "delete:env-1",
      "list",
    ]);
    await hook.unmount();
  });
});

describe("usePacks", () => {
  test("previews, installs, and safely uninstalls a pack", async () => {
    let installed = false;
    const installation = {
      id: "inst-1",
      accountId: "acc",
      workspaceId: WORKSPACE_ID,
      packId: "autonomous-devops",
      status: "active" as const,
      version: 1,
      manifestSnapshot: null,
      manifestDigest: "a".repeat(64),
      selectedRigId: null,
      installedBySubjectId: "user:test",
      metadata: {},
      enabledAt: "",
      updatedAt: "",
    };
    const client = fakeClient({
      listPacks: async () => ({
        packs: [{ id: "autonomous-devops", name: "Autonomous DevOps" } as never],
        installations: installed ? [installation] : [],
      }),
      previewPackInstallation: async (_ws, packId) => ({
        packId,
        packVersion: "1.0.0",
        manifestDigest: "a".repeat(64),
        installationVersion: null,
        action: "install",
        ready: true,
        blockers: [],
        components: [],
        rig: {
          required: false,
          status: "not_required",
          requestedRigId: null,
          rigId: null,
          rigVersionId: null,
          name: null,
          image: null,
        },
        variableSetId: null,
        legacyInlineSkillCount: 0,
        legacySandboxImage: null,
      }),
      installPack: async (_ws, packId) => {
        installed = true;
        return { ...installation, packId };
      },
      previewPackUninstall: async (_ws, packId) => ({
        packId,
        installed,
        installationVersion: installation.version,
        components: [],
      }),
      uninstallPack: async (_ws, packId) => {
        installed = false;
        return { packId, status: "uninstalled", retainedComponents: [] };
      },
    });
    const hook = await renderHook(() => usePacks({ client, workspaceId: WORKSPACE_ID }), undefined);
    await flush();
    expect(hook.result.current.packs.map((pack) => pack.id)).toEqual(["autonomous-devops"]);
    expect(hook.result.current.installationFor("autonomous-devops")).toBeNull();
    await flushing(async () => {
      const preview = await hook.result.current.previewInstallation("autonomous-devops");
      await hook.result.current.install("autonomous-devops", {
        expectedManifestDigest: preview!.manifestDigest,
        idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });
    });
    expect(hook.result.current.installationFor("autonomous-devops")?.status).toBe("active");
    await flushing(async () => {
      const preview = await hook.result.current.previewUninstall("autonomous-devops");
      await hook.result.current.uninstall("autonomous-devops", {
        expectedInstallationVersion: preview!.installationVersion!,
        idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });
    });
    expect(hook.result.current.installationFor("autonomous-devops")).toBeNull();
    await hook.unmount();
  });
});

describe("useWorkspaces", () => {
  test("lists and creates workspaces with the client only (no provider workspace)", async () => {
    const names: string[] = [];
    let workspaces = [{ id: "ws-1", name: "Acme" } as never];
    const client = fakeClient({
      listWorkspaces: async () => workspaces,
      createWorkspace: async (request) => {
        names.push(request.name);
        const created = { id: "ws-2", name: request.name } as never;
        workspaces = [...workspaces, created];
        return created;
      },
    });
    const hook = await renderHook(() => useWorkspaces({ client }), undefined);
    await flush();
    expect(hook.result.current.workspaces).toHaveLength(1);
    await flushing(async () => {
      await hook.result.current.create({ name: "Acme Staging" });
    });
    expect(names).toEqual(["Acme Staging"]);
    expect(hook.result.current.workspaces).toHaveLength(2);
    await hook.unmount();
  });
});

describe("useBillingUsage", () => {
  test("exposes balance and usage, passing the account/workspace selectors", async () => {
    const seen: unknown[] = [];
    const client = fakeClient({
      getBillingUsage: async (options) => {
        seen.push(options);
        return {
          balance: {
            accountId: "acc-1",
            balanceMicros: 12_000_000,
            currency: "usd" as const,
            updatedAt: "",
          },
          usage: [{ id: "u1" } as never],
        };
      },
    });
    const hook = await renderHook(
      () =>
        useBillingUsage({
          client,
          accountId: "acc-1",
          workspaceId: WORKSPACE_ID,
        }),
      undefined,
    );
    await flush();
    expect(seen).toEqual([{ accountId: "acc-1", workspaceId: WORKSPACE_ID }]);
    expect(hook.result.current.balance?.balanceMicros).toBe(12_000_000);
    expect(hook.result.current.usage).toHaveLength(1);
    await hook.unmount();
  });
});

describe("useAvailableModels", () => {
  test("returns the host-exposed models and the default model from getClientConfig", async () => {
    let calls = 0;
    const client = fakeClient({
      getClientConfig: async () => {
        calls += 1;
        return {
          deploymentRevision: "rev-1",
          defaultModel: "gpt-5.6-sol",
          allowedModels: ["gpt-5.6-sol", "accounts/fireworks/models/glm-5p2"],
          models: [
            {
              id: "gpt-5.6-sol",
              label: "gpt-5.6-sol",
              provider: "openai",
              providerLabel: "OpenAI",
              api: "responses",
            },
            {
              id: "accounts/fireworks/models/glm-5p2",
              label: "GLM 5.2",
              provider: "fireworks",
              providerLabel: "Fireworks AI",
              api: "chat",
            },
          ],
          defaultReasoningEffort: "medium",
          allowedReasoningEfforts: ["medium"],
          mcpServers: [],
          fileUploads: { enabled: true, maxSizeBytes: 1024 },
          productAccessMode: "managed",
          auth: { mode: "none" },
        } as never;
      },
    });
    const hook = await renderHook(() => useAvailableModels({ client }), undefined);
    await flush();
    expect(calls).toBe(1);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.defaultModel).toBe("gpt-5.6-sol");
    expect(hook.result.current.models.map((model) => model.label)).toEqual([
      "gpt-5.6-sol",
      "GLM 5.2",
    ]);
    expect(hook.result.current.models.map((model) => model.providerLabel)).toEqual([
      "OpenAI",
      "Fireworks AI",
    ]);
    await hook.unmount();
  });

  test("starts with empty models and a null default before the config loads", async () => {
    const client = fakeClient({
      getClientConfig: async () => new Promise(() => {}) as never,
    });
    const hook = await renderHook(() => useAvailableModels({ client }), undefined);
    expect(hook.result.current.loading).toBe(true);
    expect(hook.result.current.models).toEqual([]);
    expect(hook.result.current.defaultModel).toBeNull();
    await hook.unmount();
  });
});

/** Run a callback inside act-flushed microtasks (mutations settle state). */
async function flushing(run: () => Promise<void> | void): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    await run();
  });
}
