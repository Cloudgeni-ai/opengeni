#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { freePort, runCommand, startProcess } from "@opengeni/testing";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");
const suppliedOrigin = process.env.QUEUE_ACTION_WEB_ORIGIN;
const port = suppliedOrigin ? null : await freePort();
const baseUrl = suppliedOrigin ?? `http://127.0.0.1:${port}`;
const counts = parsePositiveIntegers(process.env.QUEUE_ACTION_COUNTS) ?? [1, 100, 1_000, 5_000];
const delayMs = 1_200;
const samples = Number(process.env.QUEUE_ACTION_SAMPLES ?? "3");
const cpuProfilePrefix = process.env.QUEUE_ACTION_CPU_PROFILE_PREFIX;
const outputPath = process.env.QUEUE_ACTION_OUTPUT;
const injectContentVisibility = process.env.QUEUE_ACTION_CONTENT_VISIBILITY === "1";
const supportedActions = ["steer", "delete", "delete-rejected", "move"] as const;
type Action = (typeof supportedActions)[number];
const actions = parseActions(process.env.QUEUE_ACTIONS);

let server: Awaited<ReturnType<typeof startProcess>> | null = null;
if (!suppliedOrigin) {
  const extensionBuild = await runCommand(["bun", "run", "build"], {
    cwd: `${repoRoot}/apps/browser-extension`,
    timeoutMs: 90_000,
  });
  if (extensionBuild.exitCode !== 0) {
    throw new Error(
      `Browser extension prerequisite failed:\n${extensionBuild.stdout}\n${extensionBuild.stderr}`,
    );
  }
  const webBuild = await runCommand(["bun", "run", "vite", "build", "--mode", "performance"], {
    cwd: `${repoRoot}/apps/web`,
    timeoutMs: 180_000,
  });
  if (webBuild.exitCode !== 0) {
    throw new Error(`Production web build failed:\n${webBuild.stdout}\n${webBuild.stderr}`);
  }
  server = await startProcess(["bun", "src/server.ts"], {
    cwd: `${repoRoot}/apps/web`,
    env: { PORT: String(port), HOST: "127.0.0.1" },
    ready: async () => (await fetch(baseUrl).catch(() => null))?.ok === true,
    timeoutMs: 45_000,
  });
}
const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : undefined);
const measurements: Array<Record<string, unknown>> = [];
try {
  for (const count of counts) {
    for (const action of actions) {
      if ((action === "move" || action === "steer") && count === 1) continue;
      for (let sample = 0; sample < samples; sample += 1) {
        process.stderr.write(`queue-action count=${count} action=${action} sample=${sample + 1}\n`);
        measurements.push(await measure(count, action, sample));
      }
    }
  }
} finally {
  await Promise.allSettled([browser.close(), server?.stop()]);
}

const grouped = Object.values(
  Object.groupBy(measurements, (row) => `${String(row.count)}:${String(row.action)}`),
).flatMap((rows) => {
  if (!rows) return [];
  const first = rows[0]!;
  return [
    {
      count: first.count,
      action: first.action,
      samples: rows.length,
      panelOpenMs: distribution(rows.map((row) => Number(row.panelOpenMs))),
      feedbackMs: distribution(rows.map((row) => Number(row.feedbackMs))),
      settlementMs: distribution(rows.map((row) => Number(row.settlementMs))),
      visibleReceiptMs: distribution(
        rows.flatMap((row) =>
          row.visibleReceiptMs === null ? [] : [Number(row.visibleReceiptMs)],
        ),
      ),
      queueConsistentMs: distribution(
        rows.flatMap((row) =>
          row.queueConsistentMs === null ? [] : [Number(row.queueConsistentMs)],
        ),
      ),
      feedbackLongTaskTotalMs: distribution(rows.map((row) => Number(row.feedbackLongTaskTotalMs))),
      feedbackLongTaskMaxMs: distribution(rows.map((row) => Number(row.feedbackLongTaskMaxMs))),
      contentParity: rows.every((row) => row.contentParity === true),
      actionVisualParity: rows.every((row) => row.actionVisualParity === true),
      rowContainmentParity: rows.every((row) => row.rowContainmentParity === true),
      truthfulIntermediateReceipt: rows.every(
        (row) => row.action !== "steer" || row.truthfulIntermediateReceipt === true,
      ),
      truthfulSettlement: rows.every((row) => row.truthfulSettlement === true),
    },
  ];
});

