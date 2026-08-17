#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { MAX_RIGS_PER_WORKSPACE } from "@opengeni/core";
import { OPENGENI_API_CONTRACT_HEADER, OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { gzipSync } from "node:zlib";
import { chromium, type BrowserContext, type Page } from "playwright";

const STATE_FILE = `${process.env.RIG_UI_STATE_DIR ?? "/tmp"}/rig-ui-stack.json`;
const SAMPLES = 3;
const CPU_THROTTLE_RATE = 4;
const CONTROL_RIG_COUNT = 4;
const MAX_SETUP = buildMaxSetup();

type StackState = {
  apiPort: number;
  webPort: number;
  workspaceId: string;
};

type ListedRig = {
  id: string;
  name: string;
  activeVersion: Record<string, unknown> | null;
};

const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as StackState;
const apiBase = process.env.RIG_UI_API_ORIGIN ?? `http://127.0.0.1:${state.apiPort}`;
const webOrigin = process.env.RIG_UI_WEB_ORIGIN ?? `http://127.0.0.1:${state.webPort}`;
const workspaceId = process.env.RIG_UI_WORKSPACE_ID ?? state.workspaceId;
const webBase = `${webOrigin}/workspaces/${workspaceId}`;
const rigsUrl = `${apiBase}/v1/workspaces/${workspaceId}/rigs`;

const hugeNames = await seedHugeRigs();
const [fullResponse, summaryResponse] = await Promise.all([
  fetch(rigsUrl),
  fetch(`${rigsUrl}?view=summary`),
]);
if (!fullResponse.ok || !summaryResponse.ok) {
  throw new Error(
    `rig reads failed: full=${fullResponse.status} summary=${summaryResponse.status}`,
  );
}
const [fullText, summaryText] = await Promise.all([fullResponse.text(), summaryResponse.text()]);
const full = JSON.parse(fullText) as ListedRig[];
const summaries = JSON.parse(summaryText) as ListedRig[];
if (
  summaries.length !== full.length ||
  summaries.some((rig, index) => rig.id !== full[index]?.id)
) {
  throw new Error("summary changed rig membership or ordering");
}
if (summaries.some((rig) => rig.activeVersion && "setupScript" in rig.activeVersion)) {
  throw new Error("summary leaked a setup script");
}
if (!hugeNames.every((name) => summaries.some((rig) => rig.name === name))) {
  throw new Error("summary omitted at least one maximum-size rig");
}

const nixChromium = spawnSync("nix", ["eval", "--raw", "nixpkgs#chromium.outPath"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
const executablePath =
  nixChromium.status === 0 && nixChromium.stdout.trim()
    ? `${nixChromium.stdout.trim()}/bin/chromium`
    : undefined;
const browser = await chromium.launch(executablePath ? { executablePath } : {});

try {
  const routeReceipts = [];
  for (const rigCount of [CONTROL_RIG_COUNT, summaries.length]) {
    const expectedRigs = summaries.slice(0, rigCount);
    const expectedNames = expectedRigs.map((rig) => rig.name);
    for (const route of ["rigs", "sessions"] as const) {
      const samples = [];
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        const context = await browser.newContext({
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
          reducedMotion: "reduce",
        });
        await context.addInitScript(() => {
          const durations: number[] = [];
          (window as unknown as { __rigListLongTasks: number[] }).__rigListLongTasks = durations;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) durations.push(entry.duration);
          }).observe({ type: "longtask", buffered: true });
        });
        const page = await context.newPage();
        if (rigCount !== summaries.length) {
          await page.route(`${rigsUrl}?view=summary`, async (requestRoute) => {
            await requestRoute.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(expectedRigs),
            });
          });
        }
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE });
        const browserErrors: string[] = [];
        page.on("pageerror", (error) => browserErrors.push(String(error)));
        page.on("console", (message) => {
          if (message.type() === "error") browserErrors.push(message.text());
        });
        const summaryResponsePromise = page.waitForResponse(
          (response) =>
            response.request().method() === "GET" &&
            response.url() === `${rigsUrl}?view=summary` &&
            response.ok(),
          { timeout: 30_000 },
        );
        const startedAt = performance.now();
        await page.goto(`${webBase}/${route}`, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        const browserSummaryResponse = await summaryResponsePromise;
        const responseBytes = (await browserSummaryResponse.body()).byteLength;

        if (route === "rigs") {
          await waitForRigCards(page, expectedRigs.length);
        } else {
          await waitForRigOptions(page, expectedNames);
        }
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await page.evaluate(() => new Promise(requestAnimationFrame));
        const usableMs = performance.now() - startedAt;
        const measured = await measurePage(
          context,
          page,
          route,
          expectedRigs.length,
          expectedNames,
        );
        if (!measured.contentParity) {
          throw new Error(`${route} failed full-content parity: ${JSON.stringify(measured)}`);
        }
        if (browserErrors.length > 0) {
          throw new Error(`${route} browser errors: ${browserErrors.join("; ")}`);
        }
        samples.push({ usableMs, responseBytes, ...measured });
        await cdp.detach();
        await context.close();
      }
      routeReceipts.push({
        route,
        rigCount,
        samples: SAMPLES,
        usableMs: distribution(samples.map((sample) => sample.usableMs)),
        longTaskTotalMs: distribution(samples.map((sample) => sample.longTaskTotalMs)),
        longTaskMaxMs: distribution(samples.map((sample) => sample.longTaskMaxMs)),
        jsHeapUsedBytes: distribution(samples.map((sample) => sample.jsHeapUsedBytes)),
        nodeCount: distribution(samples.map((sample) => sample.nodeCount)),
        responseBytes: samples[0]!.responseBytes,
        renderedRigCount: samples[0]!.renderedRigCount,
        documentOverflow: Math.max(...samples.map((sample) => sample.documentOverflow)),
        contentParity: samples.every((sample) => sample.contentParity) ? "pass" : "fail",
      });
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        surface: "real OpenGeni rigs list and composer picker against real API",
        viewport: { width: 390, height: 844, mobile: true, touch: true },
        cpuThrottleRate: CPU_THROTTLE_RATE,
        workspaceRigLimit: MAX_RIGS_PER_WORKSPACE,
        hugeRigCount: hugeNames.length,
        totalRigCount: summaries.length,
        maximumSetupCharactersPerHugeRig: MAX_SETUP.length,
        maximumSetupUtf8BytesPerHugeRig: Buffer.byteLength(MAX_SETUP),
        fullListBytes: Buffer.byteLength(fullText),
        fullListGzipBytes: gzipSync(fullText).byteLength,
        summaryListBytes: Buffer.byteLength(summaryText),
        summaryListGzipBytes: gzipSync(summaryText).byteLength,
        fullResponseContentEncoding: fullResponse.headers.get("content-encoding"),
        summaryResponseContentEncoding: summaryResponse.headers.get("content-encoding"),
        projectedSingleRequestTransferMs: {
          fastMobile10Mbps: {
            full: transferMs(gzipSync(fullText).byteLength, 10),
            summary: transferMs(gzipSync(summaryText).byteLength, 10),
          },
          constrainedMobile1_6Mbps: {
            full: transferMs(gzipSync(fullText).byteLength, 1.6),
            summary: transferMs(gzipSync(summaryText).byteLength, 1.6),
          },
        },
        routeReceipts,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}

