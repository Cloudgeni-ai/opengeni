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

/** The extension worker in a Chrome profile with a tab an agent can open
 * (7, `https://meet.example.test:8443`) and the person's own tab (9,
 * `https://mail.example.test`), where the person has or has not allowed site
 * permissions. */
function harness(options: { allowed: boolean }) {
  const ports: any[] = [];
  let allowed = options.allowed;
  // Every contentSettings call, in order: "microphone set <pattern> allow".
  const settings: string[] = [];
  // The extension's own pages it opened, and whether each came to the front.
  const tabsCreated: string[] = [];
  const tabsCreatedActive: boolean[] = [];
  const tabsActivated: number[] = [];
  const openTabs: any[] = [];
  let tabUrl = "https://meet.example.test:8443/room/42";
  let tabIncognito = false;
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
  const session = {
    values: {} as Record<string, unknown>,
    async get() {
      return structuredClone(this.values);
    },
    async set(value: object) {
      Object.assign(this.values, structuredClone(value));
    },
  };
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
    storage: { local, session },
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
        query.url ? openTabs.filter((open) => open.url === query.url) : [tab(), personTab()],
      get: async (id: number) => {
        if (id === 7) return tab();
        if (id === 9) return personTab();
        throw new Error(`No tab with id: ${id}.`);
      },
      // An agent's new tab is tab 7; the extension's own page gets a new id.
      create: async ({ url, active }: { url: string; active: boolean }) => {
        if (!url.startsWith(EXTENSION)) return tab();
        tabsCreated.push(url);
        tabsCreatedActive.push(active);
        const created = { id: 100 + tabsCreated.length, url };
        openTabs.push(created);
        return created;
      },
      getCurrent: async () => undefined,
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
      incognito: tabIncognito,
    };
  }
  function personTab() {
    return { ...tab(), id: 9, index: 1, url: "https://mail.example.test/inbox", active: false };
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
    tabsCreatedActive,
    tabsActivated,
    liveState: () => session.values.liveState as { createdTabs?: number[] } | undefined,
    /** The person closes a tab, or Chrome closes it. */
    close: (id: number) => {
      const index = openTabs.findIndex((open) => open.id === id);
      if (index >= 0) openTabs.splice(index, 1);
      chrome.tabs.onRemoved.emit(id, { windowId: 1, isWindowClosing: false });
    },
    incognito: () => {
      tabIncognito = true;
    },
    stored: () => local.values.sitePermissions,
    store: (values: Record<string, unknown>) => Object.assign(local.values, values),
    allow: () => {
      allowed = true;
    },
    revoke: () => {
      allowed = false;
    },
    navigate: (url: string) => {
      tabUrl = url;
    },
  };
}

const MEET = "https://meet.example.test:8443";

/** Opens the agent's tab (7) if asked for, attaches the agent's debugger to
 * a tab and gives the attachment. */
async function attach(
  command: (payload: object) => Promise<any>,
  tabId = "7",
  options: { open: boolean } = { open: tabId === "7" },
): Promise<number> {
  if (options.open) {
    const opened = await command({ type: "tabs.create", url: `${MEET}/room/42` });
    expect(opened).toMatchObject({ ok: true, payload: { tab: { id: "7" } } });
  }
  const reply = await command({ type: "debugger.attach", tabId });
  return reply.payload.attachment;
}

