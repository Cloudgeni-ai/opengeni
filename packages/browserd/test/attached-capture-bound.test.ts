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
/** The request that only has Chrome draw the tab again. */
const ASK_AGAIN = { format: "jpeg", quality: 1, fromSurface: true, captureBeyondViewport: false };
const STALLED =
  "browser screenshot stalled: Chrome did not draw this tab, which can happen while another tab is in front of it in its window; try again, or read it with browser_observe.";

type Fixture = {
  /** Whether the agent's tab is in front of its window. */
  inFront: boolean;
  /** How long each screenshot takes, by its 1-based number. */
  captureMs?: (number: number) => number;
  /** Whether Chrome refuses a screenshot, as for a tab it has not drawn yet. */
  refuses?: (number: number) => boolean;
  /** A screenshot Chrome never answers, not even with a later drawing. */
  lost?: (number: number) => boolean;
};

type Waiting = { number: number; answer: (refused: boolean) => void };

/** A person's Chrome with the agent's tab either in front of its window or
 * behind another one, whose screenshots take a while or are refused. */
class SlowCaptureBridge implements AttachedBrowserBridgeTransport {
  captures = 0;
  /** Each screenshot's parameters, and every debugger method, in order. */
  captureParams: Record<string, unknown>[] = [];
  methods: string[] = [];
  /** Screenshots not answered yet. Chrome answers every one still waiting
   * with the drawing it makes for a later one, as it does. */
  private waiting: Waiting[] = [];
  /** How long the listing that asks whether the tab is shown takes: the one
   * right after a capture reads the page's layout. */
  listMs = 0;
  private afterLayout = false;

  constructor(private readonly fixture: Fixture) {}

