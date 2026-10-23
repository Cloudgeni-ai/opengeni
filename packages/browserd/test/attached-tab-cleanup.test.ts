import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachedBrowserBridgeError,
  type AttachedBrowserBridgeOptions,
} from "../src/attached-bridge";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeConnector,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import {
  readAttachedTabLedger,
  writeAttachedTabLedger,
  type AttachedTabLedger,
} from "../src/attached-tab-ledger";
import { BrowserSupervisor } from "../src/supervisor";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GENERATION = "chrome-generation-1";
const TRANSPORT = {
  kind: "attached_chrome" as const,
  deviceId: DEVICE_ID,
  connectionGeneration: GENERATION,
  browserName: "Chrome",
  browserVersion: "151.0.0.0",
};
const BLANK = "data:text/html,";
const MINUTE = 60_000;

type FakeTab = { url: string; title: string };

/** The Opengeni Browser extension over a person's Chrome, as far as tab
 * lifecycle, debugger attachment and generation fencing go. Each bridge
 * connection is fenced to the generation it was opened for. */
class FakeChromeProfile {
  generation = GENERATION;
  readonly tabs = new Map<string, FakeTab>([
    ["1", { url: "https://person.example.test/", title: "Mine" }],
  ]);
  /** Chrome's debugger attachments: one per tab, shared by every caller. */
  readonly attached = new Set<string>();
  readonly requests: Array<Record<string, unknown>> = [];
  failListing = 0;
  private nextTab = 10;

  readonly connect: AttachedBrowserBridgeConnector = async (options) => this.bridge(options);

  bridge(
    options: Pick<AttachedBrowserBridgeOptions, "connectionGeneration">,
  ): AttachedBrowserBridgeTransport {
    return {
      request: async <T>(payload: Readonly<Record<string, unknown>>) =>
        (await this.handle(options.connectionGeneration, payload)) as T,
      close: () => undefined,
    };
  }

  open(url: string): string {
    const id = String(this.nextTab++);
    this.tabs.set(id, { url, title: "" });
    return id;
  }

  closed(type: "tabs.close" | "debugger.detach"): string[] {
    return this.requests.filter((request) => request.type === type).map((r) => String(r.tabId));
  }

  private async handle(
    generation: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (payload.type !== "debugger.poll" && payload.type !== "debugger.command")
      this.requests.push({ ...payload });
    if (generation !== this.generation)
      throw new AttachedBrowserBridgeError("fenced", "attached browser connection changed", true);
    const tabId = String(payload.tabId);
    switch (payload.type) {
      case "tabs.list":
        if (this.failListing > 0) {
          this.failListing -= 1;
          throw new AttachedBrowserBridgeError(
            "resource_unavailable",
            "Chrome is not connected",
            true,
          );
        }
        return {
          tabs: [...this.tabs].map(([id, tab]) => ({
            id,
            title: tab.title,
            url: tab.url,
            active: id === "1",
            controllable: true,
          })),
        };
      case "tabs.create": {
        const id = this.open(String(payload.url));
        return { tab: { id, title: "", url: payload.url, active: false, controllable: true } };
      }
      case "tabs.close":
        this.attached.delete(tabId);
        this.tabs.delete(tabId);
        return { tabs: [] };
      case "debugger.attach":
        if (!this.tabs.has(tabId))
          throw new AttachedBrowserBridgeError("resource_unavailable", "no such tab", false);
        this.attached.add(tabId);
        return { attached: true };
      case "debugger.detach":
        this.attached.delete(tabId);
        return { detached: true };
      case "debugger.poll":
        return { events: [], cursor: 0, truncated: false };
      case "debugger.command":
        if (!this.attached.has(tabId))
          throw new AttachedBrowserBridgeError(
            "debugger_unavailable",
            "Opengeni is not attached to this tab",
            false,
          );
        return { result: this.command(tabId, String(payload.method), payload.params) };
      default:
        return {};
    }
  }

  private command(tabId: string, method: string, params: unknown): unknown {
    const tab = this.tabs.get(tabId);
    if (method === "Page.getFrameTree")
      return {
        frameTree: {
          frame: { id: `frame-${tabId}`, loaderId: `loader-${tabId}`, url: tab?.url ?? BLANK },
        },
      };
    if (method === "Page.getLayoutMetrics")
      return {
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
        cssVisualViewport: {
          pageX: 0,
          pageY: 0,
          clientWidth: 800,
          clientHeight: 600,
          scale: 1,
        },
        cssContentSize: { x: 0, y: 0, width: 800, height: 600 },
      };
    if (method === "Accessibility.getFullAXTree") return { nodes: [] };
    if (method === "Runtime.evaluate") {
      const expression = String((params as Record<string, unknown> | undefined)?.expression);
      return {
        result: { value: expression.includes("innerWidth") ? { width: 800, height: 600 } : 1 },
      };
    }
    return {};
  }
}

