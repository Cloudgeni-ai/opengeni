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
  // Scripts the extension ran in pages: the function's name and the tab.
  readonly scripts: string[] = [];
  // The icon each showMark script set.
  readonly icons: unknown[] = [];
  // Holds reads of the recorded marked tabs until it settles.
  indicatorReads: Promise<void> = Promise.resolve();
  // Callbacks the worker scheduled after the controlled tab release delay.
  readonly releaseTimers: (() => void)[] = [];
  // Chrome's tab groups, which outlive the extension: each tab's group, and
  // each group's title and colour. A group disappears with its last tab.
  readonly tabGroup = new Map<number, number>();
  readonly groups = new Map<number, { title: string; color: string }>();
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
    const navigation = { onCommitted: event() };
    const profile = this;
    const chrome: any = {
      runtime: {
        id: "abcdefghijklmnopabcdefghijklmnop",
        getURL: (path: string) =>
          `chrome-extension://${path.endsWith("agent-cursor.png") ? "dynamic-id" : "x"}/${path}`,
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
      webNavigation: navigation,
      scripting: {
        executeScript: async ({
          target,
          func,
          args,
        }: {
          target: { tabId: number };
          func: Function;
          args?: unknown[];
        }) => {
          profile.scripts.push(`${func.name} ${target.tabId}`);
          if (func.name === "showMark") profile.icons.push(args?.[0]);
          return [];
        },
      },
      storage: {
        local: {
          get: async (key: string) => {
            if (key === "tabIcon" || key === "tabGroup") await profile.indicatorReads;
            return key in profile.local ? { [key]: profile.local[key] } : {};
          },
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
        move: async () => ({}),
        query: async (query: { groupId?: number } = {}) =>
          [...profile.tabs]
            .filter((id) => query.groupId === undefined || profile.groupOf(id) === query.groupId)
            .map((id) => profile.tabOf(id)),
        get: async (id: number) => {
          if (!profile.tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
          return profile.tabOf(id);
        },
        create: async () => {
          const id = Math.max(...profile.tabs) + 1;
          profile.tabs.add(id);
          return profile.tabOf(id);
        },
        group: async ({ tabIds, groupId }: { tabIds: number[]; groupId?: number }) => {
          const id = groupId ?? Math.max(100, ...profile.groups.keys()) + 1;
          if (!profile.groups.has(id)) profile.groups.set(id, { title: "", color: "grey" });
          for (const tabId of tabIds) profile.tabGroup.set(tabId, id);
          return id;
        },
        ungroup: async (tabIds: number[]) => {
          for (const tabId of tabIds) profile.tabGroup.delete(tabId);
          profile.pruneGroups();
        },
      },
      tabGroups: {
        get: async (id: number) => {
          if (!profile.groups.has(id)) throw new Error(`No group with id: ${id}.`);
          return { id, ...profile.groups.get(id) };
        },
        query: async ({ title, color }: { title: string; color: string }) =>
          [...profile.groups]
            .filter(([, group]) => group.title === title && group.color === color)
            .map(([id, group]) => ({ id, ...group })),
        update: async (id: number, properties: { title: string; color: string }) =>
          Object.assign(profile.groups.get(id)!, properties),
      },
    };
    new Function("chrome", "navigator", "setTimeout", "clearTimeout", worker)(
      chrome,
      { userAgent: "Chrome/153.0.0.0" },
      (callback: () => void, ms: number) => {
        if (ms === 2_000) profile.releaseTimers.push(callback);
        return 0;
      },
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
      navigated: (tabId: number, frameId = 0) => navigation.onCommitted.emit({ tabId, frameId }),
    };
    this.current = started;
    return started;
  }

  groupOf(id: number): number {
    return this.tabGroup.get(id) ?? -1;
  }

  pruneGroups() {
    for (const id of this.groups.keys())
      if (![...this.tabGroup.values()].includes(id)) this.groups.delete(id);
  }

  /** The title of the tab's group, or null. */
  groupTitle(id: number): string | null {
    return this.groups.get(this.groupOf(id))?.title ?? null;
  }

  tabOf(id: number) {
    return { ...tabOf(id), groupId: this.groupOf(id) };
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

describe("the tabs an agent controls", () => {
  const releaseDelay = async (chrome: FakeChrome) => {
    for (const run of chrome.releaseTimers.splice(0)) run();
    await flush();
    await flush();
  };

  test("sit in the product's tab group and show the agent's cursor while controlled", async () => {
    const chrome = new FakeChrome();
    const command = await chrome.startWorker().ready();
    expect(await command({ type: "debugger.attach", tabId: "8" })).toMatchObject({ ok: true });
    await flush();
    expect(chrome.groupTitle(8)).toBe("Opengeni");
    expect(chrome.groups.get(chrome.groupOf(8))?.color).toBe("blue");
    expect(chrome.groupTitle(7)).toBeNull();
    expect(chrome.scripts).toEqual(["showMark 8"]);
    // Served by the extension: sites' Content-Security-Policy often refuses
    // data: icons.
    expect(chrome.icons).toEqual(["chrome-extension://dynamic-id/icons/agent-cursor.png"]);

    expect(await command({ type: "debugger.detach", tabId: "8" })).toMatchObject({ ok: true });
    await flush();
    expect(chrome.scripts).toEqual(["showMark 8"]);
    expect(chrome.groupTitle(8)).toBe("Opengeni");
    await releaseDelay(chrome);
    expect(chrome.scripts).toEqual(["showMark 8", "removeMark 8"]);
    expect(chrome.groupTitle(8)).toBeNull();
    expect(chrome.groups.size).toBe(0);
  });

  test("a new page in a controlled tab gets the mark again", async () => {
    const chrome = new FakeChrome();
    const started = chrome.startWorker();
    const command = await started.ready();
    await command({ type: "debugger.attach", tabId: "7" });
    await flush();
    started.navigated(7);
    started.navigated(7, 3);
    started.navigated(9);
    await flush();
    expect(chrome.scripts).toEqual(["showMark 7", "showMark 7"]);
  });

  test("Chrome ending the agent's control gives the tab its icon and place back", async () => {
    const chrome = new FakeChrome();
    const started = chrome.startWorker();
    const command = await started.ready();
    await command({ type: "debugger.attach", tabId: "7" });
    await flush();
    expect(chrome.groupTitle(7)).toBe("Opengeni");
    chrome.attached.delete(7);
    started.detached(7, "canceled_by_user");
    await releaseDelay(chrome);
    expect(chrome.scripts).toEqual(["showMark 7", "removeMark 7"]);
    expect(chrome.groupTitle(7)).toBeNull();
  });

  test("a reloaded or updated extension gives controlled tabs their icons and places back", async () => {
    const chrome = new FakeChrome();
    const command = await chrome.startWorker().ready();
    await command({ type: "debugger.attach", tabId: "9" });
    await flush();
    // A restarted worker keeps the mark and the group.
    await chrome.restartWorker().ready();
    await flush();
    expect(chrome.scripts.filter((script) => script.startsWith("removeMark"))).toEqual([]);
    expect(chrome.groupTitle(9)).toBe("Opengeni");
    await chrome.reloadExtension().ready();
    await flush();
    await flush();
    expect(chrome.scripts.at(-1)).toBe("removeMark 9");
    expect(chrome.groupTitle(9)).toBeNull();
  });

  test("a tab the agent takes again while an updated extension starts stays marked", async () => {
    const chrome = new FakeChrome();
    const command = await chrome.startWorker().ready();
    await command({ type: "debugger.attach", tabId: "9" });
    await flush();
    let read!: () => void;
    chrome.indicatorReads = new Promise((done) => (read = done));
    const updated = await chrome.reloadExtension().ready();
    expect(await updated({ type: "debugger.attach", tabId: "9" })).toMatchObject({ ok: true });
    read();
    await flush();
    expect(chrome.scripts.filter((script) => script.startsWith("removeMark"))).toEqual([]);
    expect(chrome.scripts.at(-1)).toBe("showMark 9");
    expect(chrome.groupTitle(9)).toBe("Opengeni");
  });
});