async function seedHugeRigs(): Promise<string[]> {
  const response = await fetch(`${rigsUrl}?view=summary`);
  if (!response.ok) throw new Error(`initial summary read failed: ${response.status}`);
  const existing = (await response.json()) as ListedRig[];
  const nonBenchmarkCount = existing.filter((rig) => !rig.name.startsWith("perf-huge-")).length;
  const targetCount = MAX_RIGS_PER_WORKSPACE - nonBenchmarkCount;
  const expectedNames = Array.from({ length: targetCount }, (_, index) => hugeRigName(index));
  const expectedNameSet = new Set(expectedNames);
  const extras = existing.filter(
    (rig) => rig.name.startsWith("perf-huge-") && !expectedNameSet.has(rig.name),
  );
  await Promise.all(
    extras.map(async (rig) => {
      const deletion = await fetch(`${rigsUrl}/${rig.id}`, {
        method: "DELETE",
        headers: { [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION },
      });
      await deletion.arrayBuffer();
      if (!deletion.ok) throw new Error(`failed to remove benchmark overflow rig ${rig.name}`);
    }),
  );
  const extraIds = new Set(extras.map((rig) => rig.id));
  const existingNames = new Set(
    existing.filter((rig) => !extraIds.has(rig.id)).map((rig) => rig.name),
  );
  const missing = Array.from({ length: targetCount }, (_, index) => index).filter(
    (index) => !existingNames.has(hugeRigName(index)),
  );
  for (let offset = 0; offset < missing.length; offset += 4) {
    await Promise.all(
      missing.slice(offset, offset + 4).map(async (index) => {
        const create = await fetch(rigsUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [OPENGENI_API_CONTRACT_HEADER]: OPENGENI_API_CONTRACT_REVISION,
          },
          body: JSON.stringify({
            name: hugeRigName(index),
            description: `Maximum-size mobile rig ${index + 1}`,
            image: "ubuntu:24.04",
            setupScript: MAX_SETUP,
            checks: [{ name: "ready", command: "true" }],
          }),
        });
        const responseBody = await create.arrayBuffer();
        if (create.status !== 201) {
          throw new Error(
            `failed to create ${hugeRigName(index)}: ${create.status} ${new TextDecoder().decode(responseBody)}`,
          );
        }
      }),
    );
  }
  return expectedNames;
}

