import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";
import { CdpConnection } from "../src/cdp";
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

function recording(connection: CdpConnection, methods: string[]): BrowserCdpConnection {
  return {
    send: async <T = Record<string, unknown>>(
      method: string,
      params?: Readonly<Record<string, unknown>>,
      options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal },
    ) => {
      methods.push(method);
      return await connection.send<T>(method, params, options);
    },
    on: connection.on.bind(connection),
    onDisconnect: connection.onDisconnect.bind(connection),
    close: connection.close.bind(connection),
    waitForEvent: connection.waitForEvent.bind(connection),
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

// A person's own Chrome runs without the managed launch switch. Its captures of
// a tab behind another one either work or stop at once with a plain reason.
e2e(
  "a connected Chrome capture of a background tab completes or stops plainly",
  async () => {
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
    const methods: string[] = [];
    let driver: AgentBrowserDriver | null = null;
    try {
      let endpoint = "";
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
        connect: async (url) => recording(await CdpConnection.connect(url), methods),
      });
      await driver.start(`${pages.url.origin}/front`);
      const background = await driver.openTarget(`${pages.url.origin}/background`);
      const captured = methods.length;
      const outcomes: string[] = [];
      for (let round = 0; round < 8; round += 1) {
        const started = performance.now();
        let outcome = "ok";
        try {
          await driver.captureScreenshot(background.target.id);
        } catch (error) {
          expect((error as Error).message).toStartWith(
            "browser screenshot stalled: Chrome did not draw this tab within 3 s",
          );
          expect(error).toMatchObject({ code: "timeout", retryable: true });
          outcome = "stalled";
        }
        const elapsed = Math.round(performance.now() - started);
        outcomes.push(`${outcome}:${elapsed}`);
        // Before, a stalled capture waited out the 10 s capture deadline.
        expect(elapsed).toBeLessThan(5_000);
      }
      console.log(`connected Chrome background captures: ${outcomes.join(" ")}`);
      expect(methods.slice(captured).filter((method) => FOREGROUNDING.has(method))).toEqual([]);
    } finally {
      await driver?.close().catch(() => undefined);
      browser.kill("SIGKILL");
      pages.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

// A relaunched managed browser restores its tabs, and for a moment after it
// starts Chromium refuses to capture a restored tab that has not drawn yet
// ("Unable to capture screenshot"). A capture in that moment waits for the
// tab to draw instead of failing.
e2e(
  "captures tabs a relaunched browser has just restored",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-restored-capture-");
    const pages = server();
    const profileDirectory = join(directory, "profile");
    const executable = process.env.OPENGENI_BROWSER_EXECUTABLE ?? "chromium";
    const argumentsList = managedChromeArguments({
      platform: process.platform,
      windowed: headed,
      profileDirectory,
      proxyServer: null,
    });
    expect(argumentsList).toContain("--restore-last-session");
    const launch = async (urls: string[]) => {
      await rm(join(profileDirectory, "DevToolsActivePort"), { force: true });
      const browser = spawn(executable, [...argumentsList, ...urls], { stdio: "ignore" });
      const exited = new Promise((resolve) => browser.once("exit", resolve));
      let endpoint = "";
      for (let attempt = 0; attempt < 1_500 && !endpoint; attempt += 1) {
        const active = await readFile(join(profileDirectory, "DevToolsActivePort"), "utf8").catch(
          () => "",
        );
        const [port, path] = active.trim().split("\n");
        if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`;
        else await Bun.sleep(10);
      }
      expect(endpoint).not.toBe("");
      return { browser, exited, endpoint };
    };
    const stop = async (running: Awaited<ReturnType<typeof launch>>) => {
      // A clean shutdown, as an idle release does, so the next launch restores the tabs.
      const connection = await CdpConnection.connect(running.endpoint);
      await connection.send("Browser.close").catch(() => undefined);
      connection.close();
      await running.exited;
    };
    let running = await launch([`${pages.url.origin}/front`]);
    try {
      const opener = await CdpConnection.connect(running.endpoint);
      for (const label of ["second", "third"]) {
        await opener.send("Target.createTarget", {
          url: `${pages.url.origin}/${label}`,
          background: true,
        });
      }
      await Bun.sleep(1_000);
      opener.close();
      await stop(running);
      let captures = 0;
      for (let round = 0; round < 5; round += 1) {
        running = await launch([]);
        const endpoint = running.endpoint;
        const driver = new AgentBrowserDriver({
          browserSessionId: randomUUID(),
          controllerGeneration: `controller-${randomUUID()}`,
          focusEmulation: true,
          runner: {
            async run<T>(args: readonly string[]) {
              return (args[0] === "get" ? { cdpUrl: endpoint } : {}) as T;
            },
          },
        });
        try {
          const tabs = await driver.listTargets();
          expect(tabs.map((tab) => new URL(tab.url).pathname).sort()).toEqual([
            "/front",
            "/second",
            "/third",
          ]);
          // As the supervisor does after a relaunch: the reopened tabs are
          // known as restored, so one Chrome has not started loading yet is
          // loaded on first use instead of reported as crashed.
          driver.noteRelaunchedTabs({
            reason: "idle_release",
            tabs: [],
            restoredTargetIds: tabs.map((tab) => tab.id),
          });
          // Before, a capture in the first moments failed about every other relaunch.
          const frames = await Promise.all(
            tabs.map(async (tab) => await driver.captureScreenshot(tab.id)),
          );
          for (const frame of frames) expect(frame.width).toBeGreaterThan(100);
          captures += frames.length;
        } finally {
          await driver.close().catch(() => undefined);
          await stop(running);
        }
      }
      expect(captures).toBe(15);
    } finally {
      running.browser.kill("SIGKILL");
      pages.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
