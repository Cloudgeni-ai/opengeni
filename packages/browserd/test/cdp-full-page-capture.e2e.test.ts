import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import type { BrowserActionCommand, BrowserObservation } from "@opengeni/contracts";
import { AgentBrowserDriver, CdpConnection, ManagedBrowserRunner } from "../src";
import { CdpCommandTimeoutError } from "../src/cdp";

const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";
const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" || headed ? test : test.skip;
// Headed Chromium under a virtual display can size a 390 px emulated viewport
// one pixel wider, in the tab's report or in its image, so widths are checked
// within a CSS pixel (at the given scale).
const near = (width: number | undefined, expected: number, scale = 1) =>
  expect(Math.abs((width ?? 0) - expected * scale)).toBeLessThanOrEqual(scale);
const near390 = (width: number | undefined) => near(width, 390);

/** Decodes an 8-bit RGB or RGBA PNG, as Chromium writes them. */
function pngPixels(data: Uint8Array): { width: number; channels: number; pixels: Uint8Array } {
  const buffer = Buffer.from(data);
  const chunks: Buffer[] = [];
  let width = 0;
  let height = 0;
  let channels = 4;
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = body[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") chunks.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? pixels[at - channels]! : 0;
      const up = y > 0 ? pixels[at - stride]! : 0;
      const corner = x >= channels && y > 0 ? pixels[at - stride - channels]! : 0;
      const guess = left + up - corner;
      const nearest =
        Math.abs(guess - left) <= Math.abs(guess - up) &&
        Math.abs(guess - left) <= Math.abs(guess - corner)
          ? left
          : Math.abs(guess - up) <= Math.abs(guess - corner)
            ? up
            : corner;
      const predicted = [0, left, up, (left + up) >> 1, nearest][filter!] ?? 0;
      pixels[at] = (raw[y * (stride + 1) + 1 + x]! + predicted) & 255;
    }
  }
  return { width, channels, pixels };
}

/**
 * How many pixels two same-size PNGs differ in. Headed Chromium can draw an
 * edge's antialiasing differently after it re-rasters a tile; a missing
 * scrollbar differs in hundreds of pixels.
 */
function differingPixels(a: Uint8Array, b: Uint8Array): number {
  const first = pngPixels(a);
  const second = pngPixels(b);
  expect(second.pixels.length).toBe(first.pixels.length);
  let count = 0;
  for (let at = 0; at < first.pixels.length; at += first.channels) {
    if (
      first.pixels[at] !== second.pixels[at] ||
      first.pixels[at + 1] !== second.pixels[at + 1] ||
      first.pixels[at + 2] !== second.pixels[at + 2]
    )
      count += 1;
  }
  return count;
}

/**
 * A settings page taller than a phone viewport, with a right-aligned button
 * and scrolling panes. `read()` reports the layout; every size change any
 * observed element goes through is logged, so a capture that lays the page
 * out differently, even briefly, shows up.
 */
