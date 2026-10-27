import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseExtensionCommand } from "../src/protocol";
import { sitePattern } from "../src/site-permissions";

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
  const listeners: ((...args: any[]) => any)[] = [];
  return {
    addListener(fn: (...args: any[]) => any) {
      listeners.push(fn);
    },
    emit(...args: any[]) {
      return listeners.map((fn) => fn(...args));
    },
  };
}

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
const PAGE = `${EXTENSION}site-permissions.html`;

/** The extension worker in a Chrome profile with one tab an agent controls
 * (`https://meet.example.test:8443`), where the person has or has not
 * allowed site permissions. */
function harness(options: { allowed: boolean }) {
  const ports: any[] = [];
  let allowed = options.allowed;
  // Every contentSettings call, in order: "microphone set <pattern> allow".
  const settings: string[] = [];
  const tabsCreated: string[] = [];
  const tabsActivated: number[] = [];
  const openTabs: any[] = [];
  let tabUrl = "https://meet.example.test:8443/room/42";
  const contentSetting = (name: string) => ({
    set: async ({ primaryPattern, setting, secondaryPattern }: any) => {
      if (!allowed) throw new Error(`'contentSettings.ContentSetting.set' is not available`);
      if (secondaryPattern !== undefined) throw new Error("no secondary pattern expected");
      settings.push(`${name} set ${primaryPattern} ${setting}`);
    },
    clear: async () => {
      if (!allowed) throw new Error(`'contentSettings.ContentSetting.clear' is not available`);
      settings.push(`${name} clear`);
    },
  });
  const local = {
    values: {} as Record<string, unknown>,
    async get() {
      return structuredClone(this.values);
    },
    async set(value: object) {
      Object.assign(this.values, structuredClone(value));
    },
  };
  const chrome: any = {
    runtime: {
      id: "abcdefghijklmnopabcdefghijklmnop",
      getManifest: () => ({ version: "0.2.3" }),
      getURL: (path: string) => `${EXTENSION}${path}`,
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
    permissions: {
      contains: async () => allowed,
      remove: async () => {
        allowed = false;
        return true;
      },
      onAdded: event(),
      onRemoved: event(),
    },
    contentSettings: Object.fromEntries(
      ["camera", "microphone", "location", "notifications"].map((name) => [
        name,
        contentSetting(name),
      ]),
    ),
    alarms: { onAlarm: event(), create: async () => {} },
    storage: { local },
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
      sendCommand: async () => ({}),
    },
    windows: {
      getAll: async () => [{ id: 1, type: "normal", focused: true }],
      get: async () => ({ id: 1, type: "normal", focused: true }),
      create: async () => ({ id: 2 }),
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
      query: async (query: { url?: string } = {}) =>
        query.url ? openTabs.filter((open) => open.url === query.url) : [tab()],
      get: async (id: number) => {
        if (id !== 7) throw new Error(`No tab with id: ${id}.`);
        return tab();
      },
      create: async ({ url }: { url: string }) => {
        tabsCreated.push(url);
        const created = { id: 100 + tabsCreated.length, url };
        openTabs.push(created);
        return created;
      },
      update: async (id: number) => {
        tabsActivated.push(id);
        return { id };
      },
    },
  };
  function tab() {
    return {
      id: 7,
      windowId: 1,
      index: 0,
      url: tabUrl,
      title: "Call",
      active: true,
      pinned: false,
      incognito: false,
    };
  }
  new Function("chrome", "navigator", "setTimeout", "clearTimeout", worker)(
    chrome,
    { userAgent: "Chrome/155.0.0.0" },
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
  /** A message from one of the extension's pages, or from elsewhere. */
  const message = async (body: object, url = `${EXTENSION}popup.html`) => {
    const reply: { answer?: unknown } = {};
    const handled = chrome.runtime.onMessage.emit(body, { url }, (value: unknown) => {
      reply.answer = value;
    });
    for (let round = 0; round < 20; round++) {
      if ("answer" in reply) break;
      await flush();
    }
    return { handled: handled[0], answer: reply.answer };
  };
  return {
    ready,
    message,
    settings,
    tabsCreated,
    tabsActivated,
    stored: () => local.values.sitePermissions,
    allow: () => {
      allowed = true;
    },
    navigate: (url: string) => {
      tabUrl = url;
    },
  };
}

const MEET = "https://meet.example.test:8443";

describe("site permissions", () => {
  test("an extension that knows the command says so when pinged", async () => {
    const command = await harness({ allowed: false }).ready();
    expect(await command({ type: "ping" })).toMatchObject({
      ok: true,
      payload: { pong: true, sitePermissions: true },
    });
  });

  test("before the person allows it, nothing is set and the page that asks them opens once", async () => {
    const h = harness({ allowed: false });
    const command = await h.ready();
    await command({ type: "debugger.attach", tabId: "7" });
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await command({
          type: "permissions.set",
          origin: MEET,
          permission: "microphone",
          setting: "granted",
        }),
      ).toMatchObject({ ok: false, error: { code: "consent_required", retryable: false } });
    }
    expect(h.settings).toEqual([]);
    // The second request shows the page already open instead of another.
    expect(h.tabsCreated).toEqual([PAGE]);
    expect(h.tabsActivated).toEqual([101]);
  });

  test("once allowed, sets the permission for the exact site, port included, and records it", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    await command({ type: "debugger.attach", tabId: "7" });
    const set = async (permission: string, setting: string) =>
      await command({ type: "permissions.set", origin: MEET, permission, setting });
    expect(await set("microphone", "granted")).toMatchObject({
      ok: true,
      payload: { origin: MEET, setting: "granted" },
    });
    expect(await set("geolocation", "denied")).toMatchObject({ ok: true });
    expect(h.settings).toEqual([
      "microphone set https://meet.example.test:8443/* allow",
      "location set https://meet.example.test:8443/* block",
    ]);
    expect(h.stored()).toEqual([
      expect.objectContaining({
        origin: MEET,
        pattern: "https://meet.example.test:8443/*",
        permission: "microphone",
        setting: "granted",
      }),
      expect.objectContaining({ permission: "geolocation", setting: "denied" }),
    ]);
    expect(h.tabsCreated).toEqual([]);
  });

  test("refuses a site no tab the agent controls shows, and a tab that is not controlled", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const request = {
      type: "permissions.set",
      origin: MEET,
      permission: "camera",
      setting: "granted",
    };
    // Tab 7 shows the site but no agent controls it.
    expect(await command(request)).toMatchObject({ ok: false, error: { code: "tab_changed" } });
    await command({ type: "debugger.attach", tabId: "7" });
    // Another port of the same host is another site.
    h.navigate("https://meet.example.test:9443/room/42");
    expect(await command(request)).toMatchObject({ ok: false, error: { code: "tab_changed" } });
    expect(h.settings).toEqual([]);
    expect(h.stored()).toBeUndefined();
  });

  test("back to prompt removes only that site's setting and keeps the others", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    await command({ type: "debugger.attach", tabId: "7" });
    await command({
      type: "permissions.set",
      origin: MEET,
      permission: "microphone",
      setting: "granted",
    });
    h.navigate("http://127.0.0.1:47915/");
    await command({
      type: "permissions.set",
      origin: "http://127.0.0.1:47915",
      permission: "microphone",
      setting: "granted",
    });
    await command({
      type: "permissions.set",
      origin: "http://127.0.0.1:47915",
      permission: "camera",
      setting: "granted",
    });
    h.settings.length = 0;
    expect(
      await command({
        type: "permissions.set",
        origin: "http://127.0.0.1:47915",
        permission: "microphone",
        setting: "prompt",
      }),
    ).toMatchObject({ ok: true });
    // Chrome clears an extension's rules only all at once per permission.
    expect(h.settings).toEqual([
      "microphone clear",
      "microphone set https://meet.example.test:8443/* allow",
    ]);
    expect((h.stored() as any[]).map((entry) => `${entry.permission} ${entry.origin}`)).toEqual([
      `microphone ${MEET}`,
      "camera http://127.0.0.1:47915",
    ]);
    // Nothing to undo: no rule is touched.
    h.settings.length = 0;
    await command({
      type: "permissions.set",
      origin: "http://127.0.0.1:47915",
      permission: "notifications",
      setting: "prompt",
    });
    expect(h.settings).toEqual([]);
  });

  test("the person removes one change, or turns it all off, from the extension's own pages only", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    await command({ type: "debugger.attach", tabId: "7" });
    for (const permission of ["microphone", "camera"]) {
      await command({ type: "permissions.set", origin: MEET, permission, setting: "granted" });
    }
    const remove = {
      type: "remove_site_permission",
      pattern: "https://meet.example.test:8443/*",
      permission: "camera",
    };
    expect((await h.message(remove, "https://evil.example.test/")).handled).toBe(false);
    expect(h.stored()).toHaveLength(2);
    h.settings.length = 0;
    const removed = await h.message(remove);
    expect(removed.answer).toMatchObject({
      allowed: true,
      entries: [expect.objectContaining({ permission: "microphone" })],
    });
    expect(h.settings).toEqual(["camera clear"]);
    h.settings.length = 0;
    const off = await h.message({ type: "turn_off_site_permissions" }, PAGE);
    expect(off.answer).toEqual({ allowed: false, entries: [] });
    // Every rule is gone before Chrome takes the permission back, since the
    // extension could not remove them afterwards.
    expect(h.settings).toEqual([
      "camera clear",
      "microphone clear",
      "location clear",
      "notifications clear",
    ]);
  });
});

