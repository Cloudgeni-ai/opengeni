import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const build = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/service-worker.ts")],
  target: "browser",
  format: "iife",
});
if (!build.success) throw new Error("Could not build extension worker");
const worker = await build.outputs[0]!.text();
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function event() {
  const listeners: ((...args: any[]) => void)[] = [];
  return {
    addListener(fn: (...args: any[]) => void) {
      listeners.push(fn);
    },
    emit(...args: any[]) {
      for (const fn of listeners) fn(...args);
    },
  };
}
function harness() {
  const timers = new Map<number, { fn: () => void; delay: number }>();
  let timerId = 0;
  const ports: any[] = [];
  const onMessage = event();
  const storage: Record<string, unknown> = {};
  const chrome = {
    runtime: {
      getManifest: () => ({ version: "0.1.0" }),
      onMessage,
      getPlatformInfo: async () => ({ os: "mac", arch: "arm64" }),
      onInstalled: event(),
      onStartup: event(),
      lastError: undefined,
      connectNative: () => {
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          messages: [] as any[],
          disconnected: false,
          postMessage(message: unknown) {
            this.messages.push(message);
          },
          // Chrome only fires onDisconnect at the OTHER end on local disconnect.
          disconnect() {
            this.disconnected = true;
          },
        };
        ports.push(port);
        return port;
      },
    },
    storage: {
      local: {
        get: async () => ({ ...storage }),
        set: async (v: object) => Object.assign(storage, v),
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    debugger: { onEvent: event(), onDetach: event() },
    tabs: Object.fromEntries(
      [
        "onCreated",
        "onUpdated",
        "onRemoved",
        "onMoved",
        "onAttached",
        "onDetached",
        "onActivated",
        "onReplaced",
      ].map((k) => [k, event()]),
    ) as any,
  };
  chrome.tabs.query = async () => [];
  new Function("chrome", "navigator", "setTimeout", "clearTimeout", worker)(
    chrome,
    { userAgent: "Chrome/153.0.0.0" },
    (fn: () => void, delay: number) => {
      const id = ++timerId;
      timers.set(id, { fn, delay });
      return id;
    },
    (id: number) => timers.delete(id),
  );
  return {
    chrome,
    ports,
    status() {
      let result: any;
      onMessage.emit({ type: "status" }, {}, (r: unknown) => {
        result = r;
      });
      return result;
    },
    tick(delay: number) {
      const entry = [...timers.entries()].find(([, t]) => t.delay === delay);
      if (!entry) throw Error(`No timer ${delay}`);
      timers.delete(entry[0]);
      entry[1].fn();
    },
    hasTimer(delay: number) {
      return [...timers.values()].some((t) => t.delay === delay);
    },
  };
}

describe("native bridge reconnection", () => {
  test("a handshake timeout reconnects without a local onDisconnect event", async () => {
    const h = harness();
    await flush();
    h.tick(10_000);
    await flush();
    expect(h.ports[0].disconnected).toBe(true);
    expect(h.status().connectionGeneration).toBeNull();
    expect(h.hasTimer(500)).toBe(true);
    h.tick(500);
    await flush();
    expect(h.ports).toHaveLength(2);
    const hello = h.ports[1].messages[0];
    h.ports[1].onMessage.emit({
      type: "ready",
      protocolVersion: 1,
      deviceId: hello.device.id,
      connectionGeneration: hello.device.connectionGeneration,
    });
    expect(h.status().connected).toBe(true);
  });
  test("a rejected ready fence reconnects and ignores stale-port messages", async () => {
    const h = harness();
    await flush();
    h.ports[0].onMessage.emit({
      type: "ready",
      protocolVersion: 1,
      deviceId: crypto.randomUUID(),
      connectionGeneration: "wrong",
    });
    await flush();
    expect(h.hasTimer(500)).toBe(true);
    h.tick(500);
    await flush();
    const hello = h.ports[1].messages[0];
    h.ports[1].onMessage.emit({
      type: "ready",
      protocolVersion: 1,
      deviceId: hello.device.id,
      connectionGeneration: hello.device.connectionGeneration,
    });
    expect(h.status().connected).toBe(true);
    h.ports[0].onMessage.emit({
      type: "ready",
      protocolVersion: 1,
      deviceId: "stale",
      connectionGeneration: "stale",
    });
    expect(h.status().connected).toBe(true);
    expect(h.ports[1].disconnected).toBe(false);
  });
});
