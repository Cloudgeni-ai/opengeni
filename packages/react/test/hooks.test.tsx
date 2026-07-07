/* ----------------------------------------------------------------------------
   Rendered-hook tests for the workspace + queue + goal hooks, on the minimal
   happy-dom harness in ./render-hook. All hook tests live in this one file so
   DOM globals are registered exactly once for the bun test process slice that
   needs them and restored afterwards.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, SessionTurn, WorkspaceEnvironment } from "@opengeni/sdk";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, fakeGoal, fakeTurn, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { OpenGeniApiError } from "@opengeni/sdk";
import { useAvailableModels } from "../src/hooks/use-available-models";
import { useBillingUsage } from "../src/hooks/use-billing-usage";
import { useComposer } from "../src/hooks/use-composer";
import { useEnvironments } from "../src/hooks/use-environments";
import { useGoal } from "../src/hooks/use-goal";
import { usePacks } from "../src/hooks/use-packs";
import { useSessionControl } from "../src/hooks/use-session-control";
import { useSessionLineage } from "../src/hooks/use-session-lineage";
import { useTurnQueue } from "../src/hooks/use-turn-queue";
import { useWorkspaces } from "../src/hooks/use-workspaces";

registerDom();

function makeEvent(sequence: number, type: string, payload: Record<string, unknown> = {}): SessionEvent {
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

describe("useTurnQueue", () => {
  test("loads turns and projects queue + activeTurn", async () => {
    const turns = [
      fakeTurn({ id: "active", status: "running", position: 0 }),
      fakeTurn({ id: "second", position: 2 }),
      fakeTurn({ id: "first", position: 1 }),
    ];
    const client = fakeClient({ listTurns: async () => turns });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
      undefined,
    );
    await flush();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["first", "second"]);
    expect(hook.result.current.activeTurn?.id).toBe("active");
    await hook.unmount();
  });

  test("editTurn applies optimistically and merges the server's turn", async () => {
    const queued = fakeTurn({ id: "edit-me", prompt: "old prompt" });
    const updateCalls: { turnId: string; prompt?: string | undefined }[] = [];
    const client = fakeClient({
      listTurns: async () => [queued],
      updateQueuedTurn: async (_ws, _session, turnId, update) => {
        updateCalls.push({ turnId, prompt: update.prompt });
        return { ...queued, prompt: update.prompt ?? queued.prompt, updatedAt: "2026-06-12T01:00:00.000Z" };
      },
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
      undefined,
    );
    await flush();
    let edited: SessionTurn | null = null;
    await flushing(async () => {
      edited = await hook.result.current.editTurn("edit-me", { prompt: "new prompt" });
    });
    expect(updateCalls).toEqual([{ turnId: "edit-me", prompt: "new prompt" }]);
    expect(edited!.prompt).toBe("new prompt");
    expect(hook.result.current.queue[0]?.prompt).toBe("new prompt");
    expect(hook.result.current.mutationError).toBeNull();
    await hook.unmount();
  });

  test("a failed mutation rolls back by refetching and surfaces mutationError", async () => {
    const queued = fakeTurn({ id: "victim", prompt: "original" });
    let listCalls = 0;
    const client = fakeClient({
      listTurns: async () => {
        listCalls += 1;
        return [queued];
      },
      deleteQueuedTurn: async () => {
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
      expect(removed).toBeNull();
    });
    await flush();
    // Optimistic cancel was rolled back by the refetch.
    expect(listCalls).toBe(2);
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["victim"]);
    expect(hook.result.current.mutationError?.message).toContain("409");
    await hook.unmount();
  });

  test("reorderTurns applies optimistically before the server confirms", async () => {
    const a = fakeTurn({ id: "a", position: 1 });
    const b = fakeTurn({ id: "b", position: 2 });
    let resolveReorder: ((turns: SessionTurn[]) => void) | null = null;
    const client = fakeClient({
      listTurns: async () => [a, b],
      reorderQueuedTurns: async () =>
        await new Promise<SessionTurn[]>((resolve) => {
          resolveReorder = resolve;
        }),
    });
    const hook = await renderHook(
      () => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
      undefined,
    );
    await flush();
    let pending: Promise<SessionTurn[] | null> | null = null;
    await flushing(async () => {
      pending = hook.result.current.reorderTurns(["b", "a"]);
      await Promise.resolve();
    });
    // Optimistic: queue already shows the new order while the call is in flight.
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["b", "a"]);
    expect(hook.result.current.mutating).toBe(true);
    await flushing(async () => {
      resolveReorder!([
        { ...b, position: 1 },
        { ...a, position: 2 },
      ]);
      await pending;
    });
    expect(hook.result.current.queue.map((turn) => turn.id)).toEqual(["b", "a"]);
    expect(hook.result.current.mutating).toBe(false);
    await hook.unmount();
  });

  test("turn.* events on a shared event log trigger a debounced refetch", async () => {
    let listCalls = 0;
    const client = fakeClient({
      listTurns: async () => {
        listCalls += 1;
        return [fakeTurn({ id: `turn-${listCalls}` })];
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) => useTurnQueue(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    expect(listCalls).toBe(1);
    // Unrelated events do not refetch.
    await hook.rerender([makeEvent(1, "agent.message.delta")]);
    await flush(200);
    expect(listCalls).toBe(1);
    // A burst of turn events coalesces into one refetch.
    await hook.rerender([makeEvent(1, "agent.message.delta"), makeEvent(2, "turn.queued"), makeEvent(3, "turn.updated")]);
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
      listTurns: async () => {
        listCalls += 1;
        return [fakeTurn({ id: `turn-${listCalls}` })];
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
      (events: SessionEvent[]) => useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    expect(hook.result.current.lineage?.children[0]?.session.id).toBe("child-1");
    await hook.rerender([makeEvent(1, "agent.message.delta")]);
    await flush(200);
    expect(reads).toBe(1);
    await hook.rerender([makeEvent(1, "agent.message.delta"), makeEvent(2, "session.status.changed")]);
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
      (events: SessionEvent[]) => useSessionLineage(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      [] as SessionEvent[],
    );
    await flush();
    expect(reads).toBe(1);

    await hook.rerender([
      makeEvent(1, "agent.toolCall.created", { name: "session_create" }),
    ]);
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
        return fakeGoal({ status: request.status === "paused" ? "paused" : "active", pausedReason: request.status === "paused" ? "api" : null });
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

  test("goal.* events on a shared log refetch the goal", async () => {
    let reads = 0;
    const client = fakeClient({
      getGoal: async () => {
        reads += 1;
        return fakeGoal({ status: "paused" });
      },
    });
    const hook = await renderHook(
      (events: SessionEvent[]) => useGoal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
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
      (sessionId: string) => useGoal(sessionId, { client, workspaceId: WORKSPACE_ID, events: noEvents }),
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
  test("interrupt and approval decisions post the typed control events", async () => {
    const sent: unknown[] = [];
    const client = fakeClient({
      interrupt: async (_ws, _session, options) => {
        sent.push({ kind: "interrupt", ...options });
        return makeEvent(1, "user.interrupt");
      },
      sendApprovalDecision: async (_ws, _session, decision) => {
        sent.push({ kind: "decision", ...decision });
        return makeEvent(2, "user.approvalDecision");
      },
    });
    const hook = await renderHook(
      () => useSessionControl(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flushing(async () => {
      await hook.result.current.interrupt("stop now");
      await hook.result.current.approve("ap-1", "looks safe");
      await hook.result.current.reject("ap-2");
    });
    expect(sent).toEqual([
      { kind: "interrupt", reason: "stop now" },
      { kind: "decision", approvalId: "ap-1", decision: "approve", message: "looks safe" },
      { kind: "decision", approvalId: "ap-2", decision: "reject" },
    ]);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });
});

describe("useComposer queue-vs-steer", () => {
  test("defaults to queue mode and sendMessage", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      sendMessage: async () => {
        calls.push("send");
        return makeEvent(1, "user.message");
      },
      steerMessage: async () => {
        calls.push("steer");
        return { accepted: makeEvent(1, "user.message"), turn: null, interrupted: false };
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    expect(hook.result.current.mode).toBe("queue");
    await flushing(async () => {
      await hook.result.current.send("queued message");
    });
    expect(calls).toEqual(["send"]);
    await hook.unmount();
  });

  test("steer mode routes the send through steerMessage", async () => {
    const steered: unknown[] = [];
    const client = fakeClient({
      steerMessage: async (_ws, _session, message) => {
        steered.push(message);
        return { accepted: makeEvent(1, "user.message"), turn: null, interrupted: true };
      },
    });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flushing(async () => {
      hook.result.current.setMode("steer");
    });
    expect(hook.result.current.mode).toBe("steer");
    await flushing(async () => {
      const sent = await hook.result.current.send("do this immediately");
      expect(sent).toBe(true);
    });
    expect(steered).toHaveLength(1);
    const input = steered[0] as { text: string; clientEventId?: string };
    expect(input.text).toBe("do this immediately");
    expect(typeof input.clientEventId).toBe("string");
    await hook.unmount();
  });
});

describe("useComposer file-only send", () => {
  test("canSend lights up with a ready resource even when the draft is empty", async () => {
    const client = fakeClient({ sendMessage: async () => makeEvent(1, "user.message") });
    const hook = await renderHook(
      () => useComposer(SESSION_ID, {
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
      () => useComposer(SESSION_ID, {
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
      await hook.result.current.create({ name: "staging", variables: [{ name: "EXAMPLE_TOKEN", value: "v" }] });
    });
    expect(hook.result.current.environments.map((environment) => environment.name)).toEqual(["staging"]);
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
    const hook = await renderHook(
      () => usePacks({ client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
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
          balance: { accountId: "acc-1", balanceMicros: 12_000_000, currency: "usd" as const, updatedAt: "" },
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
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5", "accounts/fireworks/models/glm-5p2"],
          models: [
            { id: "gpt-5.5", label: "gpt-5.5", provider: "openai", providerLabel: "OpenAI", api: "responses" },
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
    expect(hook.result.current.defaultModel).toBe("gpt-5.5");
    expect(hook.result.current.models.map((model) => model.label)).toEqual(["gpt-5.5", "GLM 5.2"]);
    expect(hook.result.current.models.map((model) => model.providerLabel)).toEqual(["OpenAI", "Fireworks AI"]);
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
