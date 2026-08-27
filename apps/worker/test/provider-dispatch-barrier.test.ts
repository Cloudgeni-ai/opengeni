import { describe, expect, mock, test } from "bun:test";
import { Agent, Runner, tool, type ModelRequest, type StreamEvent } from "@openai/agents";
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from "../../../packages/testing/src/scripted-model";

import { checkpointHistoryBeforeProviderDispatch } from "../src/activities/agent-turn/provider-dispatch-barrier";

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
      "await checkpointHistoryBeforeProviderDispatch(historySink);",
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
      const barrierAt = runSource.indexOf(
        "await checkpointHistoryBeforeProviderDispatch(historySink);",
        callbackAt,
      );
      const auditAt = runSource.indexOf("await eventing.publish([", callbackAt);
      expect(barrierAt).toBeGreaterThan(callbackAt);
      expect(barrierAt).toBeLessThan(callbackEnd);
      expect(auditAt).toBeGreaterThan(barrierAt);
    }
  });
});
