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
    const second = withSandboxProviderOperation(session, async () => {
      order.push("second");
    });
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
});