function page(panes: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Account</title><style>
body{margin:0;font:14px sans-serif}
header{display:flex;align-items:center;padding:8px 16px;background:#eef}
header h1{font-size:16px;margin:0}
header button{margin-left:auto}
.pane{height:120px;overflow:auto;margin:16px;border:1px solid #999}
.custom::-webkit-scrollbar{width:6px}
.custom::-webkit-scrollbar-thumb{background:#888}
</style></head><body>
<header><h1>Account</h1><button id="save">Save</button></header>
${panes}
<div id="host"></div>
<div style="height:2400px;background:linear-gradient(#fff,#36c)"></div>
<footer>End</footer>
<script>
const watched = [document.documentElement, document.getElementById("save"), ...document.querySelectorAll(".pane")];
window.read = () => JSON.stringify({
  root: document.documentElement.clientWidth,
  save: document.getElementById("save").getBoundingClientRect().right,
  panes: [...document.querySelectorAll(".pane")].map((pane) => pane.clientWidth + "x" + pane.clientHeight),
  shadow: document.getElementById("host").shadowRoot?.firstElementChild.clientWidth ?? null,
});
window.changes = [];
const observer = new ResizeObserver(() => window.changes.push(read()));
for (const element of watched) observer.observe(element);
</script></body></html>`;
}

const VERTICAL_PANES =
  '<div class="pane"><div style="height:600px">Notes</div></div>' +
  '<div class="pane" style="scrollbar-width:thin"><div style="height:600px">History</div></div>' +
  '<div class="pane custom"><div style="height:600px">Log</div></div>';

async function withPage(
  html: string,
  viewport: { deviceScaleFactor: number },
  check: (input: {
    driver: AgentBrowserDriver;
    observation: BrowserObservation;
    evaluate: (expression: string) => Promise<unknown>;
    methods: string[];
  }) => Promise<void>,
  options: {
    /** Commands the page runs but whose reply arrives too late, as on a page
     * busy when the command lands. */
    late?: (method: string, params: Readonly<Record<string, unknown>>) => boolean;
    /** Runs after each command the driver sends, with that command's session. */
    after?: (
      method: string,
      params: Readonly<Record<string, unknown>>,
      send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
    ) => void;
  } = {},
): Promise<void> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }),
  });
  const directory = await mkdtemp("/tmp/ogb-full-page-");
  const browserSessionId = randomUUID();
  const controllerGeneration = `controller-${randomUUID()}`;
  const runner = await ManagedBrowserRunner.create({
    profileDirectory: join(directory, "profile"),
    headed,
    ...(process.env.OPENGENI_BROWSER_EXECUTABLE
      ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
      : {}),
  });
  const methods: string[] = [];
  const driver = new AgentBrowserDriver({
    browserSessionId,
    controllerGeneration,
    runner,
    connect: async (url) => {
      const connection = await CdpConnection.connect(url);
      return {
        send: async <T = Record<string, unknown>>(
          method: string,
          params: Readonly<Record<string, unknown>> = {},
          sendOptions?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
        ) => {
          methods.push(method);
          const reply = await connection.send<T>(method, params, sendOptions);
          options.after?.(
            method,
            params,
            async (next, nextParams = {}) =>
              await connection.send(
                next,
                nextParams,
                sendOptions?.sessionId ? { sessionId: sendOptions.sessionId } : {},
              ),
          );
          if (options.late?.(method, params)) {
            throw new CdpCommandTimeoutError(method, sendOptions?.sessionId ?? "browser");
          }
          return reply;
        },
        on: connection.on.bind(connection),
        onDisconnect: connection.onDisconnect.bind(connection),
        close: connection.close.bind(connection),
        waitForEvent: connection.waitForEvent.bind(connection),
      };
    },
  });
  let cdp: CdpConnection | null = null;
  try {
    const opened = await driver.start(`http://127.0.0.1:${server.port}/`);
    const command: BrowserActionCommand = {
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId,
      controllerGeneration,
      targetId: opened.target.id,
      expectedTargetGeneration: opened.target.targetGeneration,
      expectedDocumentGeneration: opened.target.documentGeneration!,
      expectedFrameId: opened.frameId!,
      actor: { kind: "human", subjectId: "full-page-fixture" },
      action: {
        type: "viewport",
        width: 390,
        height: 844,
        deviceScaleFactor: viewport.deviceScaleFactor,
        mobile: false,
      },
    };
    await driver.dispatch(command);
    const observation = await driver.observe(opened.target.id);
    // The page's own view of its layout, read over a separate connection.
    const endpoint = await runner.run<{ cdpUrl: string }>(["get", "cdp-url"]);
    cdp = await CdpConnection.connect(endpoint.cdpUrl);
    const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: opened.target.id,
      flatten: true,
    });
    const connection = cdp;
    const evaluate = async (expression: string) =>
      (
        await connection.send<{ result: { value?: unknown } }>(
          "Runtime.evaluate",
          { expression, returnByValue: true },
          { sessionId },
        )
      ).result.value;
    await check({ driver, observation, evaluate, methods });
  } finally {
    await cdp?.close();
    await driver.close().catch(() => undefined);
    server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}

e2e(
  "a full-page capture keeps the page's layout and is as wide as the tab's viewport",
  async () => {
    await withPage(page(VERTICAL_PANES), { deviceScaleFactor: 1 }, async (input) => {
      const { driver, observation, evaluate } = input;
      near390(observation.viewport?.width);
      const viewportWidth = observation.viewport!.width;
      await evaluate("scrollTo(0, 300)");
      const before = JSON.parse((await evaluate("read()")) as string);
      // A classic scrollbar takes part of the 390 px viewport.
      expect(before.root).toBeLessThan(viewportWidth);
      await evaluate("window.changes.length = 0");

      const viewportFrame = await driver.captureScreenshot(observation.target.id, {
        format: "png",
      });
      near(viewportFrame.width, viewportWidth);
      expect(viewportFrame.deviceScaleFactor).toBe(1);

      const frame = await driver.captureScreenshot(observation.target.id, {
        fullPage: true,
        format: "png",
      });
      near(frame.width, viewportWidth);
      expect(frame.height).toBeGreaterThan(2400);
      expect(frame.deviceScaleFactor).toBe(1);
      expect(frame.inexactScrollbars).toBeUndefined();

      await Bun.sleep(300);
      // Nothing changed size while the page was captured, and its layout
      // is the same afterwards. Headed Chromium briefly sizes the view to
      // 1×1 inside the capture (its own workaround, not something the image
      // shows or the page can keep), so only real widths count.
      expect(
        await evaluate("window.changes.filter((value) => JSON.parse(value).root > 1)"),
      ).toEqual([]);
      expect(JSON.parse((await evaluate("read()")) as string)).toEqual(before);
      // Every scrollbar is drawn again: the viewport looks as it did.
      const again = await driver.captureScreenshot(observation.target.id, { format: "png" });
      expect(differingPixels(again.data, viewportFrame.data)).toBeLessThanOrEqual(4);
      // Page scripts see no stylesheet of ours.
      expect(await evaluate("document.styleSheets.length")).toBe(1);
    });
  },
  120_000,
);

e2e(
  "a full-page capture that cannot keep every scrollbar says so and restores them all",
  async () => {
    const panes =
      VERTICAL_PANES +
      '<div class="pane" style="height:auto"><div style="width:900px;height:40px">Wide table</div></div>';
    const html = page(panes).replace(
      "<script>",
      '<script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML=\'<div style="height:120px;overflow:auto;margin:16px"><div style="height:600px">Inside</div></div>\';',
    );
    await withPage(html, { deviceScaleFactor: 1 }, async ({ driver, observation, evaluate }) => {
      const before = JSON.parse((await evaluate("read()")) as string);
      const frame = await driver.captureScreenshot(observation.target.id, {
        fullPage: true,
        format: "png",
      });
      near(frame.width, observation.viewport!.width);
      expect(frame.inexactScrollbars).toBe(true);
      await Bun.sleep(300);
      expect(JSON.parse((await evaluate("read()")) as string)).toEqual(before);
    });
  },
  120_000,
);

e2e(
  "screenshot scale is the viewport's device scale factor",
  async () => {
    await withPage(
      page(VERTICAL_PANES),
      { deviceScaleFactor: 2 },
      async ({ driver, observation }) => {
        const viewportFrame = await driver.captureScreenshot(observation.target.id, {
          format: "png",
        });
        near(viewportFrame.width, observation.viewport!.width, 2);
        expect(viewportFrame.deviceScaleFactor).toBe(2);
        const frame = await driver.captureScreenshot(observation.target.id, {
          fullPage: true,
          format: "png",
        });
        near(frame.width, observation.viewport!.width, 2);
        expect(frame.deviceScaleFactor).toBe(2);
      },
    );
  },
  120_000,
);

const INEXACT_PANES =
  VERTICAL_PANES +
  '<div class="pane" id="wide" style="height:auto"><div style="width:900px;height:40px">Wide table</div></div>';

e2e(
  "a full-page capture leaves no style behind when restoring its scrollbars stalls",
  async () => {
    const scrollbarColor = "getComputedStyle(document.getElementById('wide')).scrollbarColor";
    await withPage(
      page(INEXACT_PANES),
      { deviceScaleFactor: 1 },
      async ({ driver, observation, evaluate }) => {
        const before = await evaluate(scrollbarColor);
        const frame = await driver.captureScreenshot(observation.target.id, {
          fullPage: true,
          format: "png",
        });
        expect(frame.inexactScrollbars).toBe(true);
        await Bun.sleep(300);
        // The temporary scrollbar-color rule is gone although its step stalled.
        expect(await evaluate(scrollbarColor)).toBe(before);
      },
      {
        late: (method, params) =>
          method === "CSS.setStyleSheetText" && String(params.text).includes("scrollbar-color"),
      },
    );
  },
  120_000,
);

e2e(
  "a dialog that cuts a full-page capture short leaves no style behind",
  async () => {
    const gutter = "getComputedStyle(document.documentElement).scrollbarGutter";
    let answer: (() => Promise<unknown>) | null = null;
    await withPage(
      page(VERTICAL_PANES),
      { deviceScaleFactor: 1 },
      async ({ driver, observation, evaluate }) => {
        expect(await evaluate(gutter)).toBe("auto");
        await expect(
          driver.captureScreenshot(observation.target.id, { fullPage: true, format: "png" }),
        ).rejects.toThrow(/dialog/);
        expect(answer).not.toBeNull();
        await answer!();
        // The capture's own restore applies once the page can answer again.
        const until = Date.now() + 15_000;
        while ((await evaluate(gutter)) !== "auto" && Date.now() < until) await Bun.sleep(100);
        expect(await evaluate(gutter)).toBe("auto");
      },
      {
        // The page opens an alert just as the gutters are pinned.
        after: (method, params, send) => {
          if (method !== "CSS.setStyleSheetText" || !String(params.text).includes("gutter")) return;
          if (answer) return;
          answer = async () => await send("Page.handleJavaScriptDialog", { accept: true });
          void send("Runtime.evaluate", { expression: "alert('Saved')" }).catch(() => undefined);
        },
      },
    );
  },
  120_000,
);

for (const gutter of ["stable", "stable both-edges"]) {
  e2e(
    `a full-page capture keeps a page's own ${gutter} gutters and custom scrollbars`,
    async () => {
      // Every pane keeps its own gutter; one draws a 6 px custom scrollbar.
      const html = page(VERTICAL_PANES).replace(
        ".pane{",
        `:root{scrollbar-gutter:${gutter}}.pane{scrollbar-gutter:${gutter};`,
      );
      await withPage(html, { deviceScaleFactor: 1 }, async ({ driver, observation, evaluate }) => {
        const before = JSON.parse((await evaluate("read()")) as string);
        const shown = await driver.captureScreenshot(observation.target.id, { format: "png" });
        await evaluate("window.changes.length = 0");
        const frame = await driver.captureScreenshot(observation.target.id, {
          fullPage: true,
          format: "png",
        });
        expect(frame.inexactScrollbars).toBeUndefined();
        await Bun.sleep(300);
        // No size change while captured (Chromium's own 1×1 step aside)...
        expect(
          await evaluate("window.changes.filter((value) => JSON.parse(value).root > 1)"),
        ).toEqual([]);
        expect(JSON.parse((await evaluate("read()")) as string)).toEqual(before);
        // ...and every scrollbar, the custom one included, is drawn again.
        const after = await driver.captureScreenshot(observation.target.id, { format: "png" });
        expect(differingPixels(after.data, shown.data)).toBeLessThanOrEqual(4);
      });
    },
    120_000,
  );
}

e2e(
  "a page too tall to capture whole fails before any style changes",
  async () => {
    const html = page(VERTICAL_PANES).replace("height:2400px", "height:40000px");
    await withPage(html, { deviceScaleFactor: 1 }, async ({ driver, observation, methods }) => {
      const sent = methods.length;
      await expect(
        driver.captureScreenshot(observation.target.id, { fullPage: true, format: "png" }),
      ).rejects.toThrow("browser image dimensions exceed their bounded envelope");
      expect(methods.slice(sent).filter((method) => method.startsWith("CSS."))).toEqual([]);
    });
  },
  120_000,
);
