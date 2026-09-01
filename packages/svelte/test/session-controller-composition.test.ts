import { describe, expect, test } from "bun:test";
import { reconcileSessionControllerComposition } from "../src/session-controller-composition";

function refreshable(name: string, calls: string[], failure?: Error) {
  return {
    controller: {
      refresh: async () => {
        calls.push(name);
        if (failure) throw failure;
      },
    },
  } as never;
}

describe("native Svelte session controller composition", () => {
  test("reconciles every authoritative projection even when one refresh rejects", async () => {
    const calls: string[] = [];
    const failure = new Error("queue refresh failed");
    const reconciliation = reconcileSessionControllerComposition({
      session: refreshable("session", calls),
      composer: refreshable("composer", calls),
      queue: refreshable("queue", calls, failure),
      goal: refreshable("goal", calls),
      humanInput: refreshable("humanInput", calls),
      lineage: refreshable("lineage", calls),
    });

    await expect(reconciliation).rejects.toBe(failure);
    expect(calls).toEqual(["session", "composer", "queue", "goal", "humanInput", "lineage"]);
  });
});
