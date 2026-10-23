import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BrowserActionCommand } from "@opengeni/contracts";
import { AttachedBrowserBridgeError } from "../src/attached-bridge";
import type { AttachedBrowserBridgeConnector } from "../src/attached-cdp";
import { readAttachedTabLedger, writeAttachedTabLedger } from "../src/attached-tab-ledger";
import { CdpConnection } from "../src/cdp";
import { BrowserSupervisor } from "../src/supervisor";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GENERATION = "chrome-generation-1";
const TRANSPORT = {
  kind: "attached_chrome" as const,
  deviceId: DEVICE_ID,
  connectionGeneration: GENERATION,
  browserName: "Chrome",
  browserVersion: "151.0.0.0",
};
const PAGE = `data:text/html,${encodeURIComponent("<!doctype html><title>Work</title><p>Agent work</p>")}`;
const MINUTE = 60_000;

function reference(sequence: number) {
  return {
    browserSessionId: `33333333-3333-4333-8333-${sequence.toString().padStart(12, "0")}`,
    controllerGeneration: `controller-${sequence}`,
  };
}

e2e(
  "attached Chrome sessions close their empty tabs and release the debugger however they end",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-attached-tabs-e2e-");
    const root = join(directory, "state");
    const chrome = Bun.spawn(
      [
        process.env.OPENGENI_BROWSER_EXECUTABLE ?? "chromium",
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(directory, "profile")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const browser = await CdpConnection.connect(await devtoolsEndpoint(chrome.stderr));
    const bridge = new ChromeDebuggerBridge(browser);
    const connect: AttachedBrowserBridgeConnector = async () => ({
      request: async (payload) => await bridge.request(payload),
      close: () => undefined,
    });
    const clock = { now: Date.now() };
    const open = async () =>
      await BrowserSupervisor.open({
        rootDirectory: root,
        connectAttachedBridge: connect,
        now: () => clock.now,
      });
    const supervisors: BrowserSupervisor[] = [];
    try {
      // The person's own tab: Chromium may list its startup tab only a moment
      // after it reports its DevTools endpoint.
      await waitFor(async () => (await bridge.pages()).length > 0);
      const person = (await bridge.pages()).map((page) => page.id);
      const supervisor = await open();
      supervisors.push(supervisor);
      const session = reference(1);

      // The agent works in its own tab and leaves a second one empty.
      const work = (
        await supervisor.createSession({
          ...session,
          headed: true,
          transport: TRANSPORT,
          initialUrl: PAGE,
        })
      ).observation.target.id;
      const empty = (await supervisor.openTarget(session)).target.id;
      expect((await bridge.pages()).find((page) => page.id === empty)?.url).toBe("data:text/html,");
      await supervisor.selectTarget(session, work);
      expect(bridge.attachedTabs().length).toBeGreaterThan(0);

      // Ten minutes without use: the empty tab closes and Chrome is no
      // longer debugged; the page and the person's tab stay.
      clock.now += 11 * MINUTE;
      expect(await supervisor.releaseIdleBrowsers()).toEqual([session.browserSessionId]);
      expect((await bridge.pages()).map((page) => page.id).sort()).toEqual(
        [...person, work].sort(),
      );
      expect(bridge.attachedTabs()).toEqual([]);

      // Its next request recovers it in the same tab, opening nothing.
      const recovered = await supervisor.createSession({
        ...session,
        headed: true,
        transport: TRANSPORT,
      });
      expect(recovered.observation.target.id).toBe(work);
      expect(recovered.observation.target.title).toBe("Work");
      expect((await bridge.pages()).length).toBe(person.length + 1);
      await expect(supervisor.observe(session, empty)).rejects.toThrow(
        `this session closed this empty tab when it last released the browser; its current tab is ${work}`,
      );

      // A controller shutdown (an agent update or restart) cleans up too.
      const other = reference(2);
      const otherTab = (
        await supervisor.createSession({ ...other, headed: true, transport: TRANSPORT })
      ).observation.target.id;
      await supervisor.close();
      const afterShutdown = (await bridge.pages()).map((page) => page.id);
      expect(afterShutdown).not.toContain(otherTab);
      expect(afterShutdown).toContain(work);
      expect(bridge.attachedTabs()).toEqual([]);

      // A controller that crashed left an empty tab with the debugger
      // attached; the next controller cleans it up at startup.
      const crashed = reference(3);
      const leftover = await bridge.request<{ tab: { id: string } }>({
        type: "tabs.create",
        url: "data:text/html,",
      });
      await bridge.request({ type: "debugger.attach", tabId: leftover.tab.id });
      const crashedDirectory = join(root, "sessions", crashed.browserSessionId);
      await mkdir(crashedDirectory, { recursive: true, mode: 0o700 });
      const exited = Bun.spawn(["true"]);
      await exited.exited;
      writeAttachedTabLedger(crashedDirectory, {
        version: 1,
        browserSessionId: crashed.browserSessionId,
        deviceId: DEVICE_ID,
        connectionGeneration: GENERATION,
        settled: false,
        ownerPid: exited.pid,
        createdTabs: [leftover.tab.id],
        attachedTabs: [leftover.tab.id],
        selectedTab: leftover.tab.id,
        closedBlankTabs: [],
        updatedAt: Date.now(),
      });
      const successor = await open();
      supervisors.push(successor);
      expect(await successor.releaseAttachedLeftovers()).toEqual([crashed.browserSessionId]);
      expect((await bridge.pages()).map((page) => page.id)).not.toContain(leftover.tab.id);
      expect(bridge.attachedTabs()).toEqual([]);
      expect(readAttachedTabLedger(crashedDirectory)?.settled).toBe(true);
    } finally {
      await Promise.allSettled(supervisors.map(async (supervisor) => await supervisor.close()));
      browser.close();
      chrome.kill();
      await chrome.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  90_000,
);

e2e(
  "a session waiting on a JavaScript dialog keeps Chrome; a tab blocked while released does not hold its return",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-attached-dialog-e2e-");
    const root = join(directory, "state");
    const chrome = Bun.spawn(
      [
        process.env.OPENGENI_BROWSER_EXECUTABLE ?? "chromium",
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(directory, "profile")}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const browser = await CdpConnection.connect(await devtoolsEndpoint(chrome.stderr));
    const bridge = new ChromeDebuggerBridge(browser);
    const connect: AttachedBrowserBridgeConnector = async () => ({
      request: async (payload) => await bridge.request(payload),
      close: () => undefined,
    });
    const clock = { now: Date.now() };
    const supervisor = await BrowserSupervisor.open({
      rootDirectory: root,
      connectAttachedBridge: connect,
      now: () => clock.now,
    });
    try {
      const session = reference(11);
      const work = (
        await supervisor.createSession({
          ...session,
          headed: true,
          transport: TRANSPORT,
          initialUrl: PAGE,
        })
      ).observation.target.id;

      // The agent's action opened a confirm; it asks the person and waits.
      await bridge.request({
        type: "debugger.command",
        tabId: work,
        method: "Runtime.evaluate",
        params: { expression: "setTimeout(() => confirm('Are you sure?'), 0)" },
      });
      let observation = await supervisor.observe(session, work);
      await waitFor(async () => {
        observation = await supervisor.observe(session, work);
        return observation.dialog !== null;
      });
      // Chrome offers the dialog only to the debugger attached when it opened:
      // releasing now would leave nobody able to see or answer it.
      clock.now += 11 * MINUTE;
      expect(await supervisor.releaseIdleBrowsers()).toEqual([]);
      expect(bridge.attachedTabs()).toContain(work);
      const answered = await supervisor.action({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: session.browserSessionId,
        controllerGeneration: observation.target.controllerGeneration,
        targetId: work,
        expectedTargetGeneration: observation.target.targetGeneration,
        expectedDocumentGeneration: observation.target.documentGeneration,
        expectedFrameId: observation.frameId!,
        actor: { kind: "agent", subjectId: "attached-dialog-e2e" },
        action: { type: "handle_dialog", response: "accept" },
      } as BrowserActionCommand);
      expect(answered.state).toBe("completed");
      expect(answered.observation?.dialog ?? null).toBeNull();
      clock.now += 11 * MINUTE;
      expect(await supervisor.releaseIdleBrowsers()).toEqual([session.browserSessionId]);
      expect(bridge.attachedTabs()).toEqual([]);

      // While nobody holds the browser, the page opens an alert. No debugger
      // attached later can see or answer it, and the page answers nothing
      // until the person does. The session's return opens a new tab within a
      // few seconds instead of waiting on it, and leaves the tab as it is.
      const { sessionId } = await browser.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId: bridge.targetOf(work),
        flatten: true,
      });
      await browser.send("Page.enable", {}, { sessionId });
      void browser
        .send("Runtime.evaluate", { expression: "alert('Saved')" }, { sessionId })
        .catch(() => undefined);
      await Bun.sleep(300);
      await browser.send("Target.detachFromTarget", { sessionId });
      const started = Date.now();
      const recovered = await supervisor.createSession({
        ...session,
        headed: true,
        transport: TRANSPORT,
      });
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(recovered.observation.target.id).not.toBe(work);
      expect((await bridge.pages()).map((page) => page.id)).toContain(work);
    } finally {
      await supervisor.close().catch(() => undefined);
      browser.close();
      chrome.kill();
      await chrome.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  150_000,
);

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(50);
  }
}

/** The Opengeni Chrome extension's bridge, over a real Chromium: tabs are page
 * targets, chrome.debugger is one flattened CDP session per tab shared by
 * every caller, closing a tab ends its attachment, and debugger events reach
 * browserd only by polling, as they do from the extension. */
class ChromeDebuggerBridge {
  /** Chrome tab ids are small integers; CDP target ids are not. */
  private readonly tabIds = new Map<string, string>();
  private readonly sessions = new Map<string, string>();
  private readonly events: Array<Record<string, unknown>> = [];
  private sequence = 0;

  constructor(private readonly browser: CdpConnection) {
    browser.on("*", (event) => {
      const tabId = [...this.sessions].find(([, session]) => session === event.sessionId)?.[0];
      if (!tabId) return;
      this.sequence += 1;
      this.events.push({
        sequence: this.sequence,
        tabId,
        sessionId: null,
        method: event.method,
        params: event.params,
      });
    });
  }

  targetOf(tabId: string): string {
    return this.target(tabId);
  }

  attachedTabs(): string[] {
    return [...this.sessions.keys()];
  }

  async pages(): Promise<Array<{ id: string; url: string }>> {
    return (await this.tabs()).map((tab) => ({ id: tab.id, url: tab.url }));
  }

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    switch (payload.type) {
      case "tabs.list":
        return { tabs: await this.tabs() } as T;
      case "tabs.create": {
        const { targetId } = await this.browser.send<{ targetId: string }>("Target.createTarget", {
          url: String(payload.url),
          background: true,
        });
        return { tab: (await this.tabs()).find((tab) => this.target(tab.id) === targetId) } as T;
      }
      case "tabs.activate":
        await this.browser.send("Target.activateTarget", { targetId: this.target(payload.tabId) });
        return {} as T;
      case "tabs.close": {
        const tabId = String(payload.tabId);
        const targetId = this.target(tabId);
        await this.detach(tabId);
        await this.browser.send("Target.closeTarget", { targetId });
        // chrome.tabs.remove resolves once the tab is gone; Target.closeTarget
        // returns while Chromium may still list the closing target.
        await waitFor(async () => !(await this.targetListed(targetId)));
        return { tabs: await this.tabs() } as T;
      }
      case "debugger.attach": {
        const tabId = String(payload.tabId);
        if (!this.sessions.has(tabId)) {
          const { sessionId } = await this.browser.send<{ sessionId: string }>(
            "Target.attachToTarget",
            { targetId: this.target(tabId), flatten: true },
          );
          this.sessions.set(tabId, sessionId);
        }
        return { attached: true } as T;
      }
      case "debugger.detach":
        await this.detach(String(payload.tabId));
        return { detached: true } as T;
      case "debugger.command": {
        const tabId = String(payload.tabId);
        const attached = this.sessions.get(tabId);
        if (!attached) {
          throw new AttachedBrowserBridgeError(
            "debugger_unavailable",
            "Opengeni is not attached to this tab",
            false,
          );
        }
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : attached;
        const result = await this.browser.send(
          String(payload.method),
          (payload.params ?? {}) as Record<string, unknown>,
          { sessionId, timeoutMs: 60_000 },
        );
        return { result } as T;
      }
      case "debugger.poll": {
        const after = Number(payload.afterSequence);
        const events = this.events.filter((event) => Number(event.sequence) > after);
        return { events, cursor: events.at(-1)?.sequence ?? this.sequence, truncated: false } as T;
      }
      default:
        return {} as T;
    }
  }

  private async detach(tabId: string): Promise<void> {
    const sessionId = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    if (sessionId)
      await this.browser.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }

  private tabId(targetId: string): string {
    for (const [id, target] of this.tabIds) if (target === targetId) return id;
    const id = String(this.tabIds.size + 1);
    this.tabIds.set(id, targetId);
    return id;
  }

  private target(tabId: unknown): string {
    return this.tabIds.get(String(tabId))!;
  }

  private async targetListed(targetId: string): Promise<boolean> {
    const { targetInfos } = await this.browser.send<{
      targetInfos: Array<{ targetId: string }>;
    }>("Target.getTargets");
    return targetInfos.some((target) => target.targetId === targetId);
  }

  private async tabs() {
    const { targetInfos } = await this.browser.send<{
      targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>;
    }>("Target.getTargets");
    return targetInfos
      .filter((target) => target.type === "page")
      .map((target) => ({
        id: this.tabId(target.targetId),
        title: target.title || "Untitled",
        url: target.url,
        active: false,
        controllable: !target.url.startsWith("about:") && !target.url.startsWith("chrome:"),
      }));
  }
}

async function devtoolsEndpoint(stderr: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stderr) {
    output += decoder.decode(chunk);
    const match = /DevTools listening on (ws:\/\/\S+)/u.exec(output);
    if (match) return match[1]!;
  }
  throw new Error(`Chromium did not report a DevTools endpoint: ${output}`);
}
