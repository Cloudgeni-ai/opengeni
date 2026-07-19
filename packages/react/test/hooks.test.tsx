/* ----------------------------------------------------------------------------
   Rendered-hook tests for the workspace + queue + goal hooks, on the minimal
   happy-dom harness in ./render-hook. All hook tests live in this one file so
   DOM globals are registered exactly once for the bun test process slice that
   needs them and restored afterwards.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import type {
  ComposerDraft,
  SessionEvent,
  SessionQueueMutationResponse,
  SessionQueueSnapshot,
  SessionTurn,
  WorkspaceEnvironment,
} from "@opengeni/sdk";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, fakeGoal, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useAvailableModels } from "../src/hooks/use-available-models";
import { useBillingUsage } from "../src/hooks/use-billing-usage";
import { useComposer } from "../src/hooks/use-composer";
import { useEnvironments } from "../src/hooks/use-environments";
import { useGoal } from "../src/hooks/use-goal";
import { usePacks } from "../src/hooks/use-packs";
import { useWorkspaceSessions } from "../src/hooks/use-workspace-sessions";
import { useSessionControl } from "../src/hooks/use-session-control";
import { useSessionLineage } from "../src/hooks/use-session-lineage";
import { useTurnQueue } from "../src/hooks/use-turn-queue";
import { useWorkspaces } from "../src/hooks/use-workspaces";

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

const noEvents: SessionEvent[] = [];

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
    items,
    ...overrides,
  };
}

describe("useWorkspaceSessions", () => {
  test("keeps pinned rows in the historical sessions result while exposing the section", async () => {
    const pinned = { id: "pinned", pinned: true } as never;
    const ordinary = { id: "ordinary", pinned: false } as never;
    const client = fakeClient({
      listSessionPage: async () => ({
        pinned: [pinned],
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
    expect(hook.result.current.pinned.map((session) => session.id)).toEqual(["pinned"]);
    expect(hook.result.current.nextCursor).toBe("next-page");
    await hook.unmount();
  });
});

describe("useTurnQueue", () => {
  test("renders the authoritative server queue verbatim", async () => {
    const turns = [fakeTurn({ id: "second", position: 2 }), fakeTurn({ id: "first", position: 1 })];
    const client = fakeClient({ getQueue: async () => queueSnapshot(turns) });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
          while (true) {
            const event = await new Promise<SessionEvent | null>((resolve) => {
              push = resolve;
              options?.signal?.addEventListener("abort", () => resolve(null), { once: true });
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
    expect(listCalls).toBe(1);
    expect(streamedAfter.value).toBe(41);
    await flushing(async () => {
      push!(makeEvent(42, "turn.queued"));
    });
    await flush(250);
    expect(listCalls).toBe(2);
    await hook.unmount();
  });

  test("move, Edit, Steer, and Delete bind the displayed versions and accept server order", async () => {
    const first = fakeTurn({ id: "11111111-aaaa-4aaa-8aaa-111111111111", version: 2 });
    const second = fakeTurn({ id: "22222222-bbbb-4bbb-8bbb-222222222222", version: 4 });
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
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
    await flushing(async () => expect(await hook.result.current.removeTurn(first.id)).toBe(true));
    expect(calls.map((call) => call.action)).toEqual(["move", "edit", "steer", "delete"]);
    expect(calls[0]?.request).toMatchObject({ expectedQueueVersion: 5, beforeTurnId: null });
    expect(calls[1]?.request).toMatchObject({ expectedTurnVersion: 4, expectedDraftRevision: 2 });
    expect(calls[2]?.request).toMatchObject({ expectedTurnVersion: 2, controlEtag: "control-3" });
    expect(calls[3]?.request).toMatchObject({ expectedTurnVersion: 2 });
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
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
});

describe("useSessionLineage", () => {
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
        useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
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
        useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
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
      () => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
        calls.push({ status: request.status, rationale: request.rationale });
        return fakeGoal({
          status: request.status === "paused" ? "paused" : "active",
          pausedReason: request.status === "paused" ? "api" : null,
        });
      },
    });
    const hook = await renderHook(
      () => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
      () => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
      () => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
        useGoal(sessionId, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
      { kind: "decision", approvalId: "ap-1", decision: "approve", message: "looks safe" },
      { kind: "decision", approvalId: "ap-2", decision: "reject" },
    ]);
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
        return { accepted: makeEvent(1, "user.message"), turn: fakeTurn() };
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

  test("an explicit steer routes the send through steerMessage", async () => {
    const steered: unknown[] = [];
    const client = fakeClient({
      steerMessage: async (_ws, _session, message) => {
        steered.push(message);
        return { accepted: makeEvent(1, "user.message"), turn: fakeTurn() };
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
});

describe("useComposer durable draft and control binding", () => {
  test("a live queue mutation reloads the authoritative draft in another tab", async () => {
    let current: ComposerDraft = {
      revision: 1,
      text: "first tab state",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "model-x",
      reasoningEffort: "medium",
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
      makeEvent(1, "session.queue.changed", { operation: "edit", queueVersion: 2 }),
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
      tools: [],
      toolsProvided: false,
      model: "model-x",
      reasoningEffort: "medium" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => initial,
      saveComposerDraft: async (_ws, _session, request) => {
        saved.push(request);
        return { ...initial, ...request, revision: request.expectedRevision + 1 };
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
          sendExtras: { model: "model-x", reasoningEffort: "medium" },
        }),
      undefined,
    );
    await flush();
    expect(hook.result.current.value).toBe("restored text");
    await flushing(async () => hook.result.current.setValue("edited locally"));
    await flush(600);
    expect(saved.at(-1)).toMatchObject({ expectedRevision: 4, text: "edited locally" });
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    expect(sent.at(-1)).toMatchObject({
      text: "edited locally",
      expectedDraftRevision: 5,
      controlEtag: "control-3",
    });
    await hook.unmount();
  });

  test("preserves an explicit draft tool array when the host does not override it", async () => {
    const sent: unknown[] = [];
    const initial: ComposerDraft = {
      revision: 2,
      text: "keep this narrowing",
      resources: [],
      tools: [{ kind: "mcp", id: "cap-search" }],
      toolsProvided: true,
      model: "model-x",
      reasoningEffort: "medium",
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => initial,
      sendMessage: async (_ws, _session, input) => {
        sent.push(input);
        return makeEvent(1, "user.message");
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    expect(sent.at(-1)).toMatchObject({ tools: [{ kind: "mcp", id: "cap-search" }] });
    await hook.unmount();
  });

  test("persists and sends an explicit empty tool override", async () => {
    const saved: unknown[] = [];
    const sent: unknown[] = [];
    const initial: ComposerDraft = {
      revision: 1,
      text: "no optional tools",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "model-x",
      reasoningEffort: "medium",
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => initial,
      saveComposerDraft: async (_ws, _session, request) => {
        saved.push(request);
        return { ...initial, ...request, revision: request.expectedRevision + 1 };
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
          sendExtras: { tools: [] },
        }),
      undefined,
    );
    await flush();
    await flushing(async () => expect(await hook.result.current.send()).toBe(true));
    expect(saved.at(-1)).toMatchObject({ tools: [], toolsProvided: true });
    expect(sent.at(-1)).toMatchObject({ tools: [] });
    await hook.unmount();
  });

  test("an autosave conflict preserves the local text and exposes both resolution choices", async () => {
    const initial = {
      revision: 1,
      text: "remote one",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "model-x",
      reasoningEffort: "medium" as const,
      sourceTurnId: null,
      sourceTurnVersion: null,
      updatedAt: new Date().toISOString(),
    };
    const client = fakeClient({
      getComposerDraft: async () => initial,
      saveComposerDraft: async () => {
        throw new OpenGeniApiError(409, "draft changed");
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
    expect(hook.result.current.draftConflict?.message).toContain("409");
    await hook.unmount();
  });
});

describe("useComposer file-only send", () => {
  test("canSend lights up with a ready resource even when the draft is empty", async () => {
    const client = fakeClient({ sendMessage: async () => makeEvent(1, "user.message") });
    const hook = await renderHook(
      () =>
        useComposer(SESSION_ID, {
          client,
          workspaceId: WORKSPACE_ID,
          sendExtras: () => ({ resources: [{ kind: "file", fileId: "file-1" }] }),
        }),
      undefined,
    );
    // Empty draft, but a resource is attached → sendable.
    expect(hook.result.current.value).toBe("");
    expect(hook.result.current.canSend).toBe(true);
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
          sendExtras: () => ({ resources: [{ kind: "file", fileId: "file-1" }] }),
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
      await hook.result.current.setVariable("env-1", "EXAMPLE_TOKEN", "v2");
      await hook.result.current.deleteVariable("env-1", "EXAMPLE_TOKEN");
      await hook.result.current.remove("env-1");
    });
    expect(log).toEqual([
      "list",
      "create:staging",
      "list",
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
  test("lists packs/installations and enables a pack", async () => {
    let enabled = false;
    const installation = {
      id: "inst-1",
      accountId: "acc",
      workspaceId: WORKSPACE_ID,
      packId: "autonomous-devops",
      status: "active" as const,
      metadata: {},
      enabledAt: "",
      updatedAt: "",
    };
    const client = fakeClient({
      listPacks: async () => ({
        packs: [{ id: "autonomous-devops", name: "Autonomous DevOps" } as never],
        installations: enabled ? [installation] : [],
      }),
      enablePack: async (_ws, packId, request) => {
        enabled = true;
        return { ...installation, packId, metadata: request?.metadata ?? {} };
      },
    });
    const hook = await renderHook(() => usePacks({ client, workspaceId: WORKSPACE_ID }), undefined);
    await flush();
    expect(hook.result.current.packs.map((pack) => pack.id)).toEqual(["autonomous-devops"]);
    expect(hook.result.current.installationFor("autonomous-devops")).toBeNull();
    await flushing(async () => {
      await hook.result.current.enable("autonomous-devops");
    });
    expect(hook.result.current.installationFor("autonomous-devops")?.status).toBe("active");
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
      () => useBillingUsage({ client, accountId: "acc-1", workspaceId: WORKSPACE_ID }),
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
    const client = fakeClient({ getClientConfig: async () => new Promise(() => {}) as never });
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
