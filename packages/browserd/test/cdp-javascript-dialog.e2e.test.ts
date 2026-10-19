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
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";
import {
  AttachedChromeRunner,
  AttachedChromeCdpConnection,
  createAttachedChromeDriver,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { CdpConnection } from "../src/cdp";

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
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `dialog_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
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
        const { targetId } = await this.browser.send<{ targetId: string }>("Target.createTarget", {
          url: String(payload.url),
        });
        return { tab: (await this.tabs()).find((tab) => this.target(tab.id) === targetId) } as T;
      }
      case "tabs.activate":
        await this.browser.send("Target.activateTarget", { targetId: this.target(payload.tabId) });
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
        active: false,
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
