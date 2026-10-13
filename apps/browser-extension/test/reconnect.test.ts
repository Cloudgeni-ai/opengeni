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
  test("a native reconnect keeps the worker's state generation on a new port generation", async () => {
    const h = harness();
    await flush();
    const first = h.ports[0].messages[0];
    expect(first.type).toBe("hello");
    expect(typeof first.device.stateGeneration).toBe("string");
    expect(first.device.stateGeneration).not.toBe(first.device.connectionGeneration);
    h.ports[0].onDisconnect.emit();
    await flush();
    h.tick(500);
    await flush();
    expect(h.ports).toHaveLength(2);
    const second = h.ports[1].messages[0];
    expect(second.device.stateGeneration).toBe(first.device.stateGeneration);
    expect(second.device.connectionGeneration).not.toBe(first.device.connectionGeneration);
    // A restarted worker (fresh module instance) has lost its live state.
    const restarted = harness();
    await flush();
    expect(restarted.ports[0].messages[0].device.stateGeneration).not.toBe(
      first.device.stateGeneration,
    );
  });
  test("renaming the profile preserves the ready connection and publishes metadata", async () => {
    const h = harness();
    await flush();
    const port = h.ports[0];
    const hello = port.messages[0];
    port.onMessage.emit({
      type: "ready",
      protocolVersion: 1,
      deviceId: hello.device.id,
      connectionGeneration: hello.device.connectionGeneration,
    });
    let response: unknown;
    h.chrome.runtime.onMessage.emit(
      { type: "set_profile_label", profileLabel: "  Work browser  " },
      {},
      (result: unknown) => {
        response = result;
      },
    );
    await flush();
    expect(response).toEqual({ saved: true, profileLabel: "Work browser" });
    expect(h.ports).toHaveLength(1);
    expect(port.disconnected).toBe(false);
    expect(h.status()).toMatchObject({
      connected: true,
      connectionGeneration: hello.device.connectionGeneration,
      profileLabel: "Work browser",
    });
    expect(port.messages.at(-1)).toMatchObject({
      type: "inventory",
      deviceId: hello.device.id,
      connectionGeneration: hello.device.connectionGeneration,
      profile: { profileLabel: "Work browser" },
    });
    const revisions = port.messages
      .filter((message: any) => message.type === "inventory")
      .map((message: any) => message.inventoryRevision);
    expect(
      revisions.every(
        (revision: number, index: number) => index === 0 || revision > revisions[index - 1],
      ),
    ).toBe(true);
  });
  test("a rename during the handshake waits for readiness on the original port", async () => {
    const h = harness();
    await flush();
    const port = h.ports[0];
    const hello = port.messages[0];
    h.chrome.runtime.onMessage.emit(
      { type: "set_profile_label", profileLabel: "New label" },
      {},
      () => {},
    );
    await flush();
    expect(h.ports).toHaveLength(1);
    expect(port.messages.map((message: any) => message.type)).toEqual(["hello"]);
    port.onMessage.emit({
      type: "ready",
      protocolVersion: 1,
      deviceId: hello.device.id,
      connectionGeneration: hello.device.connectionGeneration,
    });
    await flush();
    expect(port.messages.at(-1)).toMatchObject({
      type: "inventory",
      connectionGeneration: hello.device.connectionGeneration,
      profile: { profileLabel: "New label" },
    });
    expect(h.status().connected).toBe(true);
    h.chrome.runtime.onMessage.emit(
      { type: "set_profile_label", profileLabel: null },
      {},
      () => {},
    );
    await flush();
    expect(port.messages.at(-1)).toMatchObject({
      type: "inventory",
      profile: { profileLabel: null },
    });
    expect(port.disconnected).toBe(false);
  });
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
