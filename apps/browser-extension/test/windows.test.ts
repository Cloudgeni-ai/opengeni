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
  for (let i = 0; i < 60; i++) await Promise.resolve();
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

type FakeWindow = { id: number; type: "normal" | "popup"; focused: boolean };
type FakeTab = { id: number; windowId: number; url: string; active: boolean };

/** A Chrome profile's windows and tabs. A window closes with its last tab,
 * and creating a tab needs a normal window, as in Chrome. */
function harness(windows: FakeWindow[], tabs: FakeTab[]) {
  const ports: any[] = [];
  let nextId = 1_000;
  const calls: string[] = [];
  const chromeTab = (tab: FakeTab) => ({
    ...tab,
    index: tabs.filter((other) => other.windowId === tab.windowId).indexOf(tab),
    title: "Page",
    pinned: false,
    incognito: false,
  });
  const openWindow = (type: FakeWindow["type"], focused: boolean, url?: string) => {
    const window = { id: ++nextId, type, focused };
    windows.push(window);
    const tab = { id: ++nextId, windowId: window.id, url: url ?? "chrome://newtab/", active: true };
    tabs.push(tab);
    return { ...window, tabs: [chromeTab(tab)] };
  };
  const chrome: any = {
    runtime: {
      getManifest: () => ({ version: "0.1.0" }),
      onMessage: event(),
      getPlatformInfo: async () => ({ os: "mac", arch: "arm64" }),
      onInstalled: event(),
      onStartup: event(),
      onUpdateAvailable: event(),
      reload: () => {},
      lastError: undefined,
      connectNative: () => {
        const port = {
          onMessage: event(),
          onDisconnect: event(),
          messages: [] as any[],
          postMessage(message: unknown) {
            this.messages.push(message);
          },
          disconnect() {},
        };
        ports.push(port);
        return port;
      },
    },
    alarms: { onAlarm: event(), create: async () => {} },
    storage: {
      local: {
        values: {} as Record<string, unknown>,
        async get() {
          return { ...this.values };
        },
        async set(value: object) {
          Object.assign(this.values, value);
        },
      },
    },
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {},
      setTitle: async () => {},
    },
    debugger: {
      onEvent: event(),
      onDetach: event(),
      attach: async () => {},
      detach: async () => {},
    },
    windows: {
      getAll: async (filter?: { windowTypes?: string[] }) =>
        windows.filter(
          (window) => !filter?.windowTypes || filter.windowTypes.includes(window.type),
        ),
      get: async (id: number) => {
        const window = windows.find((candidate) => candidate.id === id);
        if (!window) throw new Error(`No window with id: ${id}.`);
        return window;
      },
      create: async (options: { focused?: boolean; url?: string }) => {
        calls.push(`windows.create focused=${options.focused}`);
        return openWindow("normal", options.focused ?? true, options.url);
      },
    },
    tabs: {
      ...Object.fromEntries(
        [
          "onCreated",
          "onUpdated",
          "onRemoved",
          "onMoved",
          "onAttached",
          "onDetached",
          "onActivated",
          "onReplaced",
        ].map((name) => [name, event()]),
      ),
      query: async () => tabs.map(chromeTab),
      get: async (id: number) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return chromeTab(tab);
      },
      create: async (options: { windowId?: number; active?: boolean; url?: string }) => {
        const window =
          options.windowId === undefined
            ? windows.find((candidate) => candidate.type === "normal")
            : windows.find((candidate) => candidate.id === options.windowId);
        if (!window) throw new Error("No current window");
        calls.push(`tabs.create window=${window.id} active=${options.active}`);
        const tab = {
          id: ++nextId,
          windowId: window.id,
          url: options.url ?? "chrome://newtab/",
          active: options.active ?? true,
        };
        tabs.push(tab);
        return chromeTab(tab);
      },
      remove: async (id: number) => {
        const tab = tabs.find((candidate) => candidate.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        calls.push(`tabs.remove ${id}`);
        tabs.splice(tabs.indexOf(tab), 1);
        if (!tabs.some((other) => other.windowId === tab.windowId)) {
          windows.splice(
            windows.findIndex((window) => window.id === tab.windowId),
            1,
          );
        }
      },
    },
  };
  new Function("chrome", "navigator", "setTimeout", "clearTimeout", worker)(
    chrome,
    { userAgent: "Chrome/153.0.0.0" },
    () => 0,
    () => {},
  );
  const ready = async () => {
    await flush();
    const port = ports[0];
    const hello = port.messages[0];
    port.onMessage.emit({
      type: "ready",
      protocolVersion: 1,
      deviceId: hello.device.id,
      connectionGeneration: hello.device.connectionGeneration,
    });
    await flush();
    return async (payload: object) => {
      const requestId = crypto.randomUUID();
      port.onMessage.emit({
        type: "command",
        protocolVersion: 1,
        requestId,
        deviceId: hello.device.id,
        connectionGeneration: hello.device.connectionGeneration,
        payload,
      });
      await flush();
      return port.messages.find(
        (message: any) => message.type === "command_result" && message.requestId === requestId,
      );
    };
  };
  return { calls, windows, tabs, ready };
}

