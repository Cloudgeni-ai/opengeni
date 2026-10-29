import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  parseSecretReference,
  referenceKey,
  type BrowserActionCommand,
  type BrowserObservation,
} from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import {
  AttachedChromeRunner,
  AttachedChromeCdpConnection,
  createAttachedChromeDriver,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { CdpConnection } from "../src/cdp";
import { PAGE_NOT_ANSWERING_HIDDEN_MESSAGE, PAGE_NOT_ANSWERING_MESSAGE } from "../src/cdp-driver";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// GitHub-style destructive menu: the menu item asks window.confirm() in its
// click handler, so the click's own input does not finish until the dialog is
// answered.
const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><title>Dialog fixture</title>
<button onclick="menu.hidden=false">Open menu</button>
<div id="menu" hidden><button onclick="out.textContent = confirm('Delete this revision?') ? 'deleted' : 'kept'">Delete revision</button></div>
<button onclick="others += 1">Other</button><p id="out">untouched</p>
<button onclick="setTimeout(() => alert('Later'), 300)">Alert later</button>
<textarea aria-label="Code" oninput="alert('Typed ' + this.value)"></textarea>
<script>var others = 0</script>`)}`;

type Driver = Pick<AgentBrowserDriver, "dispatch" | "observe" | "captureScreenshot">;

async function provesDialogsReturnPromptly(driver: Driver, start: BrowserObservation) {
  const opened = await driver.dispatch(
    command(start, {
      type: "batch",
      fenceEachAction: true,
      actions: [
        { type: "click", locator: { kind: "role", role: "button", name: "Open menu" } },
        { type: "click", locator: { kind: "role", role: "button", name: "Delete revision" } },
      ],
    }),
  );
  // The click that opened the dialog returns at once, naming it, even though
  // the caller asked for no page view.
  expect(opened?.dialog).toMatchObject({ type: "confirm", message: "Delete this revision?" });

  const captureStarted = Date.now();
  await expect(driver.captureScreenshot(opened!.target.id, {})).rejects.toThrow(
    'A JavaScript confirm dialog is open in this tab: "Delete this revision?".',
  );
  expect(Date.now() - captureStarted).toBeLessThan(2_000);
  expect((await driver.observe(opened!.target.id)).dialog?.type).toBe("confirm");

  const kept = await driver.dispatch(
    command(opened!, { type: "handle_dialog", response: "dismiss" }),
  );
  expect(kept?.dialog).toBeNull();
  expect(JSON.stringify(kept?.semantic)).toContain("kept");

  // A dialog in the middle of a batch stops it there and says which actions
  // ran; the rest never reach the blocked page.
  const batchStarted = Date.now();
  const paused = await driver
    .dispatch(
      command(kept!, {
        type: "batch",
        fenceEachAction: true,
        actions: [
          { type: "click", locator: { kind: "role", role: "button", name: "Delete revision" } },
          { type: "click", locator: { kind: "role", role: "button", name: "Other" } },
        ],
      }),
    )
    .then(
      () => null,
      (error: unknown) => error as Error & { code?: string; observation?: BrowserObservation },
    );
  expect(Date.now() - batchStarted).toBeLessThan(5_000);
  expect(paused?.code).toBe("outcome_unknown");
  expect(paused?.message).toContain("1 of 2 actions ran");
  expect(paused?.message).toContain("handle_dialog");
  expect(paused?.observation?.dialog?.type).toBe("confirm");
  const accepted = await driver.dispatch(
    command(paused!.observation!, { type: "handle_dialog", response: "accept" }),
  );
  expect(JSON.stringify(accepted?.semantic)).toContain("deleted");
}

/** An action a dialog cut short while it was still reading the page was
 * reported as not run; it must never act once the page answers again. */
async function provesCutShortActionsNeverRunLater(
  driver: Driver,
  bridge: ChromeDebuggerBridge,
  start: BrowserObservation,
) {
  const current = await driver.observe(start.target.id);
  await driver.dispatch(
    command(current, {
      type: "click",
      locator: { kind: "role", role: "button", name: "Alert later" },
    }),
  );
  const release = bridge.holdPageReads();
  const cutShort = await driver
    .dispatch(
      command(current, {
        type: "click",
        locator: { kind: "role", role: "button", name: "Other" },
      }),
    )
    .then(
      () => null,
      (error: unknown) => error as Error & { code?: string; observation?: BrowserObservation },
    );
  expect(cutShort?.code).toBe("invalid_action");
  expect(cutShort?.message).toContain("The action did not run");
  expect(cutShort?.observation?.dialog?.message).toBe("Later");
  // The page answers the held read now; the abandoned click must not follow.
  release();
  await Bun.sleep(300);
  await driver.dispatch(
    command(cutShort!.observation!, { type: "handle_dialog", response: "accept" }),
  );
  await Bun.sleep(500);
  expect(await bridge.evaluate(start.target.id, "others")).toBe(0);
}

/** Dialog text is page content and can echo a secret the action typed. */
async function provesDialogTextIsRedacted(driver: Driver, start: BrowserObservation) {
  const current = await driver.observe(start.target.id);
  const raw = ["{{", "secret:Desk/code", "}}"].join("");
  // Long and multi-line, so shortening or collapsing the dialog text first
  // would leave a recognizable part of it.
  const secret = `s3cret-${"x".repeat(320)}\nsecond line`;
  const typed = await driver
    .dispatch({
      ...command(current, {
        type: "batch",
        actions: [
          { type: "fill", locator: { kind: "label", text: "Code" }, value: raw },
          { type: "click", locator: { kind: "role", role: "button", name: "Other" } },
        ],
      } as BrowserActionCommand["action"]),
      secretValues: { [referenceKey(parseSecretReference(raw))]: secret },
    } as BrowserActionCommand)
    .then(
      () => null,
      (error: unknown) => error as Error & { observation?: BrowserObservation },
    );
  expect(typed?.message).toContain("A JavaScript alert dialog is open");
  expect(typed?.message).not.toContain("s3cret-x");
  expect(typed?.message).not.toContain("second line");
  expect(JSON.stringify(typed?.observation)).not.toContain(secret);
  // Each answer returns promptly, including when the page opens the next
  // dialog straight away.
  let page: BrowserObservation | null = typed!.observation!;
  for (let answered = 0; page?.dialog && answered < 5; answered += 1) {
    const before = Date.now();
    page = await driver.dispatch(command(page, { type: "handle_dialog", response: "accept" }));
    expect(Date.now() - before).toBeLessThan(5_000);
  }
  expect(page?.dialog ?? null).toBeNull();
}

e2e(
  "a JavaScript dialog an action opens returns promptly in a managed browser",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-dialog-managed-");
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
    });
    try {
      await provesDialogsReturnPromptly(driver, await driver.start(PAGE));
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

e2e(
  "a JavaScript dialog an action opens returns promptly in attached Chrome",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-dialog-attached-");
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
    const connection = new AttachedChromeCdpConnection(bridge, {
      browserName: "Chrome",
      browserVersion: "151.0.0.0",
    });
    const driver = createAttachedChromeDriver(
      { browserSessionId: randomUUID(), controllerGeneration: `fixture-${randomUUID()}` },
      { connection, runner: new AttachedChromeRunner(bridge, connection) },
    );
    try {
      const start = await driver.start(PAGE);
      await provesDialogsReturnPromptly(driver, start);
      await provesCutShortActionsNeverRunLater(driver, bridge, start);
      await provesDialogTextIsRedacted(driver, start);
    } finally {
      await driver.close().catch(() => undefined);
      browser.close();
      chrome.kill();
      await chrome.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);

// A dialog the page opens on its own, before anything debugs its tab.
const EARLY_DIALOG_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><title>waiting</title>
<script>setTimeout(() => { document.title = confirm("Leave this page?") ? "accepted" : "dismissed" }, 500)</script>
<button onclick="document.title = confirm('Delete it?') ? 'deleted' : 'kept'">Delete</button>`)}`;

// A page that keeps its main thread busy for 40 seconds, with no dialog.
const BUSY_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><title>busy</title>
<script>setTimeout(() => { const end = Date.now() + 40000; while (Date.now() < end) {} document.title = "done" }, 500)</script>`)}`;

/** The person's own tab in front, opened while nothing debugs it, with a
 * driver of a session that has another tab. */
async function withPersonTab(
  url: string,
  run: (fixture: {
    driver: AgentBrowserDriver;
    bridge: ChromeDebuggerBridge;
    tabId: string;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-dialog-early-");
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
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  const driver = createAttachedChromeDriver(
    { browserSessionId: randomUUID(), controllerGeneration: `fixture-${randomUUID()}` },
    { connection, runner: new AttachedChromeRunner(bridge, connection) },
  );
  try {
    await driver.start("data:text/html,<title>other</title>");
    const { tab } = await bridge.request<{ tab: { id: string } }>({ type: "tabs.create", url });
    await bridge.request({ type: "tabs.activate", tabId: tab.id });
    await Bun.sleep(1_500);
    bridge.activations.length = 0;
    await run({ driver, bridge, tabId: tab.id });
  } finally {
    await driver.close().catch(() => undefined);
    browser.close();
    chrome.kill();
    await chrome.exited;
    await rm(directory, { recursive: true, force: true });
  }
}

e2e(
  "a dialog a tab in front opened before attaching is reported at once, and handle_dialog dismiss cancels it",
  async () => {
    await withPersonTab(EARLY_DIALOG_PAGE, async ({ driver, bridge, tabId }) => {
      const pages = await bridge.pageCount();
      const started = Date.now();
      await expect(driver.observe(tabId)).rejects.toThrow(PAGE_NOT_ANSWERING_MESSAGE);
      expect(Date.now() - started).toBeLessThan(12_000);
      // Nothing was switched or answered: the person can still answer it.
      expect(bridge.activations).toEqual([]);
      expect(await bridge.title(tabId)).toBe("waiting");

      // The agent cancels it explicitly, naming the tab from its state.
      const state = await driver.targetState(tabId);
      expect(state).toMatchObject({ documentGeneration: null, frameId: null });
      const cancelled = await driver.dispatch({
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: state.browserSessionId,
        controllerGeneration: state.controllerGeneration,
        targetId: state.targetId,
        expectedTargetGeneration: state.targetGeneration,
        expectedDocumentGeneration: state.documentGeneration,
        expectedFrameId: state.frameId,
        actor: { kind: "agent", subjectId: "browserd-dialog-e2e" },
        action: { type: "handle_dialog", response: "dismiss" },
      });
      expect(cancelled?.dialog).toBeNull();
      expect(await bridge.evaluate(tabId, "document.title")).toBe("dismissed");
      // Shown again, and the blank tab shown meanwhile is gone.
      expect(bridge.activeTabId).toBe(tabId);
      expect(await bridge.pageCount()).toBe(pages);

      // A dialog it opens now shows, and handle_dialog answers it.
      const asked = await driver.dispatch({
        ...command(cancelled!, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Delete" },
        }),
        observationMode: "full",
      } as BrowserActionCommand);
      expect(asked?.dialog).toMatchObject({ type: "confirm", message: "Delete it?" });
      await driver.dispatch(command(asked!, { type: "handle_dialog", response: "accept" }));
      expect(await bridge.evaluate(tabId, "document.title")).toBe("deleted");
    });
  },
  90_000,
);

e2e(
  "a busy page in front is reported the same way, and dismissing it claims no dialog",
  async () => {
    await withPersonTab(BUSY_PAGE, async ({ driver, bridge, tabId }) => {
      const pages = await bridge.pageCount();
      await expect(driver.observe(tabId)).rejects.toThrow(PAGE_NOT_ANSWERING_MESSAGE);
      expect(bridge.activations).toEqual([]);
      const state = await driver.targetState(tabId);
      await expect(
        driver.dispatch({
          protocolVersion: 1,
          operationId: randomUUID(),
          browserSessionId: state.browserSessionId,
          controllerGeneration: state.controllerGeneration,
          targetId: state.targetId,
          expectedTargetGeneration: state.targetGeneration,
          expectedDocumentGeneration: state.documentGeneration,
          expectedFrameId: state.frameId,
          actor: { kind: "agent", subjectId: "browserd-dialog-e2e" },
          action: { type: "handle_dialog", response: "dismiss" },
        }),
      ).rejects.toThrow(PAGE_NOT_ANSWERING_HIDDEN_MESSAGE);
      expect(bridge.activeTabId).toBe(tabId);
      expect(await bridge.pageCount()).toBe(pages);
      expect(await bridge.title(tabId)).toBe("busy");
    });
  },
  90_000,
);

/** The Opengeni Chrome extension's bridge, over a real Chromium: tabs are page
 * targets, chrome.debugger is a flattened CDP session per tab, and debugger
 * events reach browserd only by polling, as they do from the extension. */
class ChromeDebuggerBridge implements AttachedBrowserBridgeTransport {
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

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    switch (payload.type) {
      case "tabs.list":
        return { tabs: await this.tabs() } as T;
      case "tabs.create": {
        // The extension opens a tab without showing it.
        const { targetId } = await this.browser.send<{ targetId: string }>("Target.createTarget", {
          url: String(payload.url),
          background: true,
        });
        return { tab: (await this.tabs()).find((tab) => this.target(tab.id) === targetId) } as T;
      }
      case "tabs.activate":
        await this.browser.send("Target.activateTarget", { targetId: this.target(payload.tabId) });
        this.activeTabId = String(payload.tabId);
        this.activations.push(this.activeTabId);
        return {} as T;
      case "tabs.close":
        await this.browser.send("Target.closeTarget", { targetId: this.target(payload.tabId) });
        return { tabs: await this.tabs() } as T;
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
      case "debugger.detach": {
        const tabId = String(payload.tabId);
        const sessionId = this.sessions.get(tabId);
        this.sessions.delete(tabId);
        if (sessionId)
          await this.browser.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
        return { detached: true } as T;
      }
      case "debugger.command": {
        const method = String(payload.method);
        if (this.held && /^(DOM|Runtime|Accessibility)\./u.test(method)) await this.held;
        const sessionId =
          typeof payload.sessionId === "string"
            ? payload.sessionId
            : this.sessions.get(String(payload.tabId));
        const result = await this.browser.send(
          String(payload.method),
          (payload.params ?? {}) as Record<string, unknown>,
          { sessionId: sessionId!, timeoutMs: 60_000 },
        );
        return { result } as T;
      }
      case "debugger.poll": {
        const after = Number(payload.afterSequence);
        const events = this.events.filter((event) => Number(event.sequence) > after);
        return { events, cursor: events.at(-1)?.sequence ?? this.sequence, truncated: false } as T;
      }
      default:
        throw new Error(`unexpected bridge request ${String(payload.type)}`);
    }
  }

  close(): void {}

  private held: Promise<void> | null = null;
  /** The tab last brought to the front; every tab is in one window. */
  activeTabId: string | null = null;
  /** Every tab brought to the front, in order. */
  readonly activations: string[] = [];

  /** A tab's title as the browser lists it, which a page held by a dialog
   * can still give. */
  async title(tabId: string): Promise<string | undefined> {
    return (await this.tabs()).find((tab) => tab.id === tabId)?.title;
  }

  async pageCount(): Promise<number> {
    return (await this.tabs()).length;
  }

  /** Holds page reads until released, as a busy page would. */
  holdPageReads(): () => void {
    let release!: () => void;
    this.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.held = null;
      release();
    };
  }

  /** Reads a page value outside the driver, through its own session. */
  async evaluate(tabId: string, expression: string): Promise<unknown> {
    const { sessionId } = await this.browser.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: this.target(tabId),
      flatten: true,
    });
    try {
      const response = await this.browser.send<{ result: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        { sessionId },
      );
      return response.result.value;
    } finally {
      await this.browser.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
    }
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
        active: this.tabId(target.targetId) === this.activeTabId,
        windowId: 1,
        controllable: true,
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

function command(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "browserd-dialog-e2e" },
    // Like an agent's view:none, except when it answers a dialog and needs
    // to see the page that results.
    ...(action.type === "handle_dialog" ? {} : { observationMode: "none" }),
    action,
  } as BrowserActionCommand;
}