const receipt = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  surface: "production SessionChrome on a 390x844 touch viewport at 4x CPU",
  configuration: { counts, delayMs, samples, actions, injectContentVisibility },
  invariant:
    "Every queued prompt remains mounted with its complete text; the benchmark changes only one requested row and never calls an API or model.",
  grouped,
  measurements,
};
const serializedReceipt = `${JSON.stringify(receipt, null, 2)}\n`;
if (outputPath) {
  await writeFile(outputPath, serializedReceipt);
} else {
  process.stdout.write(serializedReceipt);
}

async function measure(count: number, action: Action, sample: number) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.addInitScript(() => {
    const entries: number[] = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) entries.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
    Object.defineProperty(window, "__queueActionLongTasks", { value: entries });
  });
  try {
    const failure = action === "delete-rejected" ? "&queueFail=delete" : "";
    await page.goto(
      `${baseUrl}/dev/composer-chrome?scenario=queued-only&queueCount=${count}&queueOpen=0&queueReadOnly=0&queueDelayMs=${delayMs}${failure}`,
      { waitUntil: "networkidle", timeout: 60_000 },
    );
    if (injectContentVisibility) {
      await page.addStyleTag({
        content:
          "[data-queue-turn-id] { content-visibility: auto; contain-intrinsic-size: auto 2.75rem; }",
      });
    }
    const signal = page.locator('[data-og-session-chrome-signal="queue"]');
    await signal.waitFor({ state: "visible", timeout: 120_000 }).catch((error) => {
      throw new Error(
        `queue signal unavailable for count=${count} action=${action}; page errors=${pageErrors.join(" | ") || "none"}`,
        { cause: error },
      );
    });
    const panelStartedAt = await now(page);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[data-og-session-chrome-signal="queue"]')?.click();
    });
    await page.waitForFunction(
      (expected) => document.querySelectorAll("[data-queue-turn-id]").length === expected,
      count,
      { timeout: 60_000, polling: 10 },
    );
    const panelOpenMs = (await now(page)) - panelStartedAt;
    const actionVisual = await page.evaluate(() => {
      const firstRow = document.querySelector<HTMLElement>("[data-queue-turn-id]");
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>("button[data-queue-command]"),
      ];
      const commands = Object.groupBy(buttons, (button) => button.dataset.queueCommand ?? "");
      return {
        buttonCount: buttons.length,
        svgCount: buttons.reduce(
          (svgTotal, button) => svgTotal + button.querySelectorAll("svg").length,
          0,
        ),
        steerCount: commands.steer?.length ?? 0,
        moreCount: commands.more?.length ?? 0,
        disclosedCount:
          (commands.move?.length ?? 0) +
          (commands.edit?.length ?? 0) +
          (commands.delete?.length ?? 0),
        clearText: buttons.every((button) => {
          const expected = button.dataset.queueCommand === "steer" ? "Steer" : "More";
          return button.textContent === expected;
        }),
        contentVisibility: firstRow?.style.contentVisibility ?? "",
        containIntrinsicSize: firstRow?.style.containIntrinsicSize ?? "",
        computedContainIntrinsicSize: firstRow
          ? getComputedStyle(firstRow).containIntrinsicSize
          : "",
      };
    });
    const targetOrdinal = action === "steer" || action === "move" ? 2 : 1;
    const label =
      action === "steer"
        ? `Steer queued prompt ${targetOrdinal}`
        : action === "move"
          ? `Move queued prompt ${targetOrdinal} up`
          : `Remove queued prompt ${targetOrdinal}`;
    const beforeIds = await rowIds(page);
    const targetId = beforeIds[targetOrdinal - 1] ?? "";
    const targetText =
      (await page
        .locator("[data-queue-turn-id]")
        .nth(targetOrdinal - 1)
        .locator("p")
        .textContent()) ?? "";
    let disclosedActionParity: "not-applicable" | "pass" = "not-applicable";
    if (action !== "steer") {
      const moreLabel = `More actions for queued prompt ${targetOrdinal}`;
      await page.evaluate((accessibleName) => {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (candidate) => candidate.getAttribute("aria-label") === accessibleName,
        );
        if (!button) throw new Error(`missing action ${accessibleName}`);
        button.click();
      }, moreLabel);
      await page.waitForFunction(
        (accessibleName) =>
          [...document.querySelectorAll<HTMLButtonElement>("button")].some(
            (candidate) => candidate.getAttribute("aria-label") === accessibleName,
          ),
        label,
      );
      disclosedActionParity = await page.evaluate(
        ({ id, expectedCount }) => {
          const row = document.querySelector<HTMLElement>(`[data-queue-turn-id="${id}"]`);
          const strip = row?.querySelector<HTMLElement>("[id^='queue-actions-']");
          const labels = [...(strip?.querySelectorAll<HTMLButtonElement>("button") ?? [])].map(
            (button) => button.textContent,
          );
          const expected =
            expectedCount === 1 ? ["Edit", "Delete"] : ["Move up", "Move down", "Edit", "Delete"];
          return labels.join(",") === expected.join(",") ? "pass" : "not-applicable";
        },
        { id: targetId, expectedCount: count },
      );
    }
    await settleFrames(page);
    await page.evaluate(
      ({ expectedCount, id, kind }) => {
        (window as unknown as { __queueActionLongTasks: number[] }).__queueActionLongTasks.length =
          0;
        const records: Array<{ type: string; attributeName: string | null; rowId: string | null }> =
          [];
        const feedback = {
          startedAt: performance.now(),
          visibleReceiptMs: null as number | null,
          queueConsistentMs: null as number | null,
          truthfulIntermediateReceipt: null as boolean | null,
        };
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            const element =
              mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
            records.push({
              type: mutation.type,
              attributeName: mutation.attributeName,
              rowId:
                element?.closest<HTMLElement>("[data-queue-turn-id]")?.dataset.queueTurnId ?? null,
            });
          }
          if (
            kind === "steer" &&
            feedback.visibleReceiptMs === null &&
            document.querySelector('[data-og-session-chrome-signal="steering"]')
          ) {
            feedback.visibleReceiptMs = performance.now() - feedback.startedAt;
            const pendingRow = document.querySelector<HTMLElement>(`[data-queue-turn-id="${id}"]`);
            const pendingAction = pendingRow?.querySelector<HTMLButtonElement>(
              'button[data-queue-command="steer"]',
            );
            feedback.truthfulIntermediateReceipt =
              pendingAction?.disabled === true && pendingAction.textContent === "Changing…";
          }
          if (
            feedback.queueConsistentMs === null &&
            document.querySelectorAll("[data-queue-turn-id]").length ===
              expectedCount - (kind === "steer" ? 1 : 0)
          ) {
            feedback.queueConsistentMs = performance.now() - feedback.startedAt;
          }
        });
        const panel = document.querySelector('[data-og-session-chrome-panel="queue"]');
        if (panel) observer.observe(panel, { subtree: true, childList: true, attributes: true });
        Object.assign(window, {
          __queueActionMutationRecords: records,
          __queueActionMutationObserver: observer,
          __queueActionFeedback: feedback,
        });
      },
      { expectedCount: count, id: targetId, kind: action },
    );

    const feedbackStartedAt = await now(page);
    if (cpuProfilePrefix) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    await page.evaluate((accessibleName) => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === accessibleName,
      );
      if (!button) throw new Error(`missing action ${accessibleName}`);
      button.click();
    }, label);
    await page.waitForFunction(
      ({ accessibleName, kind, before, expectedText, expectedCount }) => {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (candidate) => candidate.getAttribute("aria-label") === accessibleName,
        );
        if (kind === "move") {
          const ids = [...document.querySelectorAll<HTMLElement>("[data-queue-turn-id]")].map(
            (row) => row.dataset.queueTurnId ?? "",
          );
          return ids[0] === before[1] && ids[1] === before[0];
        }
        if (kind === "steer") {
          return (
            document.querySelectorAll("[data-queue-turn-id]").length === expectedCount - 1 &&
            document
              .querySelector('[data-og-session-chrome-signal="steering"]')
              ?.textContent?.includes(expectedText) === true
          );
        }
        return button?.disabled === true;
      },
      {
        accessibleName: label,
        kind: action,
        before: beforeIds,
        expectedText: targetText,
        expectedCount: count,
      },
      { timeout: 30_000, polling: 10 },
    );
    const feedbackMs = (await now(page)) - feedbackStartedAt;
    if (cpuProfilePrefix) {
      const { profile } = await cdp.send("Profiler.stop");
      const profilePath = `${cpuProfilePrefix}-${count}-${action}-${sample}.cpuprofile`;
      await writeFile(profilePath, JSON.stringify(profile));
      await cdp.send("Profiler.disable");
    }
    const feedbackLongTasks = await page.evaluate(
      () => (window as unknown as { __queueActionLongTasks: number[] }).__queueActionLongTasks,
    );
    const feedbackMutations = await page.evaluate(() => {
      const state = window as unknown as {
        __queueActionMutationRecords: Array<{
          type: string;
          attributeName: string | null;
          rowId: string | null;
        }>;
        __queueActionMutationObserver: MutationObserver;
        __queueActionFeedback: {
          visibleReceiptMs: number | null;
          queueConsistentMs: number | null;
          truthfulIntermediateReceipt: boolean | null;
        };
      };
      state.__queueActionMutationObserver.disconnect();
      const affectedRows = new Set(
        state.__queueActionMutationRecords.flatMap((record) =>
          record.rowId === null ? [] : [record.rowId],
        ),
      );
      return {
        count: state.__queueActionMutationRecords.length,
        affectedRowCount: affectedRows.size,
        byType: Object.groupBy(
          state.__queueActionMutationRecords,
          (record) => `${record.type}:${record.attributeName ?? ""}`,
        ),
        ...state.__queueActionFeedback,
      };
    });
    const feedbackRowCount = await page.locator("[data-queue-turn-id]").count();

    if (action === "delete") {
      await page.waitForFunction(
        (expected) => document.querySelectorAll("[data-queue-turn-id]").length === expected,
        count - 1,
        { timeout: delayMs * 5, polling: 10 },
      );
    } else if (action === "delete-rejected") {
      await page.getByTestId("session-chrome-queue-error").waitFor({
        state: "visible",
        timeout: delayMs * 5,
      });
    } else {
      await page.waitForFunction(
        ({ accessibleName, kind, id }) => {
          if (kind === "steer") {
            return (
              document.querySelector(
                '[data-og-session-chrome-signal="steering"] .animate-og-spin',
              ) === null
            );
          }
          const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
            (candidate) => candidate.getAttribute("aria-label") === accessibleName,
          );
          if (kind === "move") {
            return [
              ...document.querySelectorAll<HTMLButtonElement>("button[data-queue-command='move']"),
            ]
              .filter((candidate) => candidate.dataset.queueCommandTurnId === id)
              .some((candidate) => !candidate.disabled);
          }
          return button === undefined || button.disabled === false;
        },
        { accessibleName: label, kind: action, id: targetId },
        { timeout: delayMs * 5, polling: 10 },
      );
    }
    const settlementMs = (await now(page)) - feedbackStartedAt;
    const afterIds = await rowIds(page);
    const finalRowCount = afterIds.length;
    const expectedFeedbackRows = action === "steer" ? count - 1 : count;
    const expectedFinalRows = action === "delete" || action === "steer" ? count - 1 : count;
    const contentParity =
      feedbackRowCount === expectedFeedbackRows && finalRowCount === expectedFinalRows;
    const truthfulSettlement =
      action === "delete"
        ? !afterIds.includes(beforeIds[0] ?? "")
        : action === "delete-rejected"
          ? afterIds[0] === beforeIds[0]
          : action === "move"
            ? afterIds[0] === beforeIds[1]
            : action === "steer"
              ? afterIds[0] === beforeIds[0]
              : false;
    return {
      count,
      action,
      sample,
      panelOpenMs,
      feedbackMs,
      settlementMs,
      visibleReceiptMs: feedbackMutations.visibleReceiptMs,
      queueConsistentMs: feedbackMutations.queueConsistentMs,
      truthfulIntermediateReceipt: feedbackMutations.truthfulIntermediateReceipt,
      feedbackLongTaskTotalMs: feedbackLongTasks.reduce((sum, value) => sum + value, 0),
      feedbackLongTaskMaxMs: Math.max(0, ...feedbackLongTasks),
      feedbackMutationCount: feedbackMutations.count,
      feedbackAffectedRowCount: feedbackMutations.affectedRowCount,
      feedbackMutationKinds: Object.fromEntries(
        Object.entries(feedbackMutations.byType).map(([kind, records]) => [
          kind,
          records?.length ?? 0,
        ]),
      ),
      feedbackRowCount,
      finalRowCount,
      contentParity,
      actionVisualParity:
        actionVisual.buttonCount === count * 2 &&
        actionVisual.svgCount === 0 &&
        actionVisual.steerCount === count &&
        actionVisual.moreCount === count &&
        actionVisual.disclosedCount === 0 &&
        actionVisual.clearText &&
        (action === "steer" || disclosedActionParity === "pass"),
      rowContainmentParity:
        actionVisual.contentVisibility === "auto" &&
        (injectContentVisibility
          ? actionVisual.computedContainIntrinsicSize === "auto 44px"
          : actionVisual.containIntrinsicSize ===
              "auto var(--_og-session-chrome-queue-row-intrinsic-size)" &&
            actionVisual.computedContainIntrinsicSize === "auto 44px"),
      actionVisual,
      disclosedActionParity,
      truthfulSettlement,
    };
  } finally {
    await cdp.detach().catch(() => undefined);
    await context.close();
  }
}

async function rowIds(page: Page): Promise<string[]> {
  return await page
    .locator("[data-queue-turn-id]")
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.queueTurnId ?? ""));
}

async function now(page: Page): Promise<number> {
  return await page.evaluate(() => performance.now());
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

function distribution(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number) =>
    Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]!.toFixed(1));
  return { min: at(0), p50: at(0.5), p95: at(0.95), max: at(1) };
}

function parsePositiveIntegers(value: string | undefined): number[] | null {
  if (!value) return null;
  const values = value.split(",").map((item) => Number(item.trim()));
  if (values.length === 0 || values.some((item) => !Number.isInteger(item) || item <= 0)) {
    throw new TypeError("QUEUE_ACTION_COUNTS must be a comma-separated list of positive integers");
  }
  return values;
}

function parseActions(value: string | undefined): Action[] {
  if (!value) return [...supportedActions];
  const values = value.split(",").map((item) => item.trim());
  if (
    values.length === 0 ||
    values.some((item): item is string => !supportedActions.includes(item as Action))
  ) {
    throw new TypeError(`QUEUE_ACTIONS must contain only ${supportedActions.join(", ")}`);
  }
  return values as Action[];
}