async function waitForRigCards(page: Page, expectedCount: number): Promise<void> {
  await page.waitForFunction(
    ({ workspaceId: expectedWorkspaceId, count }) =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).filter((anchor) =>
        new URL(anchor.href).pathname.startsWith(`/workspaces/${expectedWorkspaceId}/rigs/`),
      ).length === count,
    { workspaceId, count: expectedCount },
    { timeout: 30_000 },
  );
}

async function waitForRigOptions(page: Page, expectedNames: readonly string[]): Promise<void> {
  await page.waitForFunction(
    (names) => {
      const rigSelect = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).find(
        (select) =>
          Array.from(select.options).some((option) => option.textContent === "Workspace default"),
      );
      const options = Array.from(rigSelect?.options ?? []);
      const labels = new Set(options.map((option) => option.textContent ?? ""));
      return names.every((name) => Array.from(labels).some((label) => label.startsWith(name)));
    },
    expectedNames,
    { timeout: 30_000 },
  );
}

async function measurePage(
  context: BrowserContext,
  page: Page,
  route: "rigs" | "sessions",
  expectedRigCount: number,
  expectedHugeNames: readonly string[],
) {
  const content = await page.evaluate(
    ({ workspaceId: expectedWorkspaceId, pageRoute, rigCount, expectedNames }) => {
      const longTasks =
        (window as unknown as { __rigListLongTasks?: number[] }).__rigListLongTasks ?? [];
      const rigSelect = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).find(
        (select) =>
          Array.from(select.options).some((option) => option.textContent === "Workspace default"),
      );
      const renderedNames =
        pageRoute === "rigs"
          ? Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))
              .filter((anchor) =>
                new URL(anchor.href).pathname.startsWith(
                  `/workspaces/${expectedWorkspaceId}/rigs/`,
                ),
              )
              .map((anchor) => anchor.textContent ?? "")
          : Array.from(rigSelect?.options ?? []).map((option) => option.textContent ?? "");
      return {
        renderedRigCount:
          pageRoute === "rigs"
            ? renderedNames.length
            : renderedNames.filter((name) => name !== "Workspace default").length,
        documentOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        longTaskTotalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
        longTaskMaxMs: Math.max(0, ...longTasks),
        contentParity:
          (pageRoute !== "rigs" || renderedNames.length === rigCount) &&
          expectedNames.every((name) => renderedNames.some((rendered) => rendered.includes(name))),
      };
    },
    {
      workspaceId,
      pageRoute: route,
      rigCount: expectedRigCount,
      expectedNames: expectedHugeNames,
    },
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  const metric = (name: string) => metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
  await cdp.detach();
  return {
    ...content,
    jsHeapUsedBytes: metric("JSHeapUsedSize"),
    nodeCount: metric("Nodes"),
  };
}

function hugeRigName(index: number): string {
  return `perf-huge-${String(index + 1).padStart(3, "0")}`;
}

function buildMaxSetup(): string {
  let stateValue = 0x5eed1234;
  const characters = ["#"];
  for (let index = 1; index < 131_072; index += 1) {
    stateValue = (Math.imul(stateValue, 1_664_525) + 1_013_904_223) >>> 0;
    characters.push(String.fromCharCode(0x4e00 + (stateValue % 20_000)));
  }
  return characters.join("");
}

function transferMs(bytes: number, megabitsPerSecond: number): number {
  return (bytes * 8 * 1_000) / (megabitsPerSecond * 1_000_000);
}

function distribution(values: readonly number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)]!;
  return {
    min: ordered[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: ordered.at(-1)!,
  };
}
