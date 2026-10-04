import { describe, expect, test } from "bun:test";
import type { CodemodeOperation } from "@opengeni/contracts";
import { recoverProgrammaticOperationsBeforeFirstRequest } from "../src/activities/programmatic-approvals";

const neverReady = new Promise<void>(() => undefined);
const settledWithin = async <T>(promise: Promise<T>, ms = 200): Promise<T | "timed_out"> =>
  await Promise.race([
    promise,
    new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), ms)),
  ]);

describe("first-request programmatic recovery", () => {
  test("an ordinary turn never waits on lazy MCP preparation", async () => {
    let resumed = false;
    const started = performance.now();
    const result = await settledWithin(
      recoverProgrammaticOperationsBeforeFirstRequest({
        approvalDecisionId: undefined,
        hasUnfinishedOperations: async () => false,
        // A lazy server that never finishes connecting/listing.
        toolPreparationReady: neverReady,
        resumeApproved: () => {
          resumed = true;
          return Promise.resolve([]);
        },
      }),
    );
    expect(result).toEqual([]);
    expect(resumed).toBe(false);
    expect(performance.now() - started).toBeLessThan(150);
  });

  test("a failed lazy preparation does not fail an ordinary first request", async () => {
    const failed = Promise.reject(new Error("lazy MCP failed"));
    void failed.catch(() => undefined);
    expect(
      await recoverProgrammaticOperationsBeforeFirstRequest({
        approvalDecisionId: undefined,
        hasUnfinishedOperations: async () => false,
        toolPreparationReady: failed,
        resumeApproved: () => Promise.resolve([]),
      }),
    ).toEqual([]);
  });

  test("stored unfinished operations wait for preparation and resume", async () => {
    let ready!: () => void;
    const preparation = new Promise<void>((resolve) => (ready = resolve));
    const operation = { operationId: "op" } as CodemodeOperation;
    const pending = recoverProgrammaticOperationsBeforeFirstRequest({
      approvalDecisionId: undefined,
      hasUnfinishedOperations: async () => true,
      toolPreparationReady: preparation,
      resumeApproved: (decision) => {
        expect(decision).toBeUndefined();
        return Promise.resolve([operation]);
      },
    });
    expect(await settledWithin(pending, 50)).toBe("timed_out");
    ready();
    expect(await pending).toEqual([operation]);
  });

  test("an approval decision waits for preparation without a journal read", async () => {
    let read = false;
    let ready!: () => void;
    const preparation = new Promise<void>((resolve) => (ready = resolve));
    const pending = recoverProgrammaticOperationsBeforeFirstRequest({
      approvalDecisionId: "decision",
      hasUnfinishedOperations: async () => {
        read = true;
        return false;
      },
      toolPreparationReady: preparation,
      resumeApproved: (decision) => Promise.resolve(decision ? [] : undefined!),
    });
    expect(await settledWithin(pending, 50)).toBe("timed_out");
    ready();
    expect(await pending).toEqual([]);
    expect(read).toBe(false);
  });

  test("no prepared dispatcher yields no operations", async () => {
    expect(
      await recoverProgrammaticOperationsBeforeFirstRequest({
        approvalDecisionId: "decision",
        hasUnfinishedOperations: async () => true,
        toolPreparationReady: null,
        resumeApproved: () => undefined,
      }),
    ).toEqual([]);
  });
});
