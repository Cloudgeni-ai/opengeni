import { existsSync } from "node:fs";
import { chromium, type BrowserContext, type Page } from "playwright";
import { freePort, runCommand, startProcess } from "@opengeni/testing";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const reactRoot = `${repoRoot}/packages/react`;
const receiptPath = "/tmp/opengeni-composer-interactions.receipt.json";
const acceptanceDelayMs = 1_200;

type ViewportProfile = {
  name: "desktop" | "phone-4x";
  width: number;
  height: number;
  cpuRate: number;
  mobile: boolean;
};

type InteractionMeasurement = {
  profile: ViewportProfile["name"];
  action: "queue" | "steer" | "steer-rejected" | "queue-burst" | "queue-remount";
  feedbackMs: number[];
  acceptanceMs: number | null;
  initialDraftAfterFeedback: string;
  finalDraft: string;
  optimisticCountAfterFeedback: number;
  finalOptimisticCount: number;
  steeringPhaseAfterFeedback: string;
  finalSteeringPhase: string;
  error: string;
  userMessageCount: number;
  exactPromptCopies: Record<string, number>;
  longTasks: number;
  longTaskDurationMs: number;
  horizontalOverflowPx: number;
};

const profiles: ViewportProfile[] = [
  { name: "desktop", width: 1_440, height: 1_000, cpuRate: 1, mobile: false },
  { name: "phone-4x", width: 390, height: 844, cpuRate: 4, mobile: true },
];

const build = await runCommand(["bun", "run", "vite", "build", "demo"], {
  cwd: reactRoot,
  timeoutMs: 90_000,
});
if (build.exitCode !== 0) {
  throw new Error(`React demo build failed:\n${build.stdout}\n${build.stderr}`);
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const server = await startProcess(
  [
    "bun",
    "run",
    "vite",
    "preview",
    "demo",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--strictPort",
  ],
  {
    cwd: reactRoot,
    ready: async () =>
      (
        await fetch(`${baseUrl}/composer-latency.html`, {
          signal: AbortSignal.timeout(2_000),
        }).catch(() => null)
      )?.ok === true,
    timeoutMs: 45_000,
  },
);

const executablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ??
  (existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined);
const browser = await chromium.launch(executablePath ? { executablePath } : undefined);
const measurements: InteractionMeasurement[] = [];

try {
  for (const profile of profiles) {
    measurements.push(await measureQueue(profile));
    measurements.push(await measureSteer(profile, false));
    measurements.push(await measureSteer(profile, true));
    measurements.push(await measureBurst(profile));
    measurements.push(await measureRemount(profile));
  }
} finally {
  await Promise.allSettled([browser.close(), server.stop()]);
}

const receipt = {
  generatedAt: new Date().toISOString(),
  branch: (await runCommand(["git", "branch", "--show-current"], { cwd: repoRoot })).stdout.trim(),
  head: (await runCommand(["git", "rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim(),
  acceptanceDelayMs,
  measurements,
  assertions: {
    allFeedbackUnder250Ms: measurements.every((row) => row.feedbackMs.every((ms) => ms < 250)),
    noPromptLossOrDuplication: measurements.every((row) =>
      Object.values(row.exactPromptCopies).every((count) => count === 1),
    ),
    noHorizontalOverflow: measurements.every((row) => row.horizontalOverflowPx <= 1),
  },
};

if (!receipt.assertions.allFeedbackUnder250Ms) {
  throw new Error(`Composer feedback exceeded 250ms:\n${JSON.stringify(receipt, null, 2)}`);
}
if (!receipt.assertions.noPromptLossOrDuplication) {
  throw new Error(
    `Composer prompt loss/duplication detected:\n${JSON.stringify(receipt, null, 2)}`,
  );
}
if (!receipt.assertions.noHorizontalOverflow) {
  throw new Error(`Composer horizontal overflow detected:\n${JSON.stringify(receipt, null, 2)}`);
}

await Bun.write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ receiptPath, ...receipt }, null, 2));

async function createPage(
  profile: ViewportProfile,
  query: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    hasTouch: profile.mobile,
    isMobile: profile.mobile,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  if (profile.cpuRate > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuRate });
  }
  await page.addInitScript(() => {
    const entries: number[] = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) entries.push(entry.duration);
    }).observe({ type: "longtask", buffered: true });
    Object.defineProperty(window, "__composerLongTasks", { value: entries });
  });
  await page.goto(`${baseUrl}/composer-latency.html?${query}`, { waitUntil: "networkidle" });
  await page.locator("[data-composer-latency-harness]").waitFor();
  await page.getByRole("textbox", { name: "Message the agent" }).waitFor();
  return { context, page };
}

