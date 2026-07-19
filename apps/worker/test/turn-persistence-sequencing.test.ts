import { describe, expect, test } from "bun:test";
import { persistCompletedModelCallReceipt } from "../src/activities/turn-persistence-sequencing";

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
