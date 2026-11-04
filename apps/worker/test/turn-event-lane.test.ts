import { describe, expect, test } from "bun:test";
import { createObservability } from "@opengeni/observability";
import { testSettings } from "@opengeni/testing/settings";
import { createTurnEventLane } from "../src/activities/agent-turn/turn-event-lane";
import {
  publishStartupProgress,
  type TurnBackgroundEventPublisher,
  type TurnEventPublisher,
} from "../src/activities/agent-turn/model-usage";
import { withSandboxStartupPhases } from "../src/activities/agent-turn/sandbox-startup-phase";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("turn event lane", () => {
  test("a background receipt does not hold up the caller, and the next awaited append follows it", async () => {
    const lane = createTurnEventLane();
    const order: string[] = [];
    const receipt = gate();
    lane.runInBackground(async () => {
      order.push("receipt:start");
      await receipt.promise;
      order.push("receipt:end");
    });
    // The caller continues at once; the receipt is already on its way.
    await flush();
    expect(order).toEqual(["receipt:start"]);
    const audit = lane.run(async () => {
      order.push("audit");
      return "audited";
    });
    await flush();
    expect(order).toEqual(["receipt:start"]);
    receipt.release();
    expect(await audit).toBe("audited");
    expect(order).toEqual(["receipt:start", "receipt:end", "audit"]);
  });

  test("a background receipt starts after awaited appends already in flight", async () => {
    const lane = createTurnEventLane();
    const order: string[] = [];
    const first = gate();
    const running = lane.run(async () => {
      order.push("append:start");
      await first.promise;
      order.push("append:end");
    });
    await flush();
    lane.runInBackground(async () => {
      order.push("receipt");
    });
    await flush();
    expect(order).toEqual(["append:start"]);
    first.release();
    await running;
    await lane.backgroundSettled();
    expect(order).toEqual(["append:start", "append:end", "receipt"]);
  });

  test("awaited appends stay concurrent with each other", async () => {
    const lane = createTurnEventLane();
    const started: string[] = [];
    const held = gate();
    const a = lane.run(async () => {
      started.push("a");
      await held.promise;
    });
    const b = lane.run(async () => {
      started.push("b");
    });
    await b;
    expect(started).toEqual(["a", "b"]);
    held.release();
    await a;
  });

  test("receipts keep their issue order", async () => {
    const lane = createTurnEventLane();
    const order: number[] = [];
    for (const n of [1, 2, 3]) {
      lane.runInBackground(async () => {
        await Bun.sleep(4 - n);
        order.push(n);
      });
    }
    await lane.run(async () => {
      order.push(4);
    });
    expect(order).toEqual([1, 2, 3, 4]);
  });

  test("a failed receipt neither fails later appends nor the drain", async () => {
    const lane = createTurnEventLane();
    lane.runInBackground(async () => {
      throw new Error("delivery failed");
    });
    await expect(lane.run(async () => "next")).resolves.toBe("next");
    await expect(lane.backgroundSettled()).resolves.toBeUndefined();
  });

  test("an awaited append's own failure still reaches its caller", async () => {
    const lane = createTurnEventLane();
    const failure = new Error("fenced");
    await expect(
      lane.run(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    lane.runInBackground(async () => undefined);
    await expect(lane.backgroundSettled()).resolves.toBeUndefined();
  });

  test("the drain waits for receipts, including ones issued while it waits", async () => {
    const lane = createTurnEventLane();
    const done: string[] = [];
    const first = gate();
    lane.runInBackground(async () => {
      await first.promise;
      done.push("first");
    });
    let drained = false;
    const drain = lane.backgroundSettled().then(() => {
      drained = true;
    });
    const second = gate();
    lane.runInBackground(async () => {
      await second.promise;
      done.push("second");
    });
    first.release();
    await flush();
    expect(drained).toBe(false);
    second.release();
    await drain;
    expect(done).toEqual(["first", "second"]);
  });
});

describe("startup progress receipts", () => {
  const accepted = { events: [], accepted: true, canonicalStartupMilestones: [] };

  test("go to the background lane when the attempt wired one", async () => {
    const background: Array<Parameters<TurnEventPublisher>[0]> = [];
    const publish: TurnEventPublisher = async () => {
      throw new Error("must not await a progress receipt");
    };
    const publishInBackground: TurnBackgroundEventPublisher = (events) => {
      background.push(events);
    };
    await publishStartupProgress({ publish, publishInBackground }, [
      { type: "turn.startup.phase.started", payload: { phase: "tools" } },
    ]);
    expect(background).toEqual([
      [{ type: "turn.startup.phase.started", payload: { phase: "tools" } }],
    ]);
  });

  test("stay ordinary awaited appends without a lane", async () => {
    const published: Array<Parameters<TurnEventPublisher>[0]> = [];
    await publishStartupProgress(
      {
        publish: async (events) => {
          published.push(events);
          return accepted;
        },
        publishInBackground: null,
      },
      [{ type: "turn.startup.phase.started", payload: { phase: "tools" } }],
    );
    expect(published).toHaveLength(1);
  });

  test("sandbox startup receipts flush without waiting for their delivery", async () => {
    const observability = createObservability(testSettings(), { component: "worker" });
    const lane = createTurnEventLane();
    const delivery = gate();
    const delivered: Array<Parameters<TurnEventPublisher>[0]> = [];
    const append: TurnEventPublisher = async (events) => {
      await delivery.promise;
      delivered.push(events);
      return accepted;
    };
    const publishInBackground: TurnBackgroundEventPublisher = (events, options) => {
      lane.runInBackground(() =>
        options?.measureDelivery ? options.measureDelivery(() => append(events)) : append(events),
      );
    };
    const result = await withSandboxStartupPhases(
      {
        observability,
        provider: "test",
        backend: "modal",
        publish: async () => {
          throw new Error("must not await sandbox startup receipts");
        },
        publishInBackground,
      },
      async (measure) => measure("credential_mint", async () => 7),
    );
    // The operation finished while its receipt is still being delivered.
    expect(result).toBe(7);
    expect(delivered).toHaveLength(0);
    delivery.release();
    await lane.backgroundSettled();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]![0]).toMatchObject({
      type: "turn.startup.phase.completed",
      payload: { phase: "credential_mint" },
    });
    expect(await observability.prometheusMetrics()).toMatch(
      /opengeni_turn_startup_phase_duration_seconds_count\{[^}]*outcome="completed"[^}]*phase="startup_phase_delivery"[^}]*\} 1\b/,
    );
  });
});
