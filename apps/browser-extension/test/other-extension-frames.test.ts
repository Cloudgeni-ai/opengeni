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

const PASSWORD_MANAGER = "nngceckbapebfimnlniiiahkandclblb";
const FRAME_REFUSAL = "Cannot access a chrome-extension:// URL of different extension";

/** One attached tab whose page may hold a password manager's inline menu
 * frame. While it does, Chrome refuses every debugger command, as it does for
 * a tab it attached to while that frame was still loading. */
function harness(
  options: { frameReturns?: boolean; refusal?: (method: string) => string | undefined } = {},
) {
  const ports: any[] = [];
  const sent: string[] = [];
  let framePresent = false;
  let removals = 0;
  const tab = {
    id: 7,
    windowId: 1,
    index: 0,
    url: "https://login.example.com/",
    title: "Sign in",
    active: true,
    pinned: false,
    incognito: false,
  };
  const chrome: any = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
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
      sendCommand: async (_source: unknown, method: string) => {
        if (framePresent) throw new Error(FRAME_REFUSAL);
        const refusal = options.refusal?.(method);
        if (refusal) throw new Error(refusal);
        sent.push(method);
        return { ran: method };
      },
    },
    scripting: {
      executeScript: async () => {
        removals += 1;
        const removed = framePresent ? [PASSWORD_MANAGER] : [];
        framePresent = options.frameReturns === true;
        return [{ result: removed }];
      },
    },
    windows: {
      getAll: async () => [{ id: 1, type: "normal", focused: true }],
      get: async () => ({ id: 1, type: "normal", focused: true }),
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
      query: async () => [tab],
      get: async () => tab,
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
      for (let round = 0; round < 20; round++) {
        await flush();
        const reply = port.messages.find(
          (message: any) => message.type === "command_result" && message.requestId === requestId,
        );
        if (reply) return reply;
      }
      return undefined;
    };
  };
  return {
    ready,
    sent,
    addFrame: () => {
      framePresent = true;
    },
    removals: () => removals,
  };
}

describe("another extension's frame in an attached tab", () => {
  test("a command Chrome refuses for the frame runs once the frame is removed", async () => {
    const h = harness();
    const command = await h.ready();
    const attached = await command({ type: "debugger.attach", tabId: "7" });
    expect(attached).toMatchObject({ ok: true });
    h.addFrame();
    const result = await command({
      type: "debugger.command",
      tabId: "7",
      attachment: attached.payload.attachment,
      method: "Input.insertText",
      params: { text: "alice" },
    });
    expect(result).toMatchObject({ ok: true, payload: { result: { ran: "Input.insertText" } } });
    expect(h.removals()).toBe(1);
    // Sent to the page exactly once, after the frame was gone.
    expect(h.sent).toEqual(["Input.insertText"]);
  });

  test("a frame that comes straight back fails the command, naming the extension", async () => {
    const h = harness({ frameReturns: true });
    const command = await h.ready();
    const attached = await command({ type: "debugger.attach", tabId: "7" });
    h.addFrame();
    const result = await command({
      type: "debugger.command",
      tabId: "7",
      attachment: attached.payload.attachment,
      method: "Page.getFrameTree",
      params: {},
    });
    expect(result).toMatchObject({ ok: false, error: { code: "tab_unavailable" } });
    expect(result.error.message).toStartWith("Bitwarden keeps adding its own frame to this page");
    expect(h.sent).toEqual([]);
  });

  test("commands refused together for one frame share a single removal", async () => {
    // browserd sends several commands at once (the enables of a new
    // attachment), and Chrome refuses each of them for the same frame.
    const h = harness();
    const command = await h.ready();
    const attached = await command({ type: "debugger.attach", tabId: "7" });
    const send = (method: string) =>
      command({
        type: "debugger.command",
        tabId: "7",
        attachment: attached.payload.attachment,
        method,
        params: {},
      });
    const methods = [
      "Inspector.enable",
      "Page.enable",
      "DOM.enable",
      "Accessibility.enable",
      "Network.enable",
      "Runtime.enable",
    ];
    h.addFrame();
    const results = await Promise.all(methods.map(send));
    for (const result of results) expect(result).toMatchObject({ ok: true });
    expect(h.removals()).toBe(1);
    expect([...h.sent].sort()).toEqual([...methods].sort());
    // The menu appearing again on the next field is removed again, within
    // the tab's budget.
    h.addFrame();
    expect(await send("Input.insertText")).toMatchObject({ ok: true });
    expect(h.removals()).toBe(2);
  });

  test("a refusal that only mentions an extension address removes nothing", async () => {
    const h = harness({
      refusal: (method) =>
        method === "Page.navigate"
          ? "Cannot navigate to chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html"
          : undefined,
    });
    const command = await h.ready();
    const attached = await command({ type: "debugger.attach", tabId: "7" });
    const result = await command({
      type: "debugger.command",
      tabId: "7",
      attachment: attached.payload.attachment,
      method: "Page.navigate",
      params: { url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html" },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.error.message).toContain("Cannot navigate to chrome-extension://");
    expect(h.removals()).toBe(0);
  });
});
