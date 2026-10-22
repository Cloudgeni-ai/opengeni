import { describe, expect, mock, test } from "bun:test";
import { Agent, Runner, tool, type ModelRequest, type StreamEvent } from "@openai/agents";
import {
  ActiveBackendUnresolvableError,
  RoutingSandboxSession,
  RoutingWorkspaceRootChangedError,
  type RoutableBackendSession,
} from "@opengeni/runtime";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from "../../../packages/testing/src/scripted-model";

import {
  ActiveRouteDispatchBoundary,
  checkpointHistoryBeforeProviderDispatch,
} from "../src/activities/agent-turn/provider-dispatch-barrier";
import { sandboxRouteTransitionCode } from "../src/activities/agent-turn/errors";

function routedSession() {
  let pointer = { activeSandboxId: null as string | null, activeEpoch: 0 };
  const calls: string[] = [];
  const backend = (name: string, root: string): RoutableBackendSession => ({
    state: { manifest: { root } },
    exec: async (args: unknown) => {
      calls.push(`${name}:${(args as { cmd: string }).cmd}`);
      return { stdout: name, exitCode: 0 };
    },
  });
  const home = backend("home", "/workspace");
  const machine = backend("machine", "/srv/project");
  const session = new RoutingSandboxSession({
    defaultResolved: { session: home, sandboxId: null, kind: "modal" },
    readPointer: async () => ({ ...pointer }),
    resolveActiveBackend: async (route) => {
      if (route.activeSandboxId === "offline")
        throw new ActiveBackendUnresolvableError("offline_enrollment", "offline");
      return route.activeSandboxId === null
        ? { session: home, sandboxId: null, kind: "modal" }
        : { session: machine, sandboxId: route.activeSandboxId, kind: "selfhosted" };
    },
  });
  return {
    session,
    calls,
    pointer: () => ({ ...pointer }),
    swap: (target: string | null) => {
      pointer = { activeSandboxId: target, activeEpoch: pointer.activeEpoch + 1 };
    },
  };
}

function routeBoundary(session: RoutingSandboxSession) {
  return new ActiveRouteDispatchBoundary({
    session: () => session,
    isRouteTransition: (error) => sandboxRouteTransitionCode(error) !== null,
  });
}

