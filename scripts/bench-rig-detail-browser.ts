#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

const STATE_FILE = `${process.env.RIG_UI_STATE_DIR ?? "/tmp"}/rig-ui-stack.json`;
const samples = integerArgument("--samples", 3);
const cpuThrottleRate = integerArgument("--cpu-throttle", 4);
const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as {
  apiPort: number;
  webPort: number;
  workspaceId: string;
};
const apiOrigin = stringArgument("--api-origin") ?? `http://127.0.0.1:${state.apiPort}`;
const webOrigin = stringArgument("--web-origin") ?? `http://127.0.0.1:${state.webPort}`;
const rigsUrl = `${apiOrigin}/v1/workspaces/${state.workspaceId}/rigs`;

if (samples < 1 || samples > 10) throw new Error("--samples must be between 1 and 10");
if (cpuThrottleRate < 1 || cpuThrottleRate > 20) {
  throw new Error("--cpu-throttle must be between 1 and 20");
}

const listResponse = await fetch(`${rigsUrl}?view=summary`);
if (!listResponse.ok) throw new Error(`rig summary failed with ${listResponse.status}`);
const summaries = (await listResponse.json()) as Array<{ id: string; name: string }>;
const rigSummary = summaries.find((rig) => rig.name.startsWith("perf-huge-"));
if (!rigSummary) throw new Error("no perf-huge rig exists; run bench-rig-list-browser.ts first");
const rigResponse = await fetch(`${rigsUrl}/${rigSummary.id}`);
if (!rigResponse.ok) throw new Error(`rig detail failed with ${rigResponse.status}`);
const rigText = await rigResponse.text();
const rig = JSON.parse(rigText) as {
  activeVersion: { setupScript: string | null } | null;
  name: string;
};
const expectedScript = rig.activeVersion?.setupScript ?? "";
if (expectedScript.length !== 131_072) {
  throw new Error(`expected a maximum setup script, received ${expectedScript.length} characters`);
}

const browser = await chromium.launch();
try {
  const receipts = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      const longTasks: number[] = [];
      (window as unknown as { __rigDetailLongTasks: number[] }).__rigDetailLongTasks = longTasks;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      }).observe({ type: "longtask", buffered: true });
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    const detailResponsePromise = page.waitForResponse(
      (response) => response.url() === `${rigsUrl}/${rigSummary.id}` && response.ok(),
      { timeout: 30_000 },
    );
    const startedAt = performance.now();
    await page.goto(`${webOrigin}/workspaces/${state.workspaceId}/rigs/${rigSummary.id}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const browserDetailResponse = await detailResponsePromise;
    await page.getByRole("heading", { name: rig.name }).waitFor({ timeout: 30_000 });
    await settleFrames(page);
    const overviewReadyMs = performance.now() - startedAt;

    const setupStartedAt = performance.now();
    await page.getByRole("tab", { name: "Setup", exact: true }).click();
    await page.waitForFunction(
      (length) =>
        Array.from(document.querySelectorAll("pre")).some(
          (element) => element.textContent?.length === length,
        ),
      expectedScript.length,
      { timeout: 30_000, polling: 25 },
    );
    await settleFrames(page);
    const setupVisibleMs = performance.now() - setupStartedAt;
    const setupExact = await page.evaluate(
      (script) =>
        Array.from(document.querySelectorAll("pre")).some(
          (element) => element.textContent === script,
        ),
      expectedScript,
    );

    const editStartedAt = performance.now();
    await page.getByRole("button", { name: "Propose edit", exact: true }).click();
    await page.waitForFunction(
      (length) =>
        Array.from(document.querySelectorAll("textarea")).some(
          (element) => element.value.length === length,
        ),
      expectedScript.length,
      { timeout: 30_000, polling: 25 },
    );
    await settleFrames(page);
    const editorVisibleMs = performance.now() - editStartedAt;

    const measured = await page.evaluate((script) => {
      const longTasks =
        (window as unknown as { __rigDetailLongTasks?: number[] }).__rigDetailLongTasks ?? [];
      const editor = Array.from(document.querySelectorAll("textarea")).find(
        (element) => element.value.length === script.length,
      );
      return {
        editorExact: editor?.value === script,
        horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        longTaskTotalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
        longTaskMaxMs: Math.max(0, ...longTasks),
      };
    }, expectedScript);
    const metrics = await cdp.send("Performance.getMetrics");
    const metric = (name: string) =>
      metrics.metrics.find((entry) => entry.name === name)?.value ?? 0;
    if (!setupExact || !measured.editorExact || errors.length > 0) {
      throw new Error(
        `rig detail parity failed: ${JSON.stringify({ setupExact, measured, errors })}`,
      );
    }
    receipts.push({
      overviewReadyMs,
      setupVisibleMs,
      editorVisibleMs,
      responseBytes: (await browserDetailResponse.body()).byteLength,
      nodeCount: metric("Nodes"),
      jsHeapUsedBytes: metric("JSHeapUsedSize"),
      setupExact,
      ...measured,
    });
    await cdp.detach();
    await context.close();
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        surface: "maximum-size rig detail, setup disclosure, and edit form",
        viewport: { width: 390, height: 844, mobile: true, touch: true },
        cpuThrottleRate,
        samples,
        setupScriptCharacters: expectedScript.length,
        setupScriptUtf8Bytes: Buffer.byteLength(expectedScript, "utf8"),
        overviewReadyMs: distribution(receipts.map((receipt) => receipt.overviewReadyMs)),
        setupVisibleMs: distribution(receipts.map((receipt) => receipt.setupVisibleMs)),
        editorVisibleMs: distribution(receipts.map((receipt) => receipt.editorVisibleMs)),
        responseBytes: receipts[0]!.responseBytes,
        nodeCount: distribution(receipts.map((receipt) => receipt.nodeCount)),
        jsHeapUsedBytes: distribution(receipts.map((receipt) => receipt.jsHeapUsedBytes)),
        longTaskTotalMs: distribution(receipts.map((receipt) => receipt.longTaskTotalMs)),
        longTaskMaxMs: distribution(receipts.map((receipt) => receipt.longTaskMaxMs)),
        horizontalOverflow: Math.max(...receipts.map((receipt) => receipt.horizontalOverflow)),
        contentParity: receipts.every((receipt) => receipt.setupExact && receipt.editorExact)
          ? "pass"
          : "fail",
        receipts,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await browser.close();
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
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

function stringArgument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function integerArgument(name: string, fallback: number): number {
  const value = stringArgument(name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}
