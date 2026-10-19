import { describe, expect, test } from "bun:test";
import { BrowserWindowParking, type WindowParkingConnection } from "../src/window-parking";

type FakeWindow = { state: "normal" | "minimized" | "maximized" | "fullscreen" };

function harness(options: {
  windows: Record<number, FakeWindow>;
  targets: Record<string, number>;
  rendering?: boolean;
}) {
  const calls: string[] = [];
  let failPresent = false;
  const connection: WindowParkingConnection = {
    async send<T>(method: string, params?: Readonly<Record<string, unknown>>): Promise<T> {
      if (method === "Browser.getWindowForTarget") {
        const windowId = options.targets[params?.targetId as string];
        if (windowId === undefined) throw new Error("No target with given id");
        return { windowId, bounds: { windowState: options.windows[windowId]!.state } } as T;
      }
      if (method === "Browser.setWindowBounds") {
        const windowId = params?.windowId as number;
        const bounds = params?.bounds as { windowState: FakeWindow["state"] };
        const state = bounds.windowState;
        if (failPresent && state !== "minimized") throw new Error("window manager refused");
        calls.push(`${windowId}:${state}`);
        options.windows[windowId]!.state = state;
        return {} as T;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  let pending: (() => void) | null = null;
  const errors: string[] = [];
  const parking = new BrowserWindowParking({
    idleMs: 60_000,
    connection: () => connection,
    pageTargetIds: async () => Object.keys(options.targets),
    ...(options.rendering
      ? {
          suspendRendering: async () => {
            calls.push("suspend");
          },
          resumeRendering: async () => {
            calls.push("resume");
          },
        }
      : {}),
    onError: (phase) => errors.push(phase),
    setTimer: (callback) => {
      pending = callback;
      return callback;
    },
    clearTimer: (handle) => {
      if (pending === handle) pending = null;
    },
  });
  return {
    parking,
    calls,
    errors,
    failPresent: (value: boolean) => {
      failPresent = value;
    },
    hasPendingPark: () => pending !== null,
    /** Fires the idle timer and waits for the parking step to finish. */
    async idle() {
      const callback = pending;
      pending = null;
      callback?.();
      // The park step is serialized behind any earlier step; a following
      // acquire/release round trip drains it.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
  };
}

describe("BrowserWindowParking", () => {
  test("parks each of the browser's windows once after idling, and presents them before the next use", async () => {
    const h = harness({
      windows: { 1: { state: "maximized" }, 2: { state: "normal" } },
      targets: { a: 1, b: 1, c: 2 },
    });
    // First use of a (possibly reattached) browser checks once for parked windows.
    (await h.parking.acquire())();
    expect(h.calls).toEqual([]);
    expect(h.hasPendingPark()).toBe(true);
    await h.idle();
    expect(h.calls).toEqual(["1:minimized", "2:minimized"]);
    const release = await h.parking.acquire();
    expect(h.calls.slice(2)).toEqual(["1:maximized", "2:normal"]);
    expect(h.hasPendingPark()).toBe(false);
    release();
    release();
    expect(h.hasPendingPark()).toBe(true);
  });

  test("an ordinary use of a presented browser sends no window commands", async () => {
    const h = harness({ windows: { 1: { state: "normal" } }, targets: { a: 1 } });
    (await h.parking.acquire())();
    const before = h.calls.length;
    for (let i = 0; i < 5; i += 1) (await h.parking.acquire())();
    expect(h.calls.length).toBe(before);
  });

  test("never parks while any use or live view holds the browser", async () => {
    const h = harness({ windows: { 1: { state: "normal" } }, targets: { a: 1 } });
    h.parking.arm();
    const liveView = await h.parking.acquire();
    expect(h.hasPendingPark()).toBe(false);
    const action = await h.parking.acquire();
    action();
    expect(h.hasPendingPark()).toBe(false);
    await h.idle();
    expect(h.calls).toEqual([]);
    liveView();
    await h.idle();
    expect(h.calls).toEqual(["1:minimized"]);
  });

  test("presents windows a previous controller left minimized", async () => {
    const h = harness({ windows: { 7: { state: "minimized" } }, targets: { a: 7 } });
    (await h.parking.acquire())();
    expect(h.calls).toEqual(["7:normal"]);
  });

  test("a window that cannot be presented never fails the use, and is retried next time", async () => {
    const h = harness({ windows: { 1: { state: "normal" } }, targets: { a: 1 } });
    h.parking.arm();
    await h.idle();
    h.failPresent(true);
    (await h.parking.acquire())();
    expect(h.errors).toEqual(["present"]);
    h.failPresent(false);
    (await h.parking.acquire())();
    expect(h.calls).toEqual(["1:minimized", "1:normal"]);
  });

  test("stops parking once closed", async () => {
    const h = harness({ windows: { 1: { state: "normal" } }, targets: { a: 1 } });
    h.parking.arm();
    h.parking.close();
    expect(h.hasPendingPark()).toBe(false);
    (await h.parking.acquire())();
    expect(h.hasPendingPark()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  test("suspends rendering overrides before minimizing, and resumes them after presenting", async () => {
    const h = harness({ windows: { 1: { state: "normal" } }, targets: { a: 1 }, rendering: true });
    (await h.parking.acquire())();
    expect(h.calls).toEqual([]);
    await h.idle();
    expect(h.calls).toEqual(["suspend", "1:minimized"]);
    (await h.parking.acquire())();
    expect(h.calls).toEqual(["suspend", "1:minimized", "1:normal", "resume"]);
    (await h.parking.acquire())();
    expect(h.calls.length).toBe(4);
  });
});