describe("attached Chrome windows", () => {
  test("closing the profile's last tab keeps its window open with a new tab page", async () => {
    const h = harness(
      [{ id: 1, type: "normal", focused: true }],
      [{ id: 7, windowId: 1, url: "https://example.com/", active: true }],
    );
    const command = await h.ready();
    const result = await command({ type: "tabs.close", tabId: "7" });
    expect(result).toMatchObject({ ok: true });
    expect(h.calls).toEqual(["tabs.create window=1 active=false", "tabs.remove 7"]);
    expect(h.windows.map((window) => window.id)).toEqual([1]);
    expect(result.payload.tabs).toMatchObject([{ windowId: 1, url: "chrome://newtab/" }]);
  });

  test("closing a tab leaves other windows and tabs to Chrome", async () => {
    const h = harness(
      [
        { id: 1, type: "normal", focused: true },
        { id: 2, type: "normal", focused: false },
      ],
      [
        { id: 7, windowId: 1, url: "https://example.com/", active: true },
        { id: 8, windowId: 2, url: "https://example.org/", active: true },
      ],
    );
    const command = await h.ready();
    expect(await command({ type: "tabs.close", tabId: "7" })).toMatchObject({ ok: true });
    // The window that held only this tab closes; the profile keeps the other.
    expect(h.calls).toEqual(["tabs.remove 7"]);
    expect(h.windows.map((window) => window.id)).toEqual([2]);
  });

  test("the last tab of a popup window is replaced by an unfocused normal window", async () => {
    const h = harness(
      [{ id: 3, type: "popup", focused: true }],
      [{ id: 9, windowId: 3, url: "https://example.com/", active: true }],
    );
    const command = await h.ready();
    expect(await command({ type: "tabs.close", tabId: "9" })).toMatchObject({ ok: true });
    expect(h.calls).toEqual(["windows.create focused=false", "tabs.remove 9"]);
    expect(h.windows).toHaveLength(1);
  });

  test("a tab opens in a new unfocused window when Chrome has no window open", async () => {
    const h = harness([], []);
    const command = await h.ready();
    const result = await command({ type: "tabs.create", url: "https://example.com/" });
    expect(result).toMatchObject({
      ok: true,
      payload: { tab: { url: "https://example.com/", controllable: true } },
    });
    expect(h.calls).toEqual(["windows.create focused=false"]);
    // With a window open, a tab is added to it without focusing it.
    expect(await command({ type: "tabs.create", url: "https://example.org/" })).toMatchObject({
      ok: true,
    });
    expect(h.calls.at(-1)).toBe(`tabs.create window=${h.windows[0]!.id} active=false`);
  });
});