  async request<T>(payload: Readonly<Record<string, unknown>>): Promise<T> {
    const inFront = this.fixture.inFront;
    const afterLayout = this.afterLayout;
    this.afterLayout =
      payload.type === "debugger.command" && payload.method === "Page.getLayoutMetrics";
    switch (payload.type) {
      case "tabs.list":
        if (afterLayout) await Bun.sleep(this.listMs);
        return {
          tabs: ["7", "8"].map((id) => ({
            id,
            title: "Fixture",
            active: (id === "7") === inFront,
            controllable: true,
            url: `https://browser.example.test/${id}`,
          })),
        } as T;
      case "tabs.create":
        return {
          tab: {
            id: "7",
            title: "Fixture",
            active: inFront,
            controllable: true,
            url: "https://browser.example.test/7",
          },
        } as T;
      case "debugger.poll":
        return { events: [], cursor: 0, truncated: false } as T;
      case "debugger.command":
        this.methods.push(String(payload.method));
        if (payload.method === "Page.captureScreenshot") {
          const number = (this.captures += 1);
          this.captureParams.push({ ...(payload.params as Record<string, unknown>) });
          const refused = await new Promise<boolean>((resolve) => {
            if (this.fixture.lost?.(number)) return;
            const timer = setTimeout(
              () => {
                const refusedNow = this.fixture.refuses?.(number) ?? false;
                for (const earlier of this.waiting.filter((entry) => entry.number <= number))
                  earlier.answer(refusedNow);
                this.waiting = this.waiting.filter((entry) => entry.number > number);
              },
              this.fixture.captureMs?.(number) ?? 0,
            );
            this.waiting.push({
              number,
              answer: (refusedNow) => {
                clearTimeout(timer);
                resolve(refusedNow);
              },
            });
          });
          if (refused)
            throw new AttachedBrowserBridgeError(
              "driver_rejected",
              JSON.stringify({ code: -32_000, message: "Unable to capture screenshot" }),
              false,
            );
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

async function capture(fixture: Fixture, options: { listMs?: number; fullPage?: boolean } = {}) {
  const bridge = new SlowCaptureBridge(fixture);
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
    bridge.listMs = options.listMs ?? 0;
    const started = performance.now();
    const outcome = await driver
      .captureScreenshot(observation.target.id, options.fullPage ? { fullPage: true } : {})
      .then(
        (frame) => frame,
        (error: unknown) => error,
      );
    const elapsed = performance.now() - started;
    bridge.listMs = 0;
    const captures = bridge.captures;
    // Nothing more reaches Chrome once the capture has answered.
    await Bun.sleep(400);
    return {
      outcome,
      elapsed,
      captures,
      capturesLater: bridge.captures,
      params: bridge.captureParams,
      methods: bridge.methods,
    };
  } finally {
    await driver.close();
  }
}

test("a slow capture of the tab in front of its window is not cut short", async () => {
  const { outcome, elapsed } = await capture({ inFront: true, captureMs: () => SLOW_CAPTURE_MS });
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(elapsed).toBeGreaterThanOrEqual(SLOW_CAPTURE_MS - 50);
}, 20_000);

test("a capture of a tab behind another one that Chrome leaves unanswered is asked again", async () => {
  // Chrome can hold the first capture of such a tab for a redraw it never
  // shows, and answer the next request at once.
  const { outcome, elapsed, captures, capturesLater, params } = await capture({
    inFront: false,
    captureMs: (number) => (number === 1 ? 60_000 : 30),
  });
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(elapsed).toBeGreaterThanOrEqual(1_000);
  expect(elapsed).toBeLessThan(2_000);
  expect(captures).toBe(2);
  expect(capturesLater).toBe(captures);
  // Asked again with a small request; Chrome's drawing for it answers the
  // capture, so no second full image is sent.
  expect(params[1]).toEqual(ASK_AGAIN);
  expect(params[0]).not.toEqual(ASK_AGAIN);
}, 20_000);

test("a capture Chrome loses is asked again in full once a small request answers", async () => {
  const { outcome, elapsed, captures, capturesLater, params } = await capture({
    inFront: false,
    captureMs: () => 30,
    lost: (number) => number === 1,
  });
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(elapsed).toBeGreaterThanOrEqual(2_000);
  expect(elapsed).toBeLessThan(3_000);
  expect(captures).toBe(3);
  expect(capturesLater).toBe(captures);
  expect(params[1]).toEqual(ASK_AGAIN);
  expect(params[2]).toEqual(params[0]);
}, 20_000);

test("a full-page capture of a tab behind another one is drawn by asking again", async () => {
  // Chrome holds it for a redraw it never shows; a later request has it draw
  // the tab at the page's size, which answers the capture with the whole page.
  const { outcome, elapsed, captures, capturesLater, params, methods } = await capture(
    { inFront: false, captureMs: (number) => (number === 1 ? 60_000 : 30) },
    { fullPage: true },
  );
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(elapsed).toBeGreaterThanOrEqual(1_000);
  expect(elapsed).toBeLessThan(2_500);
  expect(captures).toBe(2);
  expect(capturesLater).toBe(captures);
  expect(params[0]).toMatchObject({ captureBeyondViewport: true });
  expect(params[1]).toEqual(ASK_AGAIN);
  // The small request puts the capture's emulation back after it, so it is
  // cleared once both have answered.
  expect(methods.lastIndexOf("Emulation.clearDeviceMetricsOverride")).toBeGreaterThan(
    methods.lastIndexOf("Page.captureScreenshot"),
  );
}, 20_000);

test("a full-page capture of a tab behind another one Chrome never draws ends plainly", async () => {
  const { outcome, elapsed } = await capture(
    { inFront: false, captureMs: () => 12_000 },
    { fullPage: true },
  );
  expect(outcome).toMatchObject({ code: "timeout", retryable: true, message: STALLED });
  expect(elapsed).toBeLessThan(10_500);
}, 30_000);

test("a full-page capture of the tab in front sends one request and changes no emulation", async () => {
  const { outcome, captures, methods } = await capture(
    { inFront: true, captureMs: () => 1_500 },
    { fullPage: true },
  );
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(captures).toBe(1);
  expect(methods).not.toContain("Emulation.clearDeviceMetricsOverride");
}, 20_000);

test("a capture of a tab behind another one stops plainly after 5 s", async () => {
  const { outcome, elapsed, captures, capturesLater } = await capture({
    inFront: false,
    captureMs: () => 6_000,
  });
  expect(outcome).toMatchObject({ code: "timeout", retryable: true });
  expect((outcome as Error).message).toBe(STALLED);
  expect(elapsed).toBeGreaterThanOrEqual(4_950);
  expect(elapsed).toBeLessThan(5_500);
  // Asked once a second while none answered, and not after giving up.
  expect(captures).toBe(5);
  expect(capturesLater).toBe(captures);
}, 20_000);

test("a capture of a shown tab Chrome never draws ends at the capture deadline", async () => {
  // Such as the tab in front of a minimised or fully covered window.
  const { outcome, elapsed } = await capture({ inFront: true, captureMs: () => 14_000 });
  expect(outcome).toMatchObject({
    code: "timeout",
    retryable: true,
    message: "browser screenshot timed out during Page.captureScreenshot",
  });
  expect(elapsed).toBeLessThan(10_500);
}, 30_000);

test("asking whether the tab is shown does not hold the capture", async () => {
  const { outcome, elapsed } = await capture({ inFront: true }, { listMs: 20_000 });
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(elapsed).toBeLessThan(2_500);
}, 30_000);

test("refused captures are not asked again once the capture has given up", async () => {
  // A tab behind another one whose first capture is refused just before the
  // stall bound, and every later one at once.
  const { outcome, elapsed, captures, capturesLater } = await capture({
    inFront: false,
    captureMs: (number) => (number === 1 ? 4_900 : 0),
    refuses: () => true,
  });
  expect(outcome).toMatchObject({ retryable: true });
  expect(elapsed).toBeLessThan(5_300);
  expect(capturesLater).toBe(captures);
}, 20_000);

test("a capture Chrome refuses for an undrawn tab is asked again", async () => {
  const { outcome, captures } = await capture({
    inFront: true,
    refuses: (number) => number <= 2,
  });
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(captures).toBe(3);
});

test("a capture Chrome refuses while the tab loads works once it is drawn", async () => {
  // Such as a tab restored at launch, which Chrome draws about 2 s later.
  let first: number | undefined;
  const { outcome, elapsed, captures } = await capture({
    inFront: true,
    refuses: () => performance.now() - (first ??= performance.now()) < 2_000,
  });
  expect(outcome).toMatchObject({ targetId: "7", width: 1, height: 1 });
  expect(elapsed).toBeGreaterThanOrEqual(1_950);
  expect(elapsed).toBeLessThan(2_500);
  // Pauses grow to 200 ms, so a long refusal is not asked about every 25 ms.
  expect(captures).toBeLessThan(16);
}, 20_000);

test("a capture Chrome keeps refusing fails with a plain reason at the deadline", async () => {
  const { outcome, elapsed, captures, capturesLater } = await capture({
    inFront: true,
    refuses: () => true,
  });
  expect(outcome).toMatchObject({
    code: "resource_unavailable",
    retryable: true,
    message:
      "browser screenshot unavailable: Chrome has not drawn this tab, which happens while it is hidden or still loading; try again in a moment, or read it with browser_observe.",
  });
  expect(elapsed).toBeGreaterThan(9_500);
  expect(elapsed).toBeLessThan(10_500);
  expect(captures).toBeGreaterThan(4);
  expect(capturesLater).toBe(captures);
}, 30_000);
