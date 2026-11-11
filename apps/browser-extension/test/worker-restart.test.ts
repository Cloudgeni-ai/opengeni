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

/**
 * One Chrome profile with this extension, as Chrome keeps it across the
 * extension's workers: tabs, the extension's debugger attachments and its
 * session storage outlive a worker; reloading the extension ends the
 * attachments and clears session storage. Each worker is a fresh instance of
 * the extension's code with its own listeners and its own native port.
 */
class FakeChrome {
  readonly tabs = new Set([7, 8, 9]);
  readonly attached = new Set<number>();
  readonly session: Record<string, unknown> = {};
  readonly local: Record<string, unknown> = {};
  readonly calls: string[] = [];
  current: ReturnType<FakeChrome["startWorker"]> | null = null;

  /** Chrome stops the extension's worker (keeping everything above) and,
   * when something wakes the extension, starts a new one. */
  restartWorker() {
    this.current?.port()?.onDisconnect.emit();
    return this.startWorker();
  }

  /** The extension reloads or updates: Chrome ends its debugger attachments
   * and clears its session storage. */
  reloadExtension() {
    this.attached.clear();
    for (const key of Object.keys(this.session)) delete this.session[key];
    return this.startWorker();
  }

  startWorker() {
    const ports: any[] = [];
    const debuggerEvents = { onEvent: event(), onDetach: event() };
    const profile = this;
    const chrome: any = {
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        getManifest: () => ({ version: "0.2.2" }),
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
          get: async (key: string) => (key in profile.local ? { [key]: profile.local[key] } : {}),
          set: async (value: object) => Object.assign(profile.local, value),
        },
        session: {
          get: async (key: string) =>
            key in profile.session ? { [key]: structuredClone(profile.session[key]) } : {},
          set: async (value: object) => Object.assign(profile.session, structuredClone(value)),
        },
      },
      action: {
        setBadgeText: async () => {},
        setBadgeBackgroundColor: async () => {},
        setTitle: async () => {},
      },
      debugger: {
        ...debuggerEvents,
        attach: async ({ tabId }: { tabId: number }) => {
          profile.calls.push(`attach ${tabId}`);
          if (profile.attached.has(tabId))
            throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`);
          profile.attached.add(tabId);
        },
        detach: async ({ tabId }: { tabId: number }) => {
          profile.calls.push(`detach ${tabId}`);
          if (!profile.attached.delete(tabId))
            throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
        },
        sendCommand: async ({ tabId }: { tabId: number }, method: string) => {
          if (!profile.attached.has(tabId))
            throw new Error(`Debugger is not attached to the tab with id: ${tabId}.`);
          if (method !== "Target.getTargetInfo") profile.calls.push(`${method} ${tabId}`);
          return { ran: method };
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
        query: async () => [...profile.tabs].map((id) => tabOf(id)),
        get: async (id: number) => {
          if (!profile.tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
          return tabOf(id);
        },
        create: async () => {
          const id = Math.max(...profile.tabs) + 1;
          profile.tabs.add(id);
          return tabOf(id);
        },
      },
    };
    new Function("chrome", "navigator", "setTimeout", "clearTimeout", worker)(
      chrome,
      { userAgent: "Chrome/153.0.0.0" },
      () => 0,
      () => {},
    );
    const started = {
      chrome,
      port: () => ports.at(-1),
      hello: async () => {
        await flush();
        return ports.at(-1).messages[0];
      },
      /** Accept the connection, then send commands and await their results. */
      ready: async () => {
        const hello = await started.hello();
        const port = ports.at(-1);
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
              (message: any) =>
                message.type === "command_result" && message.requestId === requestId,
            );
            if (reply) return reply;
          }
          throw new Error("no command result");
        };
      },
      detached: (tabId: number, reason: string) => debuggerEvents.onDetach.emit({ tabId }, reason),
    };
    this.current = started;
    return started;
  }
}

function tabOf(id: number) {
  return {
    id,
    windowId: 1,
    index: id,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    active: id === 7,
    pinned: false,
    incognito: false,
  };
}

describe("a restarted extension worker", () => {
  test("keeps the state generation and carries on with its attachments", async () => {
    const chrome = new FakeChrome();
    const first = chrome.startWorker();
    const command = await first.ready();
    const before = (await first.hello()).device;
    const attached = await command({ type: "debugger.attach", tabId: "7" });
    expect(attached).toMatchObject({ ok: true, payload: { attached: true } });
    const attachment = attached.payload.attachment;
    expect(await command({ type: "debugger.attach", tabId: "8" })).toMatchObject({ ok: true });
    const poll = await command({ type: "debugger.poll", afterSequence: 0, limit: 10 });

    // Chrome stops the worker; the person closes tab 8 meanwhile.
    chrome.tabs.delete(8);
    chrome.attached.delete(8);
    const second = chrome.restartWorker();
    const resumed = await second.ready();
    const after = (await second.hello()).device;
    expect(after.stateGeneration).toBe(before.stateGeneration);
    expect(after.connectionGeneration).not.toBe(before.connectionGeneration);

    // The same attachment, with the same number: Chrome is not asked again.
    chrome.calls.length = 0;
    expect(await resumed({ type: "debugger.attach", tabId: "7" })).toMatchObject({
      ok: true,
      payload: { attached: true, attachment },
    });
    expect(
      await resumed({
        type: "debugger.command",
        tabId: "7",
        attachment,
        method: "Runtime.evaluate",
        params: {},
      }),
    ).toMatchObject({ ok: true });
    expect(chrome.calls).toEqual(["Runtime.evaluate 7"]);

    // Its event buffer started again, and says so.
    const restartedPoll = await resumed({ type: "debugger.poll", afterSequence: 0, limit: 10 });
    expect(typeof poll.payload.stream).toBe("string");
    expect(restartedPoll.payload.stream).not.toBe(poll.payload.stream);

    // What survived is recorded.
    expect(chrome.local.stateResumptions).toEqual([
      expect.objectContaining({ attachmentsKept: 1, attachmentsEnded: 0, tabsClosed: 1 }),
    ]);
  });

  test("a detach reported to the new worker ends the attachment it carried on", async () => {
    const chrome = new FakeChrome();
    const command = await chrome.startWorker().ready();
    const { attachment } = (await command({ type: "debugger.attach", tabId: "7" })).payload;
    const second = chrome.restartWorker();
    const resumed = await second.ready();
    chrome.attached.delete(7);
    second.detached(7, "canceled_by_user");
    const poll = await resumed({ type: "debugger.poll", afterSequence: 0, limit: 10 });
    expect(poll.payload.events).toEqual([
      expect.objectContaining({
        tabId: "7",
        method: "OpenGeni.debuggerDetached",
        params: { reason: "canceled_by_user", attachment },
      }),
    ]);
    // A third worker does not carry on with it.
    const third = chrome.restartWorker();
    const again = await third.ready();
    chrome.calls.length = 0;
    await again({ type: "debugger.attach", tabId: "7" });
    expect(chrome.calls).toEqual(["attach 7"]);
  });

  test("takes over an attachment an earlier worker left without recording it", async () => {
    const chrome = new FakeChrome();
    await chrome.startWorker().ready();
    // The earlier worker stopped right after Chrome attached, before it
    // recorded the attachment.
    chrome.attached.add(9);
    const resumed = await chrome.restartWorker().ready();
    const attached = await resumed({ type: "debugger.attach", tabId: "9" });
    expect(attached).toMatchObject({ ok: true, payload: { attached: true } });
    expect(
      await resumed({
        type: "debugger.command",
        tabId: "9",
        attachment: attached.payload.attachment,
        method: "Page.enable",
        params: {},
      }),
    ).toMatchObject({ ok: true });
    // And releases it when asked.
    expect(await resumed({ type: "debugger.detach", tabId: "9" })).toMatchObject({ ok: true });
    expect(chrome.attached.has(9)).toBe(false);
  });

  test("a reloaded or updated extension starts a new state generation", async () => {
    const chrome = new FakeChrome();
    const first = chrome.startWorker();
    const command = await first.ready();
    const before = (await first.hello()).device;
    await command({ type: "debugger.attach", tabId: "7" });
    const reloaded = chrome.reloadExtension();
    const after = (await reloaded.hello()).device;
    expect(after.stateGeneration).not.toBe(before.stateGeneration);
    expect(chrome.local.stateResumptions).toBeUndefined();
  });

  test("remembers the tabs an agent opened that are still open", async () => {
    const chrome = new FakeChrome();
    const first = chrome.startWorker();
    const command = await first.ready();
    for (let opened = 0; opened < 2; opened++) {
      expect(await command({ type: "tabs.create", url: "https://example.com/new" })).toMatchObject({
        ok: true,
      });
    }
    expect((chrome.session.liveState as any).createdTabs).toEqual([10, 11]);
    // The person closes one while no worker runs.
    chrome.tabs.delete(11);
    const second = chrome.restartWorker();
    await second.ready();
    expect((chrome.session.liveState as any).createdTabs).toEqual([10]);
  });
});