describe("site permission requests", () => {
  const envelope = (payload: object) => ({
    type: "command",
    protocolVersion: 1,
    requestId: "11111111-1111-4111-8111-111111111111",
    deviceId: "22222222-2222-4222-8222-222222222222",
    connectionGeneration: "generation",
    payload,
  });

  test("name one exact http(s) site, one supported permission and one setting", () => {
    expect(
      parseExtensionCommand(
        envelope({
          type: "permissions.set",
          origin: "https://example.test",
          permission: "notifications",
          setting: "denied",
        }),
      ).payload,
    ).toEqual({
      type: "permissions.set",
      origin: "https://example.test",
      permission: "notifications",
      setting: "denied",
    });
    const valid = { type: "permissions.set", origin: "https://example.test", permission: "camera" };
    for (const payload of [
      { ...valid, setting: "granted", origin: "https://example.test/path" },
      { ...valid, setting: "granted", origin: "https://example.test:443" },
      { ...valid, setting: "granted", origin: "https://*.example.test" },
      { ...valid, setting: "granted", origin: "https://*" },
      { ...valid, setting: "granted", origin: "file:///etc/hosts" },
      { ...valid, setting: "granted", origin: "chrome://settings" },
      { ...valid, setting: "granted", permission: "midi" },
      { ...valid, setting: "granted", permission: "location" },
      { ...valid, setting: "allow" },
      { ...valid, setting: "granted", secondaryPattern: "<all_urls>" },
    ]) {
      expect(() => parseExtensionCommand(envelope(payload))).toThrow();
    }
  });

  test("always give the port, since a pattern without one matches every port", () => {
    expect(sitePattern("https://example.test")).toBe("https://example.test:443/*");
    expect(sitePattern("http://example.test")).toBe("http://example.test:80/*");
    expect(sitePattern("http://127.0.0.1:47915")).toBe("http://127.0.0.1:47915/*");
    expect(sitePattern("http://[::1]:8080")).toBe("http://[::1]:8080/*");
    expect(sitePattern("https://xn--bcher-kva.example")).toBe(
      "https://xn--bcher-kva.example:443/*",
    );
  });
});
