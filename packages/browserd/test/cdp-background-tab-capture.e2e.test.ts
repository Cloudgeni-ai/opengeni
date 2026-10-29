import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpCommandTimeoutError, CdpConnection } from "../src/cdp";
import type { BrowserCdpConnection } from "../src/cdp-driver";
import { managedChromeArguments } from "../src/runner";

const e2e =
  process.env.OPENGENI_BROWSERD_E2E === "1" || process.env.OPENGENI_BROWSERD_HEADED_E2E === "1"
    ? test
    : test.skip;
const headed = process.env.OPENGENI_BROWSERD_HEADED_E2E === "1";
const FEATURE = "--enable-features=CDPScreenshotNewSurface";
// Commands that would raise a tab or take the window's foreground seat.
const FOREGROUNDING = new Set(["Page.bringToFront", "Target.activateTarget"]);

// A static page: nothing on it animates, so Chromium produces no frame of its
// own that could release a capture waiting for a redraw to be shown.
function server() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const label = new URL(request.url).pathname.slice(1);
      return new Response(
        `<!doctype html><title>${label}</title><style>body{margin:0;font:16px sans-serif}main{height:2400px;padding:20px}</style><main><h1>${label}</h1><p>Static page.</p></main>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
}

type SendOptions = { sessionId?: string; timeoutMs?: number; signal?: AbortSignal };

/** Records every command. `shown` answers which tab is in front of its window,
 * as a person's Chrome tells its extension; `slowCaptureMs` makes each
 * screenshot reply take that long, as an explicit PNG of a large, detailed
 * page can. */
function recording(
  connection: CdpConnection,
  methods: string[],
  fixture: { shown?: () => string | null; slowCaptureMs?: number } = {},
): BrowserCdpConnection {
  const slowCaptureMs = fixture.slowCaptureMs ?? 0;
  return {
    send: async <T = Record<string, unknown>>(
      method: string,
      params?: Readonly<Record<string, unknown>>,
      options?: SendOptions,
    ) => {
      methods.push(method);
      if (method !== "Page.captureScreenshot" || slowCaptureMs === 0) {
        return await connection.send<T>(method, params, options);
      }
      const started = performance.now();
      const { timeoutMs, ...rest } = options ?? {};
      const reply = await connection.send<T>(method, params, rest);
      const late = slowCaptureMs - (performance.now() - started);
      if (timeoutMs !== undefined && timeoutMs < slowCaptureMs) {
        await Bun.sleep(Math.max(0, timeoutMs - (performance.now() - started)));
        throw new CdpCommandTimeoutError(method, options?.sessionId ?? "browser");
      }
      await Bun.sleep(Math.max(0, late));
      return reply;
    },
    on: connection.on.bind(connection),
    onDisconnect: connection.onDisconnect.bind(connection),
    close: connection.close.bind(connection),
    waitForEvent: connection.waitForEvent.bind(connection),
    ...(fixture.shown
      ? { tabShown: async (targetId: string) => targetId === fixture.shown?.() }
      : {}),
  };
}

e2e(
  "captures a managed background tab promptly without bringing it to front",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-background-capture-");
    const pages = server();
    const methods: string[] = [];
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
      // As every managed session: agent tabs open in the background and stay
      // rendering through focus emulation.
      focusEmulation: true,
      connect: async (endpoint) => recording(await CdpConnection.connect(endpoint), methods),
    });
    try {
      await driver.start(`${pages.url.origin}/front`);
      const background = await driver.openTarget(`${pages.url.origin}/background`);
      const captured = methods.length;
      const times: number[] = [];
      for (let round = 0; round < 6; round += 1) {
        for (const fullPage of [false, true]) {
          const started = performance.now();
          const frame = await driver.captureScreenshot(background.target.id, { fullPage });
          times.push(Math.round(performance.now() - started));
          expect(frame.targetId).toBe(background.target.id);
          expect(frame.height).toBeGreaterThan(fullPage ? 2_400 : 300);
        }
      }
      console.log(`background captures (ms): ${times.join(" ")}`);
      // Before, about half of these waited out the 10 s capture deadline.
      expect(Math.max(...times)).toBeLessThan(3_000);
      expect(methods.slice(captured).filter((method) => FOREGROUNDING.has(method))).toEqual([]);
    } finally {
      await driver.close();
      pages.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

/**
 * Runs `check` against a person's own Chrome: started without the managed
 * launch switch and reached over its DevTools port. The browser is shut down
 * and its profile removed afterwards.
 */
async function withConnectedChrome(
  check: (input: {
    driver: AgentBrowserDriver;
    origin: string;
    methods: string[];
    /** Records which tab the person has in front. */
    show: (targetId: string) => void;
  }) => Promise<void>,
  options: { slowCaptureMs?: number } = {},
): Promise<void> {
  const directory = await mkdtemp("/tmp/ogb-connected-capture-");
  const pages = server();
  const profileDirectory = join(directory, "profile");
  const executable = process.env.OPENGENI_BROWSER_EXECUTABLE ?? "chromium";
  const argumentsList = managedChromeArguments({
    platform: process.platform,
    windowed: headed,
    profileDirectory,
    proxyServer: null,
  }).filter((argument) => argument !== FEATURE);
  expect(argumentsList).not.toContain(FEATURE);
  const browser = spawn(executable, [...argumentsList, "about:blank"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => browser.once("exit", () => resolve()));
  const methods: string[] = [];
  let shown: string | null = null;
  let driver: AgentBrowserDriver | null = null;
  let endpoint = "";
  try {
    for (let attempt = 0; attempt < 150 && !endpoint; attempt += 1) {
      const active = await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8").catch(
        () => "",
      );
      const [port, path] = active.trim().split("\n");
      if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
      else await Bun.sleep(100);
    }
    expect(endpoint).not.toBe("");
    driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      engine: "chrome",
      focusEmulation: true,
      runner: {
        async run<T>() {
          return { cdpUrl: endpoint } as T;
        },
      },
      connect: async (url) =>
        recording(await CdpConnection.connect(url), methods, {
          shown: () => shown,
          ...(options.slowCaptureMs ? { slowCaptureMs: options.slowCaptureMs } : {}),
        }),
    });
    await check({
      driver,
      origin: pages.url.origin,
      methods,
      show: (targetId) => {
        shown = targetId;
      },
    });
  } finally {
    await driver?.close().catch(() => undefined);
    // Chrome's helper processes keep writing to the profile until they exit:
    // close Chrome as a person would, and wait until it has gone.
    const exitedOnce =
      browser.exitCode === null && browser.signalCode === null ? exited : Promise.resolve();
    if (endpoint) {
      const control = await CdpConnection.connect(endpoint).catch(() => null);
      await control?.send("Browser.close").catch(() => undefined);
      control?.close();
    }
    const kill = setTimeout(() => browser.kill("SIGKILL"), 5_000);
    await exitedOnce;
    clearTimeout(kill);
    pages.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  }
}

// A person's own Chrome runs without the managed launch switch. Its captures of
// a tab behind another one work; one that rarely still stalls stops with a
// plain reason, and the capture asked for again works.
e2e(
  "a connected Chrome capture of a background tab completes",
  async () => {
    await withConnectedChrome(async ({ driver, origin, methods, show }) => {
      show((await driver.start(`${origin}/front`)).target.id);
      const background = await driver.openTarget(`${origin}/background`);
      const captured = methods.length;
      const outcomes: string[] = [];
      for (let round = 0; round < 8; round += 1) {
        for (const attempt of ["first", "again"]) {
          const started = performance.now();
          let outcome = "ok";
          try {
            const frame = await driver.captureScreenshot(background.target.id);
            expect(frame.targetId).toBe(background.target.id);
          } catch (error) {
            expect((error as Error).message).toStartWith(
              "browser screenshot stalled: Chrome did not draw this tab,",
            );
            expect(error).toMatchObject({ code: "timeout", retryable: true });
            outcome = "stalled";
          }
          const elapsed = Math.round(performance.now() - started);
          outcomes.push(`${attempt}:${outcome}:${elapsed}`);
          // Before, a stalled capture waited out the 10 s capture deadline.
          expect(elapsed).toBeLessThan(6_000);
          if (outcome === "ok") break;
          // A capture asked for again after a stall works.
          expect(attempt).toBe("first");
        }
        // Let the tab go undrawn again before the next round.
        await Bun.sleep(1_500);
      }
      console.log(`connected Chrome background captures: ${outcomes.join(" ")}`);
      // Stalls are rare: before, one capture of each round could stall.
      expect(outcomes.filter((outcome) => outcome.includes(":stalled:")).length).toBeLessThan(2);
      expect(methods.slice(captured).filter((method) => FOREGROUNDING.has(method))).toEqual([]);
    });
  },
  180_000,
);

e2e(
  "a slow connected Chrome capture of the tab in front is not cut short",
  async () => {
    await withConnectedChrome(
      async ({ driver, origin, show }) => {
        const front = await driver.start(`${origin}/front`);
        show(front.target.id);
        const started = performance.now();
        const frame = await driver.captureScreenshot(front.target.id, { format: "png" });
        expect(frame.targetId).toBe(front.target.id);
        // Before, the 3 s bound for unshown tabs cut it off as "stalled".
        expect(performance.now() - started).toBeGreaterThan(3_500);
      },
      { slowCaptureMs: 3_600 },
    );
  },
  120_000,
);

// Headed Chromium refuses the first capture of a background tab it has not
// drawn yet when the tab is not kept rendering by focus emulation.
e2e(
  "the first capture of a background tab Chrome has not drawn yet works",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-background-capture-");
    const pages = server();
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
      focusEmulation: false,
    });
    try {
      await driver.start(`${pages.url.origin}/front`);
      const background = await driver.openTarget(`${pages.url.origin}/background`);
      const frame = await driver.captureScreenshot(background.target.id);
      expect(frame.targetId).toBe(background.target.id);
    } finally {
      await driver.close();
      pages.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
