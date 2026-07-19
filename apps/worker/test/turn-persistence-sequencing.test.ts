import { describe, expect, test } from "bun:test";
import {
  persistCompletedModelCallReceipt,
  TurnPersistenceSequencer,
} from "../src/activities/turn-persistence-sequencing";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sequencing(failAt?: "ownership" | "history" | "meter" | "event") {
  const order: string[] = [];
  const run = persistCompletedModelCallReceipt({
    establishHandoff: () => order.push("heartbeat"),
    confirmOwnership: async () => {
      order.push("ownership");
      if (failAt === "ownership") throw new Error("ownership persistence failed");
    },
    persistHistory: async () => {
      order.push("history");
      if (failAt === "history") throw new Error("history persistence failed");
    },
    persistMetering: async () => {
      order.push("meter");
      if (failAt === "meter") throw new Error("meter persistence failed");
    },
    persistEvent: async () => {
      order.push("event");
      if (failAt === "event") throw new Error("event persistence failed");
      return "durable";
    },
  });
  return { order, run };
}

describe("completed model-call persistence sequencing", () => {
  test("establishes the handoff before history, metering, and the exact event", async () => {
    const { order, run } = sequencing();
    await expect(run).resolves.toBe("durable");
    expect(order).toEqual(["heartbeat", "ownership", "history", "meter", "event"]);
  });

  for (const phase of ["ownership", "history", "meter", "event"] as const) {
    test(`leaves later persistence phases untouched when ${phase} fails`, async () => {
      const { order, run } = sequencing(phase);
      await expect(run).rejects.toThrow(`${phase} persistence failed`);
      const persistencePhases = ["ownership", "history", "meter", "event"];
      const failedIndex = persistencePhases.indexOf(phase);
      expect(order).toEqual(["heartbeat", ...persistencePhases.slice(0, failedIndex + 1)]);
    });
  }
});

describe("turn persistence receipt sequencing", () => {
  test("settles the model receipt before establishing the queued tool receipt", async () => {
    const sequencer = new TurnPersistenceSequencer();
    const modelCanSettle = deferred();
    const order: string[] = [];

    const model = sequencer.run(async () => {
      order.push("model.establish");
      await modelCanSettle.promise;
      order.push("model.settle");
    });
    const tool = sequencer.run(async () => {
      order.push("tool.establish");
      order.push("tool.settle");
    });

    await Bun.sleep(0);
    expect(order).toEqual(["model.establish"]);
    modelCanSettle.resolve();
    await Promise.all([model, tool]);
    expect(order).toEqual(["model.establish", "model.settle", "tool.establish", "tool.settle"]);
  });

  test("does not allow the external tool effect while model persistence is pending", async () => {
    const sequencer = new TurnPersistenceSequencer();
    const modelCanSettle = deferred();
    let effects = 0;

    const model = sequencer.run(async () => {
      await modelCanSettle.promise;
    });
    const tool = sequencer
      .run(async () => {
        // Represents durable pending-tool registration and receipt settlement.
      })
      .then(() => {
        // The runtime invokes the external tool only after the callback resolves.
        effects += 1;
      });

    await Bun.sleep(0);
    expect(effects).toBe(0);
    modelCanSettle.resolve();
    await Promise.all([model, tool]);
    expect(effects).toBe(1);
  });

  test("returns the exact first handoff failure and never enters a queued tool boundary", async () => {
    const sequencer = new TurnPersistenceSequencer();
    const exactHandoffFailure = Object.assign(new Error("model persistence failed"), {
      handoff: { receiptId: "model-receipt" },
    });
    let toolBoundaryCalls = 0;

    const model = sequencer.run(async () => {
      throw exactHandoffFailure;
    });
    const tool = sequencer.run(async () => {
      toolBoundaryCalls += 1;
    });

    expect(await model.catch((error) => error)).toBe(exactHandoffFailure);
    expect(await tool.catch((error) => error)).toBe(exactHandoffFailure);
    expect(toolBoundaryCalls).toBe(0);
  });

  test("never overlaps sequential receipt regions", async () => {
    const sequencer = new TurnPersistenceSequencer();
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      Array.from({ length: 4 }, () =>
        sequencer.run(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(0);
          active -= 1;
        }),
      ),
    );

    expect(maximumActive).toBe(1);
  });
});