describe("provider dispatch history barrier", () => {
  test("the SDK exposes complete tool history before its follow-up model call", async () => {
    let activeStream: { state: { history?: unknown[] } } | null = null;
    const dispatchSnapshots: Array<{ installed: boolean; history: unknown[] }> = [];
    class DispatchObservedModel extends ScriptedModel {
      override async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
        const history = activeStream?.state.history;
        dispatchSnapshots.push({
          installed: activeStream !== null,
          history: Array.isArray(history) ? [...history] : [],
        });
        yield* super.getStreamedResponse(request);
      }
    }
    const model = new DispatchObservedModel([
      { output: [functionCall("echo", {}, "dispatch-call-1")] },
      { output: [assistantMessage("done")] },
    ]);
    const echo = tool({
      name: "echo",
      description: "Return a fixed value.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
      execute: async () => "ok",
    });
    const agent = new Agent({
      name: "dispatch-history-test",
      instructions: "Use echo once.",
      model,
      tools: [echo],
    });

    const result = await new Runner().run(agent, "start", {
      stream: true,
      historyOwnership: "external",
    });
    activeStream = result as unknown as { state: { history?: unknown[] } };
    for await (const _event of result.toStream()) {
      // Drain the public stream while the SDK owns its background model/tool loop.
    }
    await result.completed;

    expect(dispatchSnapshots.map((snapshot) => snapshot.installed)).toEqual([true, true]);
    expect(dispatchSnapshots[1]?.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function_call", callId: "dispatch-call-1" }),
        expect.objectContaining({ type: "function_call_result", callId: "dispatch-call-1" }),
      ]),
    );
  });

  test("awaits durable prior history before allowing provider work to continue", async () => {
    const order: string[] = [];
    let releaseCheckpoint!: () => void;
    const checkpointReleased = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    const historySink = {
      reconcileConversationTruth: mock(async () => {
        order.push("checkpoint-started");
        await checkpointReleased;
        order.push("checkpoint-completed");
      }),
    };

    const dispatch = checkpointHistoryBeforeProviderDispatch(historySink).then(() => {
      order.push("provider-dispatch");
    });
    await Promise.resolve();

    expect(order).toEqual(["checkpoint-started"]);
    expect(historySink.reconcileConversationTruth).toHaveBeenCalledWith({
      requireDurable: true,
    });

    releaseCheckpoint();
    await dispatch;
    expect(order).toEqual(["checkpoint-started", "checkpoint-completed", "provider-dispatch"]);
  });

  test("a swap to another workspace root ends the attempt before the model chooses its next calls", async () => {
    const routed = routedSession();
    const activeRoute = routeBoundary(routed.session);
    const historySink = { reconcileConversationTruth: mock(async () => {}) };
    const requestedResponses: number[] = [];
    class BarrierModel extends ScriptedModel {
      override async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
        await checkpointHistoryBeforeProviderDispatch(historySink, {
          effectiveSandboxBackend: "modal",
          routingEnabled: true,
          readActiveSandbox: async () => routed.pointer(),
          activeRoute,
        });
        requestedResponses.push(requestedResponses.length + 1);
        yield* super.getStreamedResponse(request);
      }
    }
    const model = new BarrierModel([
      { output: [functionCall("swap", {}, "swap-call")] },
      { output: [functionCall("run", {}, "run-call")] },
      { output: [assistantMessage("done")] },
    ]);
    const swap = tool({
      name: "swap",
      description: "Move this chat to the machine.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
      execute: async () => {
        routed.swap("machine");
        return "swapped";
      },
    });
    const run = tool({
      name: "run",
      description: "Run a command.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: false,
      execute: async () => await routed.session.exec({ cmd: "after-swap" }),
    });
    const agent = new Agent({
      name: "route-boundary-test",
      instructions: "Swap, then run.",
      model,
      tools: [swap, run],
    });

    const result = await new Runner().run(agent, "start", {
      stream: true,
      historyOwnership: "external",
    });
    let failure: unknown = null;
    try {
      for await (const _event of result.toStream()) {
        // Drain the stream while the SDK owns its model/tool loop.
      }
      await result.completed;
    } catch (error) {
      failure = error;
    }
    failure ??= result.error;

    expect(sandboxRouteTransitionCode(failure)).toBe("workspace_root_changed_this_turn");
    expect(failure).toBeInstanceOf(RoutingWorkspaceRootChangedError);
    // Only the swap's batch ran; the model was never asked for (and so never
    // lost) a response chosen against the old machine.
    expect(requestedResponses).toEqual([1]);
    expect(routed.calls).toEqual([]);
    expect(historySink.reconcileConversationTruth).toHaveBeenCalledTimes(2);
  });

  test("an unmoved route, a servable move and other resolution failures leave the attempt running", async () => {
    const routed = routedSession();
    const activeRoute = routeBoundary(routed.session);
    const assert = mock(routed.session.assertActiveRouteContinuable.bind(routed.session));
    routed.session.assertActiveRouteContinuable = assert;

    await activeRoute.check(routed.pointer());
    await activeRoute.check(routed.pointer());
    expect(assert).not.toHaveBeenCalled();

    routed.swap(null);
    await activeRoute.check(routed.pointer());
    expect(assert).toHaveBeenCalledTimes(1);

    // An offline target is not an attempt boundary: the next call that needs
    // the machine reports it, exactly as before.
    routed.swap("offline");
    await activeRoute.check(routed.pointer());
    expect(assert).toHaveBeenCalledTimes(2);
    expect(routed.calls).toEqual([]);
  });

  test("wires the barrier before generic and native provider started audits", async () => {
    const runSource = await Bun.file(
      new URL("../src/activities/agent-turn/run.ts", import.meta.url),
    ).text();
    const streamSource = await Bun.file(
      new URL("../src/activities/agent-turn/stream-attempt.ts", import.meta.url),
    ).text();

    const genericCallback = streamSource.indexOf(
      "const recordFallbackProviderDispatchAtWire = async",
    );
    const genericBarrier = streamSource.indexOf(
      "await checkpointBeforeProviderDispatch();",
      genericCallback,
    );
    const genericAudit = streamSource.indexOf('type: "agent.model.request"', genericBarrier);
    expect(genericCallback).toBeGreaterThan(-1);
    expect(genericBarrier).toBeGreaterThan(genericCallback);
    expect(genericAudit).toBeGreaterThan(genericBarrier);

    const nativeCallbacks = [...runSource.matchAll(/onModelRequestEvent: async \(event\) => \{/gu)];
    expect(nativeCallbacks).toHaveLength(2);
    for (const callback of nativeCallbacks) {
      const callbackAt = callback.index!;
      const nextCallbackAt = runSource.indexOf("onModelRequestEvent: async", callbackAt + 1);
      const callbackEnd = nextCallbackAt === -1 ? runSource.length : nextCallbackAt;
      const barrierAt = runSource.indexOf("await checkpointBeforeProviderDispatch();", callbackAt);
      const auditAt = runSource.indexOf("await eventing.publish([", callbackAt);
      expect(barrierAt).toBeGreaterThan(callbackAt);
      expect(barrierAt).toBeLessThan(callbackEnd);
      expect(auditAt).toBeGreaterThan(barrierAt);
    }
  });
});