describe("site permissions", () => {
  test("an extension that knows the command says so when pinged", async () => {
    const command = await harness({ allowed: false }).ready();
    expect(await command({ type: "ping" })).toMatchObject({
      ok: true,
      payload: { pong: true, sitePermissions: true },
    });
  });

  test("before the person allows it, nothing is set and the page that asks them opens once, without taking focus again", async () => {
    const h = harness({ allowed: false });
    const command = await h.ready();
    const attachment = await attach(command);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(
        await command({
          type: "permissions.set",
          tabId: "7",
          attachment,
          origin: MEET,
          permission: "microphone",
          setting: "granted",
        }),
      ).toMatchObject({ ok: false, error: { code: "consent_required", retryable: false } });
    }
    expect(h.settings).toEqual([]);
    // Opened in front once; later requests leave the person's current tab
    // alone instead of bringing the page forward again.
    expect(h.tabsCreated).toEqual([PAGE]);
    expect(h.tabsCreatedActive).toEqual([true]);
    expect(h.tabsActivated).toEqual([]);
    // The page names what the agent asked for.
    expect((await h.message({ type: "site_permissions" }, PAGE)).answer).toEqual({
      allowed: false,
      entries: [],
      request: { origin: MEET, permission: "microphone", setting: "granted" },
    });
    // The person asking for it from the popup does bring it forward.
    await h.message({ type: "open_site_permissions" });
    expect(h.tabsActivated).toEqual([101]);
    // Once allowed, that request is answered: it does not come back when
    // the permission is later taken away outside the extension's pages.
    h.allow();
    expect((await h.message({ type: "site_permissions" }, PAGE)).answer).toEqual({
      allowed: true,
      entries: [],
    });
    h.revoke();
    expect((await h.message({ type: "site_permissions" }, PAGE)).answer).toEqual({
      allowed: false,
      entries: [],
    });
  });

  test("once the person closed the page, an agent's request never opens it again and is told they declined", async () => {
    const h = harness({ allowed: false });
    const command = await h.ready();
    const attachment = await attach(command);
    const set = () =>
      command({
        type: "permissions.set",
        tabId: "7",
        attachment,
        origin: MEET,
        permission: "camera",
        setting: "granted",
      });
    expect(await set()).toMatchObject({ ok: false, error: { code: "consent_required" } });
    expect(h.tabsCreatedActive).toEqual([true]);
    // The person closes it, or chooses Not now, which closes it.
    h.close(101);
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await set()).toMatchObject({
        ok: false,
        error: { code: "consent_declined", retryable: false },
      });
    }
    expect(h.tabsCreated).toEqual([PAGE]);
    expect(h.tabsActivated).toEqual([]);
    expect(h.settings).toEqual([]);
    // The popup still shows what was asked, with the way to allow it.
    expect((await h.message({ type: "site_permissions" })).answer).toMatchObject({
      allowed: false,
      request: { origin: MEET, permission: "camera", setting: "granted" },
    });
    // The person opens it themselves: in front, and while it is open agents
    // are told it is there, without bringing it forward.
    await h.message({ type: "open_site_permissions" });
    expect(h.tabsCreatedActive).toEqual([true, true]);
    expect(await set()).toMatchObject({ ok: false, error: { code: "consent_required" } });
    expect(h.tabsCreated).toEqual([PAGE, PAGE]);
    expect(h.tabsActivated).toEqual([]);
  });

  test("after the person turned it off, an agent's request does not open the page", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const attachment = await attach(command);
    await h.message({ type: "turn_off_site_permissions" }, PAGE);
    expect(
      await command({
        type: "permissions.set",
        tabId: "7",
        attachment,
        origin: MEET,
        permission: "camera",
        setting: "granted",
      }),
    ).toMatchObject({ ok: false, error: { code: "consent_declined" } });
    expect(h.tabsCreated).toEqual([]);
    expect(h.tabsActivated).toEqual([]);
  });

  test("once allowed, sets the permission for the exact site, port included, and records it", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const attachment = await attach(command);
    const set = async (permission: string, setting: string) =>
      await command({
        type: "permissions.set",
        tabId: "7",
        attachment,
        origin: MEET,
        permission,
        setting,
      });
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

  test("sets nothing unless the exact tab asked about shows the site under the agent's attachment", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const set = (tabId: string, attachment: number, origin = MEET) =>
      command({
        type: "permissions.set",
        tabId,
        attachment,
        origin,
        permission: "camera",
        setting: "granted",
      });
    const refused = { ok: false, error: { code: "tab_changed" } };
    const notOpened = { ok: false, error: { code: "not_opened_by_agent" } };
    // Tab 7 shows the site but no agent opened it.
    expect(await set("7", 1)).toMatchObject(notOpened);
    await command({ type: "tabs.create", url: `${MEET}/room/42` });
    // Opened by an agent, but no agent controls it yet.
    expect(await set("7", 1)).toMatchObject(refused);
    const attachment = await attach(command, "7", { open: false });
    // The person's own tab, which no agent opened, even when another tab
    // is controlled and the attachment number is that tab's, and even
    // under an attachment of its own.
    expect(await set("9", attachment, "https://mail.example.test")).toMatchObject(notOpened);
    const personAttachment = await attach(command, "9");
    expect(await set("9", personAttachment, "https://mail.example.test")).toMatchObject(notOpened);
    // Another attachment than the agent's current one of this tab.
    expect(await set("7", attachment + 1)).toMatchObject(refused);
    await command({ type: "debugger.detach", tabId: "7" });
    const again = await attach(command);
    expect(again).not.toBe(attachment);
    expect(await set("7", attachment)).toMatchObject(refused);
    // Another port of the same host is another site.
    h.navigate("https://meet.example.test:9443/room/42");
    expect(await set("7", again)).toMatchObject(refused);
    expect(h.settings).toEqual([]);
    expect(h.stored()).toBeUndefined();
  });

  test("an incognito tab is refused even when the agent opened and controls it", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const attachment = await attach(command);
    h.incognito();
    expect(
      await command({
        type: "permissions.set",
        tabId: "7",
        attachment,
        origin: MEET,
        permission: "camera",
        setting: "granted",
      }),
    ).toMatchObject({ ok: false, error: { code: "tab_changed" } });
    expect(h.settings).toEqual([]);
  });

  test("the tabs an agent opened outlive the worker and are forgotten once closed", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const attachment = await attach(command);
    await flush();
    expect(h.liveState()?.createdTabs).toEqual([7]);
    h.close(7);
    await flush();
    expect(h.liveState()?.createdTabs).toEqual([]);
    expect(
      await command({
        type: "permissions.set",
        tabId: "7",
        attachment,
        origin: MEET,
        permission: "camera",
        setting: "granted",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_opened_by_agent" } });
  });

  test("a site Chrome cannot be given exactly is refused as unsupported, before asking the person", async () => {
    const h = harness({ allowed: false });
    const command = await h.ready();
    const attachment = await attach(command);
    for (const origin of [
      "https://example.test/path",
      "https://example.test:443",
      "https://*.example.test",
      "https://*",
      "file:///etc/hosts",
      "chrome://settings",
      "not a url",
    ]) {
      expect(
        await command({
          type: "permissions.set",
          tabId: "7",
          attachment,
          origin,
          permission: "camera",
          setting: "granted",
        }),
      ).toMatchObject({ ok: false, error: { code: "unsupported_site" } });
    }
    expect(h.tabsCreated).toEqual([]);
    expect(h.settings).toEqual([]);
  });

  test("past 1,000 recorded changes it refuses a new one but still undoes one", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const attachment = await attach(command);
    h.store({
      sitePermissions: Array.from({ length: 1_000 }, (_, index) => ({
        origin: `https://site-${index}.example.test`,
        pattern: `https://site-${index}.example.test:443/*`,
        permission: "camera",
        setting: "granted",
        setAt: "2026-10-27T00:00:00.000Z",
      })),
    });
    const set = (setting: string) =>
      command({
        type: "permissions.set",
        tabId: "7",
        attachment,
        origin: MEET,
        permission: "camera",
        setting,
      });
    expect(await set("granted")).toMatchObject({
      ok: false,
      error: { code: "limit_reached" },
    });
    expect(h.settings).toEqual([]);
    expect(await set("prompt")).toMatchObject({ ok: true });
  });

  test("back to prompt removes only that site's setting and keeps the others", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const attachment = await attach(command);
    const tab = { tabId: "7", attachment };
    await command({
      type: "permissions.set",
      ...tab,
      origin: MEET,
      permission: "microphone",
      setting: "granted",
    });
    h.navigate("http://127.0.0.1:47915/");
    await command({
      type: "permissions.set",
      ...tab,
      origin: "http://127.0.0.1:47915",
      permission: "microphone",
      setting: "granted",
    });
    await command({
      type: "permissions.set",
      ...tab,
      origin: "http://127.0.0.1:47915",
      permission: "camera",
      setting: "granted",
    });
    h.settings.length = 0;
    expect(
      await command({
        type: "permissions.set",
        ...tab,
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
      ...tab,
      origin: "http://127.0.0.1:47915",
      permission: "notifications",
      setting: "prompt",
    });
    expect(h.settings).toEqual([]);
  });

  test("the person removes one change, or turns it all off, from the extension's own pages only", async () => {
    const h = harness({ allowed: true });
    const command = await h.ready();
    const attachment = await attach(command);
    for (const permission of ["microphone", "camera"]) {
      await command({
        type: "permissions.set",
        tabId: "7",
        attachment,
        origin: MEET,
        permission,
        setting: "granted",
      });
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

  test("name one tab and attachment, one site, one supported permission and one setting", () => {
    expect(
      parseExtensionCommand(
        envelope({
          type: "permissions.set",
          tabId: "7",
          attachment: 3,
          origin: "https://example.test",
          permission: "notifications",
          setting: "denied",
        }),
      ).payload,
    ).toEqual({
      type: "permissions.set",
      tabId: "7",
      attachment: 3,
      origin: "https://example.test",
      permission: "notifications",
      setting: "denied",
    });
    const valid = {
      type: "permissions.set",
      tabId: "7",
      attachment: 3,
      origin: "https://example.test",
      permission: "camera",
    };
    for (const payload of [
      { ...valid, setting: "granted", tabId: undefined },
      { ...valid, setting: "granted", attachment: undefined },
      { ...valid, setting: "granted", attachment: 0 },
      { ...valid, setting: "granted", origin: "" },
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
