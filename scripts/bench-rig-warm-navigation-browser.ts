#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { chromium } from "playwright";

const state = JSON.parse(readFileSync("/tmp/rig-ui-stack.json", "utf8")) as {
  apiPort: number;
  webPort: number;
  workspaceId: string;
};
const apiBase = process.env.RIG_UI_API_ORIGIN ?? `http://127.0.0.1:${state.apiPort}`;
const webOrigin = process.env.RIG_UI_WEB_ORIGIN ?? `http://127.0.0.1:${state.webPort}`;
const workspaceId = process.env.RIG_UI_WORKSPACE_ID ?? state.workspaceId;
const rigsUrl = `${apiBase}/v1/workspaces/${workspaceId}/rigs?view=summary`;
const sessionsUrl = `${webOrigin}/workspaces/${workspaceId}/sessions`;
const expected = (await (await fetch(rigsUrl)).json()) as Array<{ id: string; name: string }>;
const samples = numberEnv("RIG_UI_SAMPLES", 5);
const cpuThrottleRate = 4;
const rigCounts = parseRigCounts(process.env.RIG_UI_COUNTS, expected.length);
const cpuProfilePrefix = process.env.RIG_UI_CPU_PROFILE_PREFIX;
const networkRttMs = numberEnv("RIG_UI_NETWORK_RTT_MS", 0);
const networkDownlinkMbps = numberEnv("RIG_UI_NETWORK_DOWNLINK_MBPS", 0);