async function measureQueue(profile: ViewportProfile): Promise<InteractionMeasurement> {
  const { context, page } = await createPage(profile, `delayMs=${acceptanceDelayMs}`);
  const prompt = `queue-${profile.name}-${crypto.randomUUID()}`;
  try {
    await fill(page, prompt);
    const startedAt = await now(page);
    const wallStartedAt = Date.now();
    await page.getByRole("textbox", { name: "Message the agent" }).press("Enter");
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-composer-latency-harness]")
          ?.getAttribute("data-optimistic-count") === "1",
    );
    const feedbackMs = (await now(page)) - startedAt;
    const after = await harnessState(page);
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-composer-latency-harness]")
          ?.getAttribute("data-optimistic-count") === "0",
      undefined,
      { timeout: acceptanceDelayMs * 4 },
    );
    const acceptanceMs = Date.now() - wallStartedAt;
    return await collect(page, profile, "queue", [feedbackMs], acceptanceMs, after, [prompt]);
  } finally {
    await context.close();
  }
}

async function measureSteer(
  profile: ViewportProfile,
  rejected: boolean,
): Promise<InteractionMeasurement> {
  const { context, page } = await createPage(
    profile,
    `delayMs=${acceptanceDelayMs}${rejected ? "&fail=steer" : ""}`,
  );
  const prompt = `steer-${rejected ? "rejected" : "accepted"}-${profile.name}-${crypto.randomUUID()}`;
  try {
    await fill(page, prompt);
    const startedAt = await now(page);
    await page.getByRole("textbox", { name: "Message the agent" }).press("Meta+Enter");
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-composer-latency-harness]")
          ?.getAttribute("data-steering-phase") === "submitting",
    );
    const feedbackMs = (await now(page)) - startedAt;
    const after = await harnessState(page);
    if (rejected) {
      await page.waitForFunction(
        () =>
          (document.querySelector("[data-composer-latency-harness]")?.getAttribute("data-error")
            ?.length ?? 0) > 0,
        undefined,
        { timeout: acceptanceDelayMs * 4 },
      );
    } else {
      await page.waitForFunction(
        () =>
          Number(
            document
              .querySelector("[data-composer-latency-harness]")
              ?.getAttribute("data-event-count") ?? "0",
          ) > 0,
        undefined,
        { timeout: acceptanceDelayMs * 4 },
      );
    }
    const acceptanceMs = (await now(page)) - startedAt;
    return await collect(
      page,
      profile,
      rejected ? "steer-rejected" : "steer",
      [feedbackMs],
      acceptanceMs,
      after,
      rejected ? [] : [prompt],
    );
  } finally {
    await context.close();
  }
}

async function measureBurst(profile: ViewportProfile): Promise<InteractionMeasurement> {
  const { context, page } = await createPage(profile, `delayMs=${acceptanceDelayMs}`);
  const prompts = Array.from(
    { length: 3 },
    (_, index) => `burst-${profile.name}-${index + 1}-${crypto.randomUUID()}`,
  );
  const feedbackMs: number[] = [];
  try {
    for (const [index, prompt] of prompts.entries()) {
      await fill(page, prompt);
      const startedAt = await now(page);
      await page.getByRole("textbox", { name: "Message the agent" }).press("Enter");
      await page.waitForFunction(
        (count) =>
          document
            .querySelector("[data-composer-latency-harness]")
            ?.getAttribute("data-optimistic-count") === String(count),
        index + 1,
      );
      feedbackMs.push((await now(page)) - startedAt);
    }
    const after = await harnessState(page);
    const settlementStartedAt = await now(page);
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-composer-latency-harness]")
          ?.getAttribute("data-optimistic-count") === "0",
      undefined,
      { timeout: acceptanceDelayMs * 8 },
    );
    const acceptanceMs = (await now(page)) - settlementStartedAt;
    return await collect(page, profile, "queue-burst", feedbackMs, acceptanceMs, after, prompts);
  } finally {
    await context.close();
  }
}

