import { describe, expect, mock, test } from "bun:test";

import { checkpointHistoryBeforeProviderDispatch } from "../src/activities/agent-turn/provider-dispatch-barrier";

describe("provider dispatch history barrier", () => {
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
