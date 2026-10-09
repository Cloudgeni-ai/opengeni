import { describe, expect, test } from "bun:test";
import {
  withSandboxProviderCapture,
  withSandboxProviderOperation,
} from "../src/sandbox/provider-operation-gate";

describe("sandbox provider operation gate", () => {
  test("drains existing operations, runs capture exclusively, then releases queued operations", async () => {
    const session = {};
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseCapture: (() => void) | undefined;
    const captureBlocked = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });

    const first = withSandboxProviderOperation(session, async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    await Bun.sleep(0);
    const capture = withSandboxProviderCapture(session, async () => {
      order.push("capture:start");
      await captureBlocked;
      order.push("capture:end");
    });
    const waits: Array<{ durationMs: number; outcome: string }> = [];
    const second = withSandboxProviderOperation(
      session,
      async () => {
        order.push("second");
      },
      (observation) => waits.push(observation),
    );
    await Bun.sleep(0);
    expect(order).toEqual(["first:start"]);

    releaseFirst?.();
    await first;
    await Bun.sleep(0);
    expect(order).toEqual(["first:start", "first:end", "capture:start"]);

    releaseCapture?.();
    await capture;
    await second;
    expect(order).toEqual(["first:start", "first:end", "capture:start", "capture:end", "second"]);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ outcome: "completed" });
    expect(waits[0]!.durationMs).toBeGreaterThan(0);
  });

  test("omits capture-wait telemetry when operation admission is immediate", async () => {
    let observed = false;
    await withSandboxProviderOperation(
      {},
      async () => undefined,
      () => {
        observed = true;
      },
    );
    expect(observed).toBe(false);
  });

  test("releases both operation and capture paths after rejection", async () => {
    const session = {};
    const failure = new Error("expected provider failure");
    let operationError: unknown;
    try {
      await withSandboxProviderOperation(session, async () => {
        throw failure;
      });
    } catch (error) {
      operationError = error;
    }
    expect(operationError).toBe(failure);

    let captureError: unknown;
    try {
      await withSandboxProviderCapture(session, async () => {
        throw failure;
      });
    } catch (error) {
      captureError = error;
    }
    expect(captureError).toBe(failure);
    expect(await withSandboxProviderOperation(session, async () => "ready")).toBe("ready");
  });
  test("an aborted queued capture never runs and releases the operations it held back", async () => {
    const session = {};
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withSandboxProviderOperation(session, async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    await Bun.sleep(0);
    const abort = new AbortController();
    const capture = withSandboxProviderCapture(
      session,
      async () => {
        order.push("capture");
      },
      abort.signal,
    );
    const second = withSandboxProviderOperation(session, async () => {
      order.push("second");
    });
    await Bun.sleep(0);
    expect(order).toEqual(["first:start"]);

    const reason = new Error("capture budget elapsed");
    abort.abort(reason);
    await expect(capture).rejects.toBe(reason);
    await second;
    expect(order).toEqual(["first:start", "second"]);

    releaseFirst?.();
    await first;
    expect(order).toEqual(["first:start", "second", "first:end"]);
    // The gate is fully released: a later capture is admitted immediately.
    expect(await withSandboxProviderCapture(session, async () => "captured")).toBe("captured");
  });

  test("an aborted waiter keeps later queued captures ordered and exclusive", async () => {
    const session = {};
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withSandboxProviderOperation(session, async () => {
      await firstBlocked;
      order.push("first:end");
    });
    await Bun.sleep(0);
    const abort = new AbortController();
    const abandoned = withSandboxProviderCapture(
      session,
      async () => {
        order.push("abandoned");
      },
      abort.signal,
    );
    const kept = withSandboxProviderCapture(session, async () => {
      order.push("kept");
    });
    const later = withSandboxProviderOperation(session, async () => {
      order.push("later");
    });
    abort.abort(new Error("abandon"));
    await expect(abandoned).rejects.toThrow("abandon");
    await Bun.sleep(0);
    // The remaining queued capture still holds operations back.
    expect(order).toEqual([]);

    releaseFirst?.();
    await Promise.all([first, kept, later]);
    expect(order).toEqual(["first:end", "kept", "later"]);
  });

  test("an already aborted signal rejects before taking the gate", async () => {
    const session = {};
    const reason = new Error("already elapsed");
    let ran = false;
    await expect(
      withSandboxProviderCapture(
        session,
        async () => {
          ran = true;
        },
        AbortSignal.abort(reason),
      ),
    ).rejects.toBe(reason);
    expect(ran).toBe(false);
    expect(await withSandboxProviderOperation(session, async () => "ready")).toBe("ready");
  });

  test("aborting after admission leaves the running capture in charge of its own settlement", async () => {
    const session = {};
    const abort = new AbortController();
    let finish: (() => void) | undefined;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const capture = withSandboxProviderCapture(
      session,
      async () => {
        await running;
        return "settled";
      },
      abort.signal,
    );
    await Bun.sleep(0);
    abort.abort(new Error("late"));
    finish?.();
    expect(await capture).toBe("settled");
  });
});
