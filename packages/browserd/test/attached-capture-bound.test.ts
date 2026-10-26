import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  AttachedChromeCdpConnection,
  AttachedChromeRunner,
  createAttachedChromeDriver,
  type AttachedBrowserBridgeTransport,
} from "../src/attached-cdp";
import { AttachedBrowserBridgeError } from "../src/attached-bridge";

// A 1×1 PNG.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
/** As long as an explicit PNG of a large, detailed page can take. */
const SLOW_CAPTURE_MS = 3_400;

/** A person's Chrome with the agent's tab either in front of its window or
 * behind another one. Every screenshot takes a while, or Chrome refuses the
 * first `refusals` of them as it does for a tab it has not drawn yet. */
class SlowCaptureBridge implements AttachedBrowserBridgeTransport {
  captures = 0;

  constructor(
    private readonly agentTabInFront: boolean,
    private readonly refusals = 0,
  ) {}

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    switch (payload.type) {
      case "tabs.list":
        return {
          tabs: ["7", "8"].map((id) => ({
            id,
            title: "Fixture",
            active: (id === "7") === this.agentTabInFront,
            controllable: true,
            url: `https://browser.example.test/${id}`,
          })),
        } as T;
      case "tabs.create":
        return {
          tab: {
            id: "7",
            title: "Fixture",
            active: this.agentTabInFront,
            controllable: true,
            url: "https://browser.example.test/7",
          },
        } as T;
      case "debugger.poll":
        return { events: [], cursor: 0, truncated: false } as T;
      case "debugger.command":
        if (payload.method === "Page.captureScreenshot") {
          this.captures += 1;
          if (this.captures <= this.refusals)
            throw new AttachedBrowserBridgeError(
              "driver_rejected",
              JSON.stringify({ code: -32_000, message: "Unable to capture screenshot" }),
              false,
            );
          if (this.refusals > 0) return { result: { data: PIXEL } } as T;
          await Bun.sleep(SLOW_CAPTURE_MS);
          return { result: { data: PIXEL } } as T;
        }
        return { result: this.result(payload) } as T;
      default:
        return {} as T;
    }
  }

  close(): void {}

  private result(payload: Readonly<Record<string, unknown>>): unknown {
    const id = String(payload.tabId);
    switch (payload.method) {
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

async function capture(agentTabInFront: boolean, refusals = 0) {
  const bridge = new SlowCaptureBridge(agentTabInFront, refusals);
  const connection = new AttachedChromeCdpConnection(bridge, {
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
  });
  const driver = createAttachedChromeDriver(
    { browserSessionId: randomUUID(), controllerGeneration: `fixture-${randomUUID()}` },
    { connection, runner: new AttachedChromeRunner(bridge, connection) },
  );
  try {
    const observation = await driver.start();
    expect(observation.target.id).toBe("7");
    const started = performance.now();
    const outcome = await driver.captureScreenshot(observation.target.id).then(
      (frame) => frame,
      (error: unknown) => error,
    );
    return { outcome, elapsed: performance.now() - started, captures: bridge.captures };
  } finally {
    await driver.close();
  }
}

test("a slow capture of the tab in front of its window is not cut short", async () => {
  const { outcome, elapsed } = await capture(true);
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(elapsed).toBeGreaterThanOrEqual(SLOW_CAPTURE_MS - 50);
}, 20_000);

test("a capture of a tab behind another one stops plainly after 3 s", async () => {
  const { outcome, elapsed } = await capture(false);
  expect(outcome).toMatchObject({ code: "timeout", retryable: true });
  expect((outcome as Error).message).toStartWith(
    "browser screenshot stalled: Chrome did not draw this tab within 3 s",
  );
  expect(elapsed).toBeLessThan(SLOW_CAPTURE_MS);
}, 20_000);

test("a capture Chrome refuses for an undrawn tab is asked again", async () => {
  const { outcome, captures } = await capture(true, 2);
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(captures).toBe(3);
});

test("a capture Chrome keeps refusing fails with a plain reason", async () => {
  const { outcome, captures } = await capture(true, Number.POSITIVE_INFINITY);
  expect(outcome).toMatchObject({
    code: "resource_unavailable",
    retryable: true,
    message:
      "browser screenshot unavailable: Chrome could not draw this tab, which can happen while it is not shown; select it with browser_tabs to capture it, or read it with browser_observe",
  });
  expect(captures).toBe(4);
});
