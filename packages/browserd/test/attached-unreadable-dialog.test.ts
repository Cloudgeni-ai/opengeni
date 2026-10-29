import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { AgentBrowserDriver, DISMISSED_UNREADABLE_DIALOG_NOTICE } from "../src/cdp-driver";
import {
  AttachedChromeCdpConnection,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { CdpCommandTimeoutError } from "../src/cdp";

type FixtureTab = { id: string; windowId: number };

/**
 * The extension's bridge over a browser whose tab "7" shows a dialog it opened
 * before anything debugged it. As in Chrome, no debugger can read or answer
 * that dialog and every page command waits for it; showing another tab of the
 * same window while nothing debugs the tab dismisses it.
 */
class BlockingDialogBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Readonly<Record<string, unknown>>> = [];
  readonly attached = new Set<string>();
  blocked = true;
  active: string;
  private created = 0;

  constructor(
    readonly tabs: FixtureTab[],
    active = "7",
  ) {
    this.active = active;
  }

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    if (payload.type !== "debugger.poll") this.commands.push(payload);
    const tabId = String(payload.tabId);
    switch (payload.type) {
      case "tabs.list":
        return { tabs: this.tabs.map((tab) => this.listed(tab)) } as T;
      case "tabs.create": {
        const tab = { id: String(100 + ++this.created), windowId: this.tabs[0]!.windowId };
        this.tabs.push(tab);
        return { tab: this.listed(tab) } as T;
      }
      case "tabs.activate": {
        // Chrome cancels a dialog nothing debugs when its tab is hidden.
        if (this.active === "7" && tabId !== "7" && !this.attached.has("7")) this.blocked = false;
        this.active = tabId;
        return { tab: this.listed(this.tabs.find((tab) => tab.id === tabId)!) } as T;
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
        if (tabId === "7" && this.blocked) return await new Promise<T>(() => undefined);
        return { result: this.result(tabId, String(payload.method)) } as T;
      default:
        return {} as T;
    }
  }

  close(): void {}

  private listed(tab: FixtureTab) {
    return {
      id: tab.id,
      windowId: tab.windowId,
      title: "Fixture",
      active: tab.id === this.active,
      controllable: true,
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

function attachedDriver(bridge: BlockingDialogBridge) {
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
    attachTimeoutMs: 100,
    dismissUnreadableDialog: async (tabId) => await connection.dismissUnreadableDialog(tabId),
  });
  return { connection, driver };
}

const switches = (bridge: BlockingDialogBridge) =>
  bridge.commands
    .filter((command) => command.type !== "tabs.list" && command.type !== "debugger.command")
    .map((command) => `${String(command.type)} ${String(command.tabId ?? command.url ?? "")}`);

test("a page command nobody answers fails at its deadline instead of waiting forever", async () => {
  const bridge = new BlockingDialogBridge([{ id: "7", windowId: 1 }]);
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
    const error = await connection
      .send("Runtime.evaluate", { expression: "1" }, { sessionId, timeoutMs: 50 })
      .then(
        () => null,
        (failure: unknown) => failure,
      );
    expect(error).toBeInstanceOf(CdpCommandTimeoutError);
    expect(error).toMatchObject({ method: "Runtime.evaluate", sessionId });
    expect(Date.now() - started).toBeLessThan(1_000);
  } finally {
    connection.close();
  }
});

test("a tab in front that an unreadable dialog blocks is unblocked once and the agent is told", async () => {
  const bridge = new BlockingDialogBridge([
    { id: "7", windowId: 1 },
    { id: "8", windowId: 1 },
  ]);
  const { connection, driver } = attachedDriver(bridge);
  try {
    const observation = await driver.observe("7");
    expect(observation.target.id).toBe("7");
    expect(bridge.blocked).toBe(false);
    // The debugger lets go first: Chrome keeps a debugged tab's dialog when
    // the tab is hidden. The person's tab is back in front afterwards.
    expect(switches(bridge)).toEqual([
      "debugger.attach 7",
      "debugger.detach 7",
      "tabs.activate 8",
      "tabs.activate 7",
      "debugger.attach 7",
    ]);
    expect(bridge.active).toBe("7");
    expect(driver.takeTabNotice("7")).toBe(DISMISSED_UNREADABLE_DIALOG_NOTICE);
    expect(driver.takeTabNotice("7")).toBeNull();
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});

test("a window with no other tab shows a blank one for the moment, then closes it", async () => {
  const bridge = new BlockingDialogBridge([{ id: "7", windowId: 1 }]);
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "155.0.0.0",
  });
  try {
    expect(await connection.dismissUnreadableDialog("7")).toBe(true);
    expect(bridge.blocked).toBe(false);
    expect(switches(bridge)).toEqual([
      "tabs.create data:text/html,",
      "tabs.activate 101",
      "tabs.activate 7",
      "tabs.close 101",
    ]);
    expect(bridge.tabs.map((tab) => tab.id)).toEqual(["7"]);
  } finally {
    connection.close();
  }
});

test("a blocked tab in the background is not responding, and no tab is switched", async () => {
  // Chrome already cancels the dialogs of a background tab nothing debugs, so
  // such a tab is stuck for another reason.
  const bridge = new BlockingDialogBridge(
    [
      { id: "7", windowId: 1 },
      { id: "8", windowId: 1 },
    ],
    "8",
  );
  const { connection, driver } = attachedDriver(bridge);
  try {
    const error = await driver.observe("7").then(
      () => null,
      (failure: unknown) => failure as { code?: string },
    );
    expect(error?.code).toBe("tab_not_responding");
    expect(switches(bridge)).toEqual(["debugger.attach 7"]);
    expect(bridge.active).toBe("8");
    expect(driver.takeTabNotice("7")).toBeNull();
  } finally {
    await driver.close().catch(() => undefined);
    connection.close();
  }
});