const nixChromium = spawnSync("nix", ["eval", "--raw", "nixpkgs#chromium.outPath"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const executablePath =
  nixChromium.status === 0 && nixChromium.stdout.trim()
    ? `${nixChromium.stdout.trim()}/bin/chromium`
    : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

const receipts = [];
try {
  for (const rigCount of rigCounts) {
    const rigs = expected.slice(0, rigCount);
    const body = JSON.stringify(rigs);
    for (let sample = 1; sample <= samples; sample += 1) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const activeRequests = new Map<
        import("playwright").Request,
        { method: string; url: string }
      >();
      page.on("request", (request) => {
        activeRequests.set(request, { method: request.method(), url: request.url() });
      });
      const removeActiveRequest = (request: import("playwright").Request) => {
        activeRequests.delete(request);
      };
      page.on("requestfinished", removeActiveRequest);
      page.on("requestfailed", removeActiveRequest);
      if (rigCount !== expected.length) {
        await page.route(rigsUrl, async (route) => {
          await route.fulfill({ status: 200, contentType: "application/json", body });
        });
      }
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
      await page.goto(sessionsUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForRigOptions(
        page,
        rigs.map((rig) => rig.name),
      );
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      if (process.env.RIG_UI_SETTLED_PRENAV === "1") {
        const deadline = performance.now() + 5_000;
        while (
          [...activeRequests.values()].some(
            (request) => !request.url.includes("/live-events/stream"),
          )
        ) {
          if (performance.now() >= deadline) {
            throw new Error("initial non-stream requests did not settle before navigation");
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }

      if (networkDownlinkMbps > 0 || networkRttMs > 0) {
        const throughputBytesPerSecond =
          networkDownlinkMbps > 0 ? (networkDownlinkMbps * 1_000_000) / 8 : -1;
        await cdp.send("Network.enable");
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: networkRttMs,
          downloadThroughput: throughputBytesPerSecond,
          uploadThroughput: throughputBytesPerSecond,
          connectionType: "cellular3g",
        });
      }

      const responseTimings: Array<{ startedMs: number; finishedMs: number }> = [];
      const rigTransportRequests: Array<{ method: string; startedMs: number }> = [];
      const pendingResponseTimings = new WeakMap<
        import("playwright").Request,
        { startedMs: number; finishedMs: number }
      >();
      let navigationStarted = 0;
      page.on("request", (request) => {
        if (request.url() === rigsUrl && navigationStarted > 0) {
          rigTransportRequests.push({
            method: request.method(),
            startedMs: performance.now() - navigationStarted,
          });
        }
        if (request.method() === "GET" && request.url() === rigsUrl && navigationStarted > 0) {
          const timing = { startedMs: performance.now() - navigationStarted, finishedMs: 0 };
          responseTimings.push(timing);
          pendingResponseTimings.set(request, timing);
        }
      });
      page.on("requestfinished", (request) => {
        if (request.method() === "GET" && request.url() === rigsUrl && navigationStarted > 0) {
          const timing = pendingResponseTimings.get(request);
          if (timing) timing.finishedMs = performance.now() - navigationStarted;
        }
      });

      const preNavigationInFlight = [...activeRequests.values()];
      navigationStarted = performance.now();
      if (cpuProfilePrefix) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.start");
      }
      await page.evaluate((targetWorkspaceId) => {
        history.pushState({}, "", `/workspaces/${targetWorkspaceId}/rigs`);
        dispatchEvent(new PopStateEvent("popstate"));
      }, workspaceId);
      await page.waitForFunction(
        ({ expectedWorkspaceId, count }) =>
          Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).filter((anchor) =>
            new URL(anchor.href).pathname.startsWith(`/workspaces/${expectedWorkspaceId}/rigs/`),
          ).length === count,
        { expectedWorkspaceId: workspaceId, count: rigs.length },
        { timeout: 30_000 },
      );
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await page.evaluate(() => new Promise(requestAnimationFrame));
      if (cpuProfilePrefix) {
        const { profile } = await cdp.send("Profiler.stop");
        await writeFile(
          `${cpuProfilePrefix}-${rigCount}-${sample}.cpuprofile`,
          JSON.stringify(profile),
        );
        await cdp.send("Profiler.disable");
      }
      receipts.push({
        rigCount,
        sample,
        usableMs: performance.now() - navigationStarted,
        responseStartedMs: responseTimings[0]?.startedMs ?? 0,
        responseFinishedMs: responseTimings[0]?.finishedMs ?? 0,
        rigRequestCount: responseTimings.length,
        rigRequestTimings: responseTimings,
        rigTransportRequests,
        preNavigationInFlight,
        renderedRigCount: await page.locator(`a[href^="/workspaces/${workspaceId}/rigs/"]`).count(),
      });
      await cdp.detach();
      await context.close();
    }
  }
} finally {
  await browser.close();
}

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      surface: "warm SPA navigation from sessions to rigs after the app shell and rig picker load",
      viewport: { width: 390, height: 844, mobile: true, touch: true },
      cpuThrottleRate,
      network: {
        rttMs: networkRttMs,
        downlinkMbps: networkDownlinkMbps,
      },
      summaries: rigCounts.map((rigCount) => {
        const group = receipts.filter((receipt) => receipt.rigCount === rigCount);
        return {
          rigCount,
          usableMs: distribution(group.map((receipt) => receipt.usableMs)),
          responseStartedMs: distribution(group.map((receipt) => receipt.responseStartedMs)),
          responseFinishedMs: distribution(group.map((receipt) => receipt.responseFinishedMs)),
        };
      }),
      receipts,
    },
    null,
    2,
  )}\n`,
);

function numberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parseRigCounts(raw: string | undefined, maximum: number): number[] {
  if (!raw) return [4, maximum];
  const values = raw.split(",").map((value) => Number(value.trim()));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1 || value > maximum)) {
    throw new Error(`RIG_UI_COUNTS must contain integers from 1 to ${maximum}`);
  }
  return [...new Set(values)];
}

async function waitForRigOptions(page: import("playwright").Page, names: string[]): Promise<void> {
  await page.waitForFunction(
    (expectedNames) => {
      const select = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).find(
        (candidate) =>
          Array.from(candidate.options).some(
            (option) => option.textContent === "Workspace default",
          ),
      );
      const labels = Array.from(select?.options ?? []).map((option) => option.textContent ?? "");
      return expectedNames.every((name) => labels.some((label) => label.startsWith(name)));
    },
    names,
    { timeout: 30_000 },
  );
}

function distribution(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: Number(sorted[0]!.toFixed(3)),
    p50: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(3)),
    p95: Number(sorted[Math.ceil(sorted.length * 0.95) - 1]!.toFixed(3)),
    max: Number(sorted.at(-1)!.toFixed(3)),
  };
}
