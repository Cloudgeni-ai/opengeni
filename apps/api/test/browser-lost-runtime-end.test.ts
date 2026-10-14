import { describe, expect, test } from "bun:test";
import { BrowserControlRequestError } from "@opengeni/runtime/sandbox";
import { endBrowserDiscardingLostRuntime } from "../src/browser-lost-runtime-end";

const reference = {
  browserSessionId: "00000000-0000-4000-8000-000000000001",
  controllerGeneration: "controller-1",
};

const preserved = new BrowserControlRequestError(409, {
  code: "resource_unavailable",
  message: "Current browser is unavailable; its browser record and recovery state are preserved",
  retryable: false,
});

function client(responses: Array<Error | null>) {
  const calls: Array<{ removeState: boolean; discardWorkingRuntime?: boolean }> = [];
  return {
    calls,
    endSession: async (
      _reference: typeof reference,
      options: { removeState: boolean; discardWorkingRuntime?: boolean },
    ) => {
      calls.push(options);
      const next = responses.shift() ?? null;
      if (next) throw next;
    },
  };
}

describe("ending a browser whose controller lost it", () => {
  test("a resident browser ends with one plain end", async () => {
    const fake = client([null]);
    await endBrowserDiscardingLostRuntime(fake, reference);
    expect(fake.calls).toEqual([{ removeState: true }]);
  });

  test("a preserved lost runtime is discarded by the person's explicit end", async () => {
    const fake = client([preserved, null]);
    await endBrowserDiscardingLostRuntime(fake, reference);
    expect(fake.calls).toEqual([
      { removeState: true },
      { removeState: true, discardWorkingRuntime: true },
    ]);
  });

  test("an older controller that rejects the discard keeps its original refusal", async () => {
    const unknownField = new BrowserControlRequestError(400, {
      code: "invalid_action",
      message: "request contains unknown fields",
      retryable: false,
    });
    const fake = client([preserved, unknownField]);
    await expect(endBrowserDiscardingLostRuntime(fake, reference)).rejects.toBe(preserved);
  });

  test("other failures are never escalated into a discard", async () => {
    const busy = new BrowserControlRequestError(409, {
      code: "resource_unavailable",
      message: "browser controller is busy",
      retryable: true,
    });
    const stale = new BrowserControlRequestError(409, {
      code: "controller_stale",
      message: "stale controller generation",
      retryable: false,
    });
    for (const error of [busy, stale]) {
      const fake = client([error]);
      await expect(endBrowserDiscardingLostRuntime(fake, reference)).rejects.toBe(error);
      expect(fake.calls).toEqual([{ removeState: true }]);
    }
  });
});
