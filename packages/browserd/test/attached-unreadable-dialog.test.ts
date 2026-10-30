import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  BrowserActionCommand as BrowserActionCommandValue,
  BrowserTargetState as BrowserTargetStateValue,
} from "@opengeni/contracts";
import {
  AgentBrowserDriver,
  DIALOG_NOT_CANCELLABLE_MESSAGE,
  PAGE_NOT_ANSWERING_MESSAGE,
  PAGE_STILL_BUSY_MESSAGE,
} from "../src/cdp-driver";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { CdpCommandTimeoutError } from "../src/cdp";
import { protectedFieldsProbeAnswer } from "./fixtures/protected-fields-probe";

type FixtureTab = { id: string; windowId: number; discarded?: boolean };

/**
 * The extension's bridge over a browser whose tab "7" does not answer. With
 * `dialog`, it waits on a dialog it opened before anything debugged it: as in
 * Chrome, no debugger can read or answer it, and hiding the tab while nothing
 * debugs it closes it. Without, the page is busy and hiding changes nothing.
 */
class UnansweredTabBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Readonly<Record<string, unknown>>> = [];
  readonly attached = new Set<string>();
  blocked = true;
  dialog = true;
  /** Without a dialog, the page finishes its work this long after its tab
   * was first hidden. */
  busyEndsAfterHideMs: number | null = null;
  private workEnded: () => void = () => undefined;
  private readonly workEnds = new Promise<void>((resolve) => (this.workEnded = resolve));
  /** The window Chrome opens a new tab in: the one last focused. */
  focusedWindow = 1;
  /** Called after the agent's tab switch, as a person clicking a tab then. */
  afterActivate: ((tabId: string) => void) | null = null;
  active = new Map<number, string>();
  private created = 0;

  constructor(readonly tabs: FixtureTab[]) {
    for (const tab of tabs)
      if (!this.active.has(tab.windowId)) this.active.set(tab.windowId, tab.id);
  }

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    if (payload.type !== "debugger.poll") this.commands.push(payload);
    const tabId = String(payload.tabId);
    switch (payload.type) {
      case "tabs.list":
        return { tabs: this.tabs.map((tab) => this.listed(tab)) } as T;
      case "tabs.create": {
        const tab = { id: String(100 + ++this.created), windowId: this.focusedWindow };
        this.tabs.push(tab);
        return { tab: this.listed(tab) } as T;
      }
      case "tabs.activate": {
        const tab = this.tabs.find((entry) => entry.id === tabId)!;
        this.show(tab);
        this.afterActivate?.(tabId);
        return { tab: this.listed(tab) } as T;
      }
      case "tabs.close":
        this.tabs.splice(
          this.tabs.findIndex((tab) => tab.id === tabId),
          1,
        );
        return { tabs: this.tabs.map((tab) => this.listed(tab)) } as T;
      case "debugger.attach":
        this.attached.add(tabId);
        return { attached: true } as T;
      case "debugger.detach":
        this.attached.delete(tabId);
        return { detached: true } as T;
      case "debugger.poll":
        return { events: [], cursor: 0, truncated: false } as T;
      case "debugger.command":
        if (tabId === "7" && this.blocked) await this.workEnds;
        return {
          result:
            protectedFieldsProbeAnswer(String(payload.method), payload.params) ??
            this.result(tabId, String(payload.method)),
        } as T;
      default:
        return {} as T;
    }
  }

  close(): void {}

  show(tab: FixtureTab): void {
    const hidden = this.active.get(tab.windowId);
    // Chrome closes a dialog nothing debugs when its tab is hidden.
    if (hidden === "7" && tab.id !== "7" && this.dialog && !this.attached.has("7"))
      this.blocked = false;
    if (hidden === "7" && tab.id !== "7" && !this.dialog && this.busyEndsAfterHideMs !== null) {
      // Commands sent meanwhile are answered once the work ends.
      setTimeout(() => {
        this.blocked = false;
        this.workEnded();
      }, this.busyEndsAfterHideMs);
      this.busyEndsAfterHideMs = null;
    }
    this.active.set(tab.windowId, tab.id);
  }

  switches(): string[] {
    return this.commands
      .filter(
        (command) =>
          command.type !== "tabs.list" &&
          command.type !== "debugger.command" &&
          command.type !== "debugger.attach",
      )
      .map((command) => `${String(command.type)} ${String(command.tabId ?? command.url ?? "")}`);
  }

  private listed(tab: FixtureTab) {
    return {
      id: tab.id,
      windowId: tab.windowId,
      title: "Fixture",
      active: this.active.get(tab.windowId) === tab.id,
      controllable: true,
      discarded: tab.discarded === true,
      url: `https://browser.example.test/${tab.id}`,
    };
  }

  private result(tabId: string, method: string): unknown {
    if (method === "Page.getFrameTree")
      return {
        frameTree: {
          frame: {
            id: `frame-${tabId}`,
            loaderId: `loader-${tabId}`,
            url: `https://browser.example.test/${tabId}`,
          },
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
    if (method === "Runtime.evaluate") return { result: { value: 1 } };
    return {};
  }
}

function attachedDriver(bridge: UnansweredTabBridge, attachTimeoutMs = 100) {
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "155.0.0.0",
  });
  // Wired as createAttachedChromeDriver wires it, with a short deadline.
  const driver = new AgentBrowserDriver({
    browserSessionId: randomUUID(),
    controllerGeneration: `fixture-${randomUUID()}`,
    engine: "chrome",
    runner: {
      async run<T>() {
        return { cdpUrl: "opengeni-attached://local" } as T;
      },
    },
    connect: async () => connection,
    attachTimeoutMs,
    personDialogs: {
      inFront: async (tabId) => await connection.tabInFront(tabId),
      hideForAMoment: async (tabId) => await connection.hideTabForAMoment(tabId),
    },
  });
  return { connection, driver };
}

