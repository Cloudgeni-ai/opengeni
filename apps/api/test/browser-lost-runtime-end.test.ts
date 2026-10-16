import { describe, expect, test } from "bun:test";
import { BrowserControlRequestError } from "@opengeni/runtime/sandbox";
import {
  endBrowserDiscardingLostRuntime,
  endExpiredResumeSettingAsideInterruptedLaunch,
} from "../src/browser-lost-runtime-end";

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
  type EndOptions = {
    removeState: boolean;
    discardWorkingRuntime?: boolean;
    setAsideInterruptedLaunch?: boolean;
  };
  const calls: EndOptions[] = [];
  return {
    calls,
    endSession: async (_reference: typeof reference, options: EndOptions) => {
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

describe("returning an expired resume to its checkpoint", () => {
  const notFound = new BrowserControlRequestError(404, {
    code: "resource_not_found",
    message: "browser session not found",
    retryable: false,
  });
  const unknownField = new BrowserControlRequestError(400, {
    code: "invalid_action",
    message: "request contains unknown fields",
    retryable: false,
  });

  test("a resident or never-launched attempt ends with one plain end", async () => {
    for (const response of [null, notFound]) {
      const fake = client([response]);
      await endExpiredResumeSettingAsideInterruptedLaunch(fake, reference);
      expect(fake.calls).toEqual([{ removeState: true }]);
    }
  });

  test("a preserved interrupted launch is set aside, never discarded", async () => {
    const fake = client([preserved, null]);
    await endExpiredResumeSettingAsideInterruptedLaunch(fake, reference);
    expect(fake.calls).toEqual([
      { removeState: true },
      { removeState: true, setAsideInterruptedLaunch: true },
    ]);
    expect(fake.calls.some((call) => call.discardWorkingRuntime)).toBe(false);
  });

  test("a retry after the attempt was already set aside settles", async () => {
    const fake = client([preserved, notFound]);
    await endExpiredResumeSettingAsideInterruptedLaunch(fake, reference);
    expect(fake.calls).toHaveLength(2);
  });

  test("a refused set-aside or an older controller keeps the browser preserved", async () => {
    for (const second of [preserved, unknownField]) {
      const fake = client([preserved, second]);
      await expect(endExpiredResumeSettingAsideInterruptedLaunch(fake, reference)).rejects.toBe(
        preserved,
      );
    }
    const busy = new BrowserControlRequestError(409, {
      code: "resource_unavailable",
      message: "browser controller is busy",
      retryable: true,
    });
    const fake = client([busy]);
    await expect(endExpiredResumeSettingAsideInterruptedLaunch(fake, reference)).rejects.toBe(busy);
    expect(fake.calls).toEqual([{ removeState: true }]);
  });
});