function reference(sequence: number) {
  return {
    browserSessionId: `22222222-2222-4222-8222-${sequence.toString().padStart(12, "0")}`,
    controllerGeneration: `controller-${sequence}`,
  };
}

async function withChrome(
  callback: (fixture: {
    chrome: FakeChromeProfile;
    root: string;
    clock: { now: number };
    open: () => Promise<BrowserSupervisor>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-attached-tabs-");
  const chrome = new FakeChromeProfile();
  const clock = { now: Date.now() };
  const opened: BrowserSupervisor[] = [];
  const root = join(directory, "state");
  try {
    await callback({
      chrome,
      root,
      clock,
      open: async () => {
        const supervisor = await BrowserSupervisor.open({
          rootDirectory: root,
          connectAttachedBridge: chrome.connect,
          now: () => clock.now,
        });
        opened.push(supervisor);
        return supervisor;
      },
    });
  } finally {
    await Promise.allSettled(opened.map(async (supervisor) => await supervisor.close()));
    await rm(directory, { recursive: true, force: true });
  }
}

function ledger(root: string, sequence: number): AttachedTabLedger | null {
  return readAttachedTabLedger(join(root, "sessions", reference(sequence).browserSessionId));
}

async function writeLeftovers(
  root: string,
  sequence: number,
  record: Partial<AttachedTabLedger>,
): Promise<void> {
  const sessionDirectory = join(root, "sessions", reference(sequence).browserSessionId);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  writeAttachedTabLedger(sessionDirectory, {
    version: 1,
    browserSessionId: reference(sequence).browserSessionId,
    deviceId: DEVICE_ID,
    connectionGeneration: GENERATION,
    settled: false,
    ownerPid: await exitedPid(),
    createdTabs: [],
    attachedTabs: [],
    selectedTab: null,
    closedBlankTabs: [],
    updatedAt: Date.now(),
    ...record,
  });
}

/** The pid of a process that has exited: a crashed controller. */
async function exitedPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("attached Chrome sessions leave no empty tabs or debugger behind", () => {
  test("an idle session closes its empty tab, lets go of Chrome, and continues in its tab when used again", async () => {
    await withChrome(async ({ chrome, root, clock, open }) => {
      const supervisor = await open();
      const session = reference(1);
      const created = await supervisor.createSession({
        ...session,
        headed: true,
        transport: TRANSPORT,
      });
      const first = created.observation.target.id;
      expect(chrome.tabs.get(first)?.url).toBe(BLANK);
      // The agent opens a second tab and works in it.
      const second = (await supervisor.openTarget(session)).target.id;
      chrome.tabs.get(second)!.url = "https://work.example.test/";
      expect(chrome.attached.size).toBeGreaterThan(0);

      clock.now += 11 * MINUTE;
      expect(await supervisor.releaseIdleBrowsers()).toEqual([session.browserSessionId]);
      // Only the session's own empty tab closed; the person's tab and the
      // page the agent left stay, and Chrome is no longer being debugged.
      expect(chrome.closed("tabs.close")).toEqual([first]);
      expect([...chrome.tabs.keys()].sort()).toEqual(["1", second].sort());
      expect(chrome.attached.size).toBe(0);
      expect(ledger(root, 1)).toMatchObject({
        settled: true,
        createdTabs: [second],
        selectedTab: second,
        closedBlankTabs: [first],
        attachedTabs: [],
      });

      // The next request finds the session missing and the control plane
      // recovers it: it continues in the tab it was using, opening nothing.
      await expect(supervisor.listTargets(session)).rejects.toMatchObject({
        code: "resource_not_found",
      });
      const recovered = await supervisor.createSession({
        ...session,
        headed: true,
        transport: TRANSPORT,
      });
      expect(recovered.observation.target.id).toBe(second);
      expect(chrome.requests.filter((request) => request.type === "tabs.create")).toHaveLength(2);
      await expect(supervisor.observe(session, first)).rejects.toThrow(
        `this session closed this empty tab when it last released the browser; its current tab is ${second}`,
      );

      // An end leaves the page; it forgets the session's tabs.
      await supervisor.endSession(session);
      expect(chrome.tabs.has(second)).toBe(true);
      expect(chrome.attached.size).toBe(0);
      expect(ledger(root, 1)).toBeNull();
    });
  });

  test("a session in use is not released", async () => {
    await withChrome(async ({ chrome, clock, open }) => {
      const supervisor = await open();
      const session = reference(2);
      const created = await supervisor.createSession({
        ...session,
        headed: true,
        transport: TRANSPORT,
      });
      const tab = created.observation.target.id;
      clock.now += 9 * MINUTE;
      expect(await supervisor.releaseIdleBrowsers()).toEqual([]);
      await supervisor.observe(session, tab);
      clock.now += 9 * MINUTE;
      expect(await supervisor.releaseIdleBrowsers()).toEqual([]);
      expect(chrome.attached.has(tab)).toBe(true);
      clock.now += 2 * MINUTE;
      expect(await supervisor.releaseIdleBrowsers()).toEqual([session.browserSessionId]);
      expect(chrome.tabs.has(tab)).toBe(false);
    });
  });

  test("a controller shutdown closes the session's empty tab and lets go of Chrome", async () => {
    await withChrome(async ({ chrome, root, open }) => {
      const supervisor = await open();
      const session = reference(3);
      const created = await supervisor.createSession({
        ...session,
        headed: true,
        transport: TRANSPORT,
      });
      expect(chrome.attached.has(created.observation.target.id)).toBe(true);
      await supervisor.close();
      expect(chrome.tabs.has(created.observation.target.id)).toBe(false);
      expect(chrome.attached.size).toBe(0);
      expect(ledger(root, 3)?.settled).toBe(true);

      // The restarted controller recovers the session with one new tab, not
      // one more on top of an empty one.
      const successor = await open();
      const recovered = await successor.createSession({
        ...session,
        headed: true,
        transport: TRANSPORT,
      });
      expect(recovered.observation.target.id).not.toBe(created.observation.target.id);
      expect([...chrome.tabs.keys()].sort()).toEqual(["1", recovered.observation.target.id].sort());
    });
  });

  test("a session never closes or detaches a tab another session is using", async () => {
    await withChrome(async ({ chrome, root, clock, open }) => {
      const supervisor = await open();
      const first = reference(4);
      const second = reference(5);
      const shared = (
        await supervisor.createSession({ ...first, headed: true, transport: TRANSPORT })
      ).observation.target.id;
      await supervisor.createSession({ ...second, headed: true, transport: TRANSPORT });
      clock.now += 11 * MINUTE;
      // The second session moves into the first session's empty tab.
      await supervisor.selectTarget(second, shared);
      expect(await supervisor.releaseIdleBrowsers()).toEqual([first.browserSessionId]);
      expect(chrome.tabs.has(shared)).toBe(true);
      expect(chrome.attached.has(shared)).toBe(true);
      expect((await supervisor.observe(second, shared)).target.id).toBe(shared);
      // The first session's cleanup is pending, not forgotten.
      expect(ledger(root, 4)).toMatchObject({ settled: false, createdTabs: [shared] });

      // Once the second session lets go too, the empty tab closes.
      await supervisor.endSession(second);
      expect(chrome.attached.has(shared)).toBe(false);
      expect(await supervisor.releaseAttachedLeftovers()).toEqual([first.browserSessionId]);
      expect(chrome.tabs.has(shared)).toBe(false);
      expect(ledger(root, 4)?.settled).toBe(true);
    });
  });

  test("a new controller cleans up after a crashed one without touching pages or the person's tabs", async () => {
    await withChrome(async ({ chrome, root, open }) => {
      const blank = chrome.open(BLANK);
      const used = chrome.open("https://work.example.test/");
      const persons = chrome.open(BLANK);
      chrome.attached.add(blank);
      chrome.attached.add(used);
      chrome.attached.add(persons);
      await writeLeftovers(root, 6, {
        createdTabs: [blank, used],
        attachedTabs: [blank, used],
        selectedTab: used,
      });
      const supervisor = await open();
      expect(await supervisor.releaseAttachedLeftovers()).toEqual([reference(6).browserSessionId]);
      expect(chrome.closed("tabs.close")).toEqual([blank]);
      expect(chrome.closed("debugger.detach")).toEqual([used]);
      expect(chrome.tabs.has(used)).toBe(true);
      expect(chrome.tabs.has(persons)).toBe(true);
      // Another session's attachment is not this session's to release.
      expect(chrome.attached.has(persons)).toBe(true);
      expect(ledger(root, 6)).toMatchObject({
        settled: true,
        createdTabs: [used],
        attachedTabs: [],
        closedBlankTabs: [blank],
        selectedTab: used,
      });
      // Recovered later, the session continues in the tab it was using.
      const recovered = await supervisor.createSession({
        ...reference(6),
        headed: true,
        transport: TRANSPORT,
      });
      expect(recovered.observation.target.id).toBe(used);
    });
  });

  test("a session a live controller still holds is left to it", async () => {
    await withChrome(async ({ chrome, root, open }) => {
      const blank = chrome.open(BLANK);
      await writeLeftovers(root, 7, { createdTabs: [blank], ownerPid: process.ppid });
      const supervisor = await open();
      expect(await supervisor.releaseAttachedLeftovers()).toEqual([]);
      expect(chrome.tabs.has(blank)).toBe(true);
      expect(ledger(root, 7)?.settled).toBe(false);
    });
  });

  test("cleanup that cannot reach Chrome is retried; a reconnected profile is never touched", async () => {
    await withChrome(async ({ chrome, root, open }) => {
      const blank = chrome.open(BLANK);
      const stale = chrome.open(BLANK);
      await writeLeftovers(root, 8, { createdTabs: [blank] });
      await writeLeftovers(root, 9, {
        createdTabs: [stale],
        connectionGeneration: "chrome-generation-0",
      });
      chrome.failListing = 1;
      const supervisor = await open();
      // The startup sweep may already be running; join it, then sweep again.
      await supervisor.releaseAttachedLeftovers();
      await supervisor.releaseAttachedLeftovers();
      expect(chrome.tabs.has(blank)).toBe(false);
      expect(ledger(root, 8)?.settled).toBe(true);
      // Tab ids from an older connection generation may name other tabs now.
      expect(chrome.tabs.has(stale)).toBe(true);
      expect(ledger(root, 9)).toMatchObject({ settled: true, createdTabs: [] });
    });
  });

  test("ending a released session settles the cleanup its release could not finish", async () => {
    await withChrome(async ({ chrome, root, open }) => {
      const blank = chrome.open(BLANK);
      await writeLeftovers(root, 10, { createdTabs: [blank], ownerPid: process.pid });
      chrome.failListing = 1;
      const supervisor = await open();
      await supervisor.releaseAttachedLeftovers();
      await expect(supervisor.endSession(reference(10))).rejects.toMatchObject({
        code: "resource_not_found",
      });
      expect(chrome.tabs.has(blank)).toBe(false);
      expect(ledger(root, 10)).toBeNull();
    });
  });
});

describe("shared debugger attachments", () => {
  test("shutdown releases Chrome's debugger only on tabs no other session holds", async () => {
    const chrome = new FakeChromeProfile();
    const shared = chrome.open("https://shared.example.test/");
    const own = chrome.open("https://own.example.test/");
    const connection = (inherited: string[] = []) =>
      new AttachedChromeCdpConnection(chrome.bridge({ connectionGeneration: GENERATION }), {
        browserName: "Chrome",
        browserVersion: "151.0.0.0",
        attachments: { deviceId: DEVICE_ID, connectionGeneration: GENERATION, inherited },
      });
    const first = connection();
    const second = connection([own]);
    chrome.attached.add(own);
    try {
      await first.send("Target.attachToTarget", { targetId: shared, flatten: true });
      await second.send("Target.attachToTarget", { targetId: shared, flatten: true });
      expect(first.debuggerHeldElsewhere(shared)).toBe(true);
      await first.shutdown();
      expect(chrome.closed("debugger.detach")).toEqual([]);
      expect(second.debuggerHeldElsewhere(shared)).toBe(false);
      // The inherited attachment is released as this connection's own.
      await second.shutdown();
      expect(chrome.closed("debugger.detach").sort()).toEqual([own, shared].sort());
      expect(second.leftoverAttachments()).toEqual([]);
    } finally {
      first.close();
      second.close();
    }
  });

  test("a debugger released by another controller attaches again without making the tab uncertain", async () => {
    const chrome = new FakeChromeProfile();
    const tab = chrome.open("https://shared.example.test/");
    const connection = new AttachedChromeCdpConnection(
      chrome.bridge({ connectionGeneration: GENERATION }),
      { browserName: "Chrome", browserVersion: "151.0.0.0" },
    );
    try {
      const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: tab,
        flatten: true,
      });
      // Another controller's shutdown detached Chrome's debugger.
      chrome.attached.delete(tab);
      await expect(
        connection.send(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", x: 1, y: 1 },
          { sessionId },
        ),
      ).rejects.toMatchObject({ code: "resource_unavailable", retryable: true });
      const again = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: tab,
        flatten: true,
      });
      await expect(
        connection.send("Page.getFrameTree", {}, { sessionId: again.sessionId }),
      ).resolves.toBeDefined();
    } finally {
      connection.close();
    }
  });

  test("a detach that fails is reported as left over", async () => {
    const chrome = new FakeChromeProfile();
    const tab = chrome.open("https://shared.example.test/");
    const bridge = chrome.bridge({ connectionGeneration: GENERATION });
    const connection = new AttachedChromeCdpConnection(
      {
        request: async <T>(payload: Readonly<Record<string, unknown>>) => {
          if (payload.type === "debugger.detach")
            throw new AttachedBrowserBridgeError("timeout", "bridge timed out", true);
          return await bridge.request<T>(payload);
        },
        close: () => undefined,
      },
      { browserName: "Chrome", browserVersion: "151.0.0.0" },
    );
    await connection.send("Target.attachToTarget", { targetId: tab, flatten: true });
    await connection.shutdown();
    expect(connection.leftoverAttachments()).toEqual([tab]);
  });
});
