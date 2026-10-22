import { describe, expect, test } from "bun:test";
import type { CodemodeOperation } from "@opengeni/contracts";
import {
  awaitCodemodeSettlement,
  codemodeSettlementWake,
  isCodemodeSettlementEvent,
} from "../src/codemode";

const OPERATION_ID = "00000000-0000-4000-8000-0000000000a1";

function operation(state: CodemodeOperation["state"]): CodemodeOperation {
  return { operationId: OPERATION_ID, state } as CodemodeOperation;
}

describe("Codemode submission settlement", () => {
  test("recognizes only this operation's settlement event", () => {
    expect(
      isCodemodeSettlementEvent(
        { type: "agent.toolCall.output", payload: { id: OPERATION_ID } },
        OPERATION_ID,
      ),
    ).toBe(true);
    expect(
      isCodemodeSettlementEvent(
        { type: "agent.toolCall.output", payload: { id: "other" } },
        OPERATION_ID,
      ),
    ).toBe(false);
    expect(
      isCodemodeSettlementEvent(
        { type: "agent.message.delta", payload: { id: OPERATION_ID } },
        OPERATION_ID,
      ),
    ).toBe(false);
  });

  test("returns the settled operation as soon as its event wakes the wait", async () => {
    const wake = codemodeSettlementWake();
    let settled = false;
    let reads = 0;
    const started = performance.now();
    setTimeout(() => {
      settled = true;
      wake.notify();
    }, 20);
    const result = await awaitCodemodeSettlement({
      operation: operation("running"),
      read: async () => {
        reads += 1;
        return operation(settled ? "completed" : "running");
      },
      wake,
      budgetMs: 5_000,
      fallbackReadMs: 2_000,
    });
    expect(result.state).toBe("completed");
    expect(reads).toBe(1);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("a notification that arrives before the wait is not lost", async () => {
    const wake = codemodeSettlementWake();
    wake.notify();
    const started = performance.now();
    await wake.wait(5_000);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("falls back to periodic reads when no event arrives", async () => {
    const wake = codemodeSettlementWake();
    let reads = 0;
    const result = await awaitCodemodeSettlement({
      operation: operation("running"),
      read: async () => {
        reads += 1;
        return operation(reads >= 3 ? "failed" : "running");
      },
      wake,
      budgetMs: 5_000,
      fallbackReadMs: 10,
    });
    expect(result.state).toBe("failed");
    expect(reads).toBe(3);
  });

  test("returns still running when the budget ends", async () => {
    const result = await awaitCodemodeSettlement({
      operation: operation("running"),
      read: async () => operation("running"),
      wake: codemodeSettlementWake(),
      budgetMs: 30,
      fallbackReadMs: 10,
    });
    expect(result.state).toBe("running");
  });

  test("does not wait for approval or terminal states, and stops on abort", async () => {
    let reads = 0;
    const read = async () => {
      reads += 1;
      return operation("running");
    };
    for (const state of ["waiting_for_approval", "completed", "failed"] as const) {
      const result = await awaitCodemodeSettlement({
        operation: operation(state),
        read,
        wake: codemodeSettlementWake(),
        budgetMs: 5_000,
        fallbackReadMs: 10,
      });
      expect(result.state).toBe(state);
    }
    expect(reads).toBe(0);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = performance.now();
    const aborted = await awaitCodemodeSettlement({
      operation: operation("running"),
      read,
      wake: codemodeSettlementWake(),
      budgetMs: 5_000,
      fallbackReadMs: 2_000,
      signal: controller.signal,
    });
    expect(aborted.state).toBe("running");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("keeps the last known row when a read fails", async () => {
    let reads = 0;
    const result = await awaitCodemodeSettlement({
      operation: operation("running"),
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("transient");
        return operation("completed");
      },
      wake: codemodeSettlementWake(),
      budgetMs: 5_000,
      fallbackReadMs: 5,
    });
    expect(result.state).toBe("completed");
  });
});