async function failure(work: Promise<unknown>) {
  return await work.then(
    () => null,
    (error: unknown) => error as { code?: string; message?: string },
  );
}

function dismiss(state: BrowserTargetStateValue): BrowserActionCommandValue {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: state.browserSessionId,
    controllerGeneration: state.controllerGeneration,
    targetId: state.targetId,
    expectedTargetGeneration: state.targetGeneration,
    expectedDocumentGeneration: state.documentGeneration,
    expectedFrameId: state.frameId,
    actor: { kind: "agent", subjectId: "agent:test" },
    action: { type: "handle_dialog", response: "dismiss" },
  };
}

test("a page command nobody answers fails at its deadline instead of waiting forever", async () => {
  const bridge = new UnansweredTabBridge([{ id: "7", windowId: 1 }]);
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "155.0.0.0",
  });
  try {
    const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: "7",
      flatten: true,
    });
    const started = Date.now();
    const error = await failure(
      connection.send("Runtime.evaluate", { expression: "1" }, { sessionId, timeoutMs: 50 }),
    );
    expect(error).toBeInstanceOf(CdpCommandTimeoutError);
    expect(error).toMatchObject({ method: "Runtime.evaluate", sessionId });
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    connection.close();
  }
});

test("a tab in front whose page does not answer says so, and nothing is switched or cancelled", async () => {
  const bridge = new UnansweredTabBridge([
    { id: "7", windowId: 1 },
    { id: "8", windowId: 1 },
  ]);
  const { connection, driver } = attachedDriver(bridge);
  try {
    const error = await failure(driver.observe("7"));
    expect(error).toMatchObject({
      code: "tab_not_responding",
      message: PAGE_NOT_ANSWERING_MESSAGE,
    });
    expect(bridge.switches()).toEqual([]);
    expect(bridge.blocked).toBe(true);
    // Its state names no document, so handle_dialog can still name the tab.
    expect(await driver.targetState("7")).toMatchObject({
      targetId: "7",
      documentGeneration: null,
      frameId: null,
    });
    expect(bridge.switches()).toEqual([]);
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});

test("dismissing hides the tab behind a blank one for a moment, and reports the cancelled dialog", async () => {
  const bridge = new UnansweredTabBridge([
    { id: "7", windowId: 1 },
    { id: "8", windowId: 1 },
  ]);
  const { connection, driver } = attachedDriver(bridge);
  try {
    await failure(driver.observe("7"));
    const observation = await driver.dispatch(dismiss(await driver.targetState("7")));
    expect(observation?.target.id).toBe("7");
    expect(bridge.blocked).toBe(false);
    // The debugger lets go first: Chrome keeps a debugged tab's dialog when
    // the tab is hidden. The person's other tab sees nothing.
    expect(bridge.switches()).toEqual([
      "tabs.create about:blank",
      "debugger.detach 7",
      "tabs.activate 101",
      "tabs.activate 7",
      "tabs.close 101",
    ]);
    expect(bridge.active.get(1)).toBe("7");
    expect(bridge.tabs.map((tab) => tab.id)).toEqual(["7", "8"]);
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});

test("a busy page is not claimed to have had a dialog", async () => {
  const bridge = new UnansweredTabBridge([{ id: "7", windowId: 1 }]);
  bridge.dialog = false;
  const { connection, driver } = attachedDriver(bridge);
  try {
    await failure(driver.observe("7"));
    const error = await failure(driver.dispatch(dismiss(await driver.targetState("7"))));
    expect(error).toMatchObject({ code: "tab_not_responding", message: PAGE_STILL_BUSY_MESSAGE });
    expect(bridge.active.get(1)).toBe("7");
    expect(bridge.tabs.map((tab) => tab.id)).toEqual(["7"]);
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});

test("a busy page that answers only some time after its tab was hidden is not claimed to have had a dialog", async () => {
  const bridge = new UnansweredTabBridge([{ id: "7", windowId: 1 }]);
  bridge.dialog = false;
  bridge.busyEndsAfterHideMs = 800;
  const { connection, driver } = attachedDriver(bridge, 1_500);
  try {
    await failure(driver.observe("7"));
    const error = await failure(driver.dispatch(dismiss(await driver.targetState("7"))));
    expect(error).toMatchObject({ code: "tab_not_responding", message: PAGE_STILL_BUSY_MESSAGE });
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
}, 15_000);

test("a tab the person shows meanwhile stays in front", async () => {
  const bridge = new UnansweredTabBridge([
    { id: "7", windowId: 1 },
    { id: "8", windowId: 1 },
  ]);
  const { connection, driver } = attachedDriver(bridge);
  try {
    await failure(driver.observe("7"));
    const state = await driver.targetState("7");
    bridge.afterActivate = (tabId) => {
      bridge.afterActivate = null;
      if (tabId === "101") bridge.show(bridge.tabs.find((tab) => tab.id === "8")!);
    };
    // Hidden, so the dialog closed and the page answers: that is reported.
    expect((await driver.dispatch(dismiss(state)))?.target.id).toBe("7");
    expect(bridge.active.get(1)).toBe("8");
    expect(bridge.switches()).toEqual([
      "tabs.create about:blank",
      "debugger.detach 7",
      "tabs.activate 101",
      "tabs.close 101",
    ]);
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});

test("in a window not in front, another of its tabs is shown, never one Chrome unloaded", async () => {
  const bridge = new UnansweredTabBridge([
    { id: "5", windowId: 2 },
    { id: "7", windowId: 1 },
    { id: "8", windowId: 1, discarded: true },
    { id: "9", windowId: 1 },
  ]);
  bridge.active.set(1, "7");
  bridge.focusedWindow = 2;
  const { connection, driver } = attachedDriver(bridge);
  try {
    await failure(driver.observe("7"));
    expect((await driver.dispatch(dismiss(await driver.targetState("7"))))?.target.id).toBe("7");
    expect(bridge.switches()).toEqual([
      "tabs.create about:blank",
      "debugger.detach 7",
      "tabs.activate 9",
      "tabs.activate 7",
      "tabs.close 101",
    ]);
    expect(bridge.active.get(1)).toBe("7");
    expect(bridge.active.get(2)).toBe("5");
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});

test("a window not in front with no other tab cannot be cancelled from here, and says so", async () => {
  const bridge = new UnansweredTabBridge([
    { id: "5", windowId: 2 },
    { id: "7", windowId: 1 },
  ]);
  bridge.focusedWindow = 2;
  const { connection, driver } = attachedDriver(bridge);
  try {
    await failure(driver.observe("7"));
    const error = await failure(driver.dispatch(dismiss(await driver.targetState("7"))));
    expect(error).toMatchObject({
      code: "tab_not_responding",
      message: DIALOG_NOT_CANCELLABLE_MESSAGE,
    });
    expect(bridge.switches()).toEqual(["tabs.create about:blank", "tabs.close 101"]);
    expect(bridge.blocked).toBe(true);
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});

test("a tab in the background that does not answer is only reported, as before", async () => {
  // Chrome already closes the dialogs of a background tab nothing debugs, so
  // such a tab is stuck for another reason.
  const bridge = new UnansweredTabBridge([
    { id: "7", windowId: 1 },
    { id: "8", windowId: 1 },
  ]);
  bridge.active.set(1, "8");
  const { connection, driver } = attachedDriver(bridge);
  try {
    const error = await failure(driver.observe("7"));
    expect(error?.code).toBe("tab_not_responding");
    expect(error?.message).toStartWith("This browser tab is not responding");
    expect(bridge.switches()).toEqual([]);
    expect(bridge.active.get(1)).toBe("8");
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});