async function measureRemount(profile: ViewportProfile): Promise<InteractionMeasurement> {
  const { context, page } = await createPage(profile, `delayMs=${acceptanceDelayMs}`);
  const prompt = `remount-${profile.name}-${crypto.randomUUID()}`;
  try {
    await fill(page, prompt);
    const startedAt = await now(page);
    const wallStartedAt = Date.now();
    await page.getByRole("textbox", { name: "Message the agent" }).press("Enter");
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-composer-latency-harness]")
          ?.getAttribute("data-optimistic-count") === "1",
    );
    const feedbackMs = (await now(page)) - startedAt;
    const after = await harnessState(page);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator("[data-composer-latency-harness]").waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector("[data-composer-latency-harness]")
          ?.getAttribute("data-optimistic-count") === "0",
      undefined,
      { timeout: acceptanceDelayMs * 5 },
    );
    const acceptanceMs = Date.now() - wallStartedAt;
    return await collect(page, profile, "queue-remount", [feedbackMs], acceptanceMs, after, [
      prompt,
    ]);
  } finally {
    await context.close();
  }
}

async function fill(page: Page, prompt: string): Promise<void> {
  await page.getByRole("textbox", { name: "Message the agent" }).fill(prompt);
}

async function now(page: Page): Promise<number> {
  return await page.evaluate(() => performance.now());
}

async function harnessState(page: Page) {
  return await page.locator("[data-composer-latency-harness]").evaluate((element) => ({
    draft: element.getAttribute("data-composer-draft") ?? "",
    optimisticCount: Number(element.getAttribute("data-optimistic-count") ?? "0"),
    steeringPhase: element.getAttribute("data-steering-phase") ?? "none",
  }));
}

async function collect(
  page: Page,
  profile: ViewportProfile,
  action: InteractionMeasurement["action"],
  feedbackMs: number[],
  acceptanceMs: number | null,
  after: Awaited<ReturnType<typeof harnessState>>,
  prompts: string[],
): Promise<InteractionMeasurement> {
  const final = await page.locator("[data-composer-latency-harness]").evaluate((element) => ({
    draft: element.getAttribute("data-composer-draft") ?? "",
    optimisticCount: Number(element.getAttribute("data-optimistic-count") ?? "0"),
    steeringPhase: element.getAttribute("data-steering-phase") ?? "none",
    error: element.getAttribute("data-error") ?? "",
    userMessageCount: Number(element.getAttribute("data-user-message-count") ?? "0"),
    horizontalOverflowPx: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
    longTasks: (window as unknown as { __composerLongTasks: number[] }).__composerLongTasks ?? [],
  }));
  const userMessageTexts = await page.locator("[data-og-user-message-content]").allTextContents();
  return {
    profile: profile.name,
    action,
    feedbackMs: feedbackMs.map(round),
    acceptanceMs: acceptanceMs === null ? null : round(acceptanceMs),
    initialDraftAfterFeedback: after.draft,
    finalDraft: final.draft,
    optimisticCountAfterFeedback: after.optimisticCount,
    finalOptimisticCount: final.optimisticCount,
    steeringPhaseAfterFeedback: after.steeringPhase,
    finalSteeringPhase: final.steeringPhase,
    error: final.error,
    userMessageCount: final.userMessageCount,
    exactPromptCopies: Object.fromEntries(
      prompts.map((prompt) => [
        prompt,
        userMessageTexts.filter((text) => text.trim() === prompt).length,
      ]),
    ),
    longTasks: final.longTasks.length,
    longTaskDurationMs: round(final.longTasks.reduce((sum, duration) => sum + duration, 0)),
    horizontalOverflowPx: final.horizontalOverflowPx,
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
