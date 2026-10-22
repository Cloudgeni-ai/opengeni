import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AttachedChromeCdpConnection,
  AttachedChromeRunner,
  createAttachedChromeDriver,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { AttachedBrowserBridgeError } from "../src/attached-bridge";

const FOCUS_EMULATION = "Emulation.setFocusEmulationEnabled";

/** A connected Chrome whose agent tabs sit in the background. */
class BackgroundTabBridge implements AttachedBrowserBridgeTransport {
  readonly commands: Array<Readonly<Record<string, unknown>>> = [];

  constructor(private readonly admitsFocusEmulation: boolean) {}

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    this.commands.push(payload);
    switch (payload.type) {
      case "tabs.list":
        return {
          tabs: ["7", "8"].map((id) => ({
            id,
            title: "Fixture",
            active: id === "8",
            controllable: true,
            url: `https://browser.example.test/${id}`,
          })),
        } as T;
      case "tabs.create":
        return {
          tab: {
            id: "7",
            title: "Fixture",
            active: false,
            controllable: true,
            url: "https://browser.example.test/7",
          },
        } as T;
      case "debugger.poll":
        return { events: [], cursor: 0, truncated: false } as T;
      case "debugger.command":
        return { result: this.result(payload) } as T;
      default:
        return {} as T;
    }
  }

  close(): void {}

  focusEmulationRequests(): Array<Readonly<Record<string, unknown>>> {
    return this.commands.filter(
      (command) => command.type === "debugger.command" && command.method === FOCUS_EMULATION,
    );
  }

  private result(payload: Readonly<Record<string, unknown>>): unknown {
    const id = String(payload.tabId);
    switch (payload.method) {
      case FOCUS_EMULATION:
        if (!this.admitsFocusEmulation)
          throw new AttachedBrowserBridgeError(
            "driver_rejected",
            "debugger method is outside the browser driver surface",
            false,
          );
        return {};
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: {
              id: `frame-${id}`,
              loaderId: `loader-${id}`,
              url: `https://browser.example.test/${id}`,
            },
          },
        };
      case "Page.getLayoutMetrics":
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
      case "Accessibility.getFullAXTree":
        return { nodes: [] };
      case "Runtime.evaluate":
        return {
          result: {
            value: String((payload.params as Record<string, unknown>)?.expression).includes(
              "innerWidth",
            )
              ? { width: 800, height: 600 }
              : 1,
          },
        };
      default:
        return {};
    }
  }
}

async function start(bridge: BackgroundTabBridge) {
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  const driver = createAttachedChromeDriver(
    { browserSessionId: randomUUID(), controllerGeneration: `fixture-${randomUUID()}` },
    { connection, runner: new AttachedChromeRunner(bridge, connection) },
  );
  const observation = await driver.start();
  return { driver, observation };
}

test("an attached background tab gets focus emulation so Chrome acknowledges its input", async () => {
  const bridge = new BackgroundTabBridge(true);
  const { driver, observation } = await start(bridge);
  try {
    expect(observation.target.id).toBe("7");
    expect(bridge.focusEmulationRequests()).toEqual([
      expect.objectContaining({ tabId: "7", params: { enabled: true } }),
    ]);
  } finally {
    await driver.close();
  }
});

test("an extension that predates focus emulation still drives its tabs", async () => {
  const bridge = new BackgroundTabBridge(false);
  const { driver, observation } = await start(bridge);
  try {
    expect(observation.target.id).toBe("7");
    expect(bridge.focusEmulationRequests()).toHaveLength(1);
    await driver.observe(observation.target.id);
    expect(bridge.focusEmulationRequests()).toHaveLength(1);
  } finally {
    await driver.close();
  }
});
