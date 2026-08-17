#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { chromium, type CDPSession, type Page } from "playwright";

type Fixture = {
  eventCount: number;
  sessionId: string;
  shape?: "messages" | "turns";
  workspaceId: string;
};

type Scenario = "feedback" | "acceptance" | "rejection" | "burst" | "panel" | "visibility";

const fixtureFile = argument("--fixtures") ?? "/tmp/opengeni-timeline-turns-fixture.ndjson";
const webOrigin = argument("--web-origin") ?? "http://127.0.0.1:3001";
const cpuThrottleRate = integerArgument("--cpu-throttle", 4);
const profileInteractions = process.argv.includes("--profile");
const traceInteractions = process.argv.includes("--trace");
const scenarioArgument = argument("--scenario") ?? "feedback";
if (
  !["feedback", "acceptance", "rejection", "burst", "panel", "visibility"].includes(
    scenarioArgument,
  )
) {
  throw new Error(
    '--scenario must be "feedback", "acceptance", "rejection", "burst", "panel", or "visibility"',
  );
}
const scenario = scenarioArgument as Scenario;
if (!existsSync(fixtureFile)) throw new Error(`fixture file does not exist: ${fixtureFile}`);

const fixture = readFileSync(fixtureFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Fixture)[0];
if (!fixture) throw new Error("fixture file is empty");
if (fixture.shape !== "turns")
  throw new Error("composer benchmark requires a realistic turn fixture");

const expectedMarkers =
  Math.floor(fixture.eventCount / 4) * 2 + Math.min(fixture.eventCount % 4, 2);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    process.stderr.write(`[timeline benchmark page error] ${error.stack ?? String(error)}\n`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      process.stderr.write(`[timeline benchmark console error] ${message.text()}\n`);
    }
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottleRate });
  await cdp.send("Performance.enable");
  await page.addInitScript(() => {
    const entries: Array<{ duration: number; startTime: number }> = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        entries.push({ duration: entry.duration, startTime: entry.startTime });
      }
    }).observe({ type: "longtask", buffered: true });
    Object.defineProperty(window, "__timelineComposerLongTasks", { value: entries });
  });

  const url = `${webOrigin}/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("[data-og-timeline-scroller]").waitFor({ timeout: 60_000 });
  const timelineReadyMs = await page.evaluate(() => performance.now());
  await waitForMarkerCount(page, Math.min(250, expectedMarkers), "at-least", 120_000);
  let markers = await markerCount(page);
  for (let attempt = 0; markers < expectedMarkers && attempt < 20; attempt += 1) {
    const before = markers;
    const scroller = page.locator("[data-og-timeline-scroller]");
    const bounds = await scroller.boundingBox();
    if (!bounds) throw new Error("timeline scroller has no layout bounds");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, -1_000_000);
    markers = await waitForMarkerCount(page, before, "greater-than", 180_000);
    await settleFrames(page);
  }
  if (markers !== expectedMarkers) {
    throw new Error(`full history did not mount: ${markers}/${expectedMarkers} markers`);
  }
  const completeHistoryReadyMs = await page.evaluate(() => performance.now());
  await page.locator('textarea[aria-label="Message the agent"]').waitFor();
  await settleFrames(page);

  const intercepted: Array<{ method: string; url: string }> = [];
  const sessionApi = `**/v1/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}/**`;
  await page.route(sessionApi, async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      await route.continue();
      return;
    }
    intercepted.push({ method: request.method(), url: request.url() });
    if (request.url().endsWith("/composer-draft") && request.method() === "PUT") {
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const payload = request.postDataJSON() as {
        expectedRevision?: number;
        text: string;
        annotations?: unknown[];
        resources: unknown[];
        model: string;
        reasoningEffort: string;
        latencyMode?: string;
        sourceTurnId?: string | null;
        sourceTurnVersion?: number | null;
      };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          revision: (payload.expectedRevision ?? 0) + 1,
          text: payload.text,
          annotations: payload.annotations ?? [],
          resources: payload.resources,
          model: payload.model,
          reasoningEffort: payload.reasoningEffort,
          latencyMode: payload.latencyMode ?? "standard",
          sourceTurnId: payload.sourceTurnId ?? null,
          sourceTurnVersion: payload.sourceTurnVersion ?? null,
          updatedAt: new Date().toISOString(),
        }),
      });
      return;
    }
    if (
      scenario === "acceptance" &&
      request.url().endsWith("/events") &&
      request.method() === "POST"
    ) {
      const input = request.postDataJSON() as {
        type: string;
        clientEventId?: string;
        payload: unknown;
      };
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          id: crypto.randomUUID(),
          workspaceId: fixture.workspaceId,
          sessionId: fixture.sessionId,
          sequence: fixture.eventCount + 1,
          type: input.type,
          clientEventId: input.clientEventId ?? null,
          payload: input.payload,
          occurredAt: new Date().toISOString(),
        }),
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, scenario === "rejection" ? 800 : 5_000));
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "perf_probe", message: "Intentional perf probe" } }),
    });
  });

  const queue =
    scenario === "burst" || scenario === "visibility"
      ? null
      : await measureInteraction(
          page,
          cdp,
          "queue",
          scenario !== "panel",
          profileInteractions,
          traceInteractions,
        );
  const rejection = scenario === "rejection" && queue ? await measureRejection(page, queue) : null;
  const acceptance =
    scenario === "acceptance" && queue ? await measureAcceptance(page, queue) : null;
  await page.waitForTimeout(scenario === "feedback" ? 1_350 : scenario === "panel" ? 1_500 : 0);
  const panel = scenario === "panel" ? await measureQueuePanelOpen(page, cdp) : null;
  const steer =
    scenario === "feedback"
      ? await measureInteraction(page, cdp, "steer", true, profileInteractions, traceInteractions)
      : null;
  const burst = scenario === "burst" ? await measureBurst(page, cdp) : null;
  const visibility = scenario === "visibility" ? await measureVisibility(page, cdp) : null;
  const dom = (await cdp.send("Memory.getDOMCounters")) as {
    jsEventListeners: number;
    nodes: number;
  };
  const state = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
    return {
      markerCount: scroller?.textContent?.match(/Marker [UA]\d{5}/gu)?.length ?? 0,
      textChars: scroller?.textContent?.length ?? 0,
      horizontalOverflow: scroller ? Math.max(0, scroller.scrollWidth - scroller.clientWidth) : 0,
      scrollHeight: scroller?.scrollHeight ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
      groupCount: scroller?.querySelectorAll("[data-og-timeline-group-anchor]").length ?? 0,
    };
  });
  const receipt = {
    generatedAt: new Date().toISOString(),
    surface: "production session with complete realistic history mounted",
    fixture: { ...fixture, expectedMarkers },
    viewport: { width: 390, height: 844, mobile: true, touch: true },
    cpuThrottleRate,
    scenario,
    loadTiming: { timelineReadyMs, completeHistoryReadyMs },
    mutationSafety:
      scenario === "acceptance"
        ? "All non-GET session requests were intercepted. Draft PUTs and the user.message event received synthetic valid acknowledgements after 1200ms each. No mutation or model request reached the API."
        : "All non-GET session requests were intercepted. Draft PUTs received a synthetic valid acknowledgement after 1200ms; event and Steer requests received a synthetic failure after the scenario delay. No mutation or model request reached the API.",
    state,
    dom,
    steer,
    queue,
    acceptance,
    rejection,
    burst,
    panel,
    visibility,
    intercepted,
    assertions: {
      completeHistoryRetained: state.markerCount === expectedMarkers,
      noHorizontalOverflow: state.horizontalOverflow <= 1,
      ...(scenario === "feedback" && steer && queue
        ? {
            steerFeedbackUnder250Ms: steer.feedbackMs < 250,
            queueFeedbackUnder250Ms: queue.feedbackMs < 250,
          }
        : {}),
      ...(scenario === "rejection" && rejection
        ? {
            rejectedPromptRemainsVisible: rejection.promptInFailedTimeline,
            staleQueueReceiptRemoved: !rejection.promptInQueue,
            retryAndRemoveAvailable: rejection.retryVisible && rejection.removeVisible,
          }
        : {}),
      ...(scenario === "acceptance" && acceptance
        ? {
            acceptedPromptAppearsExactlyOnceInTimeline: acceptance.timelineCopies === 1,
            acceptedPromptRetainsQueueReceipt:
              acceptance.promptInQueue && acceptance.queueLabel?.includes("queued prompt") === true,
            acceptedPromptHasNoFailedActions: !acceptance.retryVisible && !acceptance.removeVisible,
            acceptedRequestObserved: intercepted.some(
              ({ method, url: requestUrl }) => method === "POST" && requestUrl.endsWith("/events"),
            ),
          }
        : {}),
      ...(scenario === "burst" && burst
        ? {
            allBurstReceiptsVisible: burst.rows.length === burst.prompts.length,
            burstOrderPreserved: burst.rows.every((row, index) =>
              row.text.includes(burst.prompts[index] ?? "missing-prompt"),
            ),
          }
        : {}),
      ...(scenario === "panel" && panel
        ? {
            panelUsesRequestedPlacement: panel.placement === null,
            panelOpenFeedbackUnder250Ms: panel.openMs < 250,
          }
        : {}),
      ...(scenario === "visibility" && visibility
        ? {
            farHistoryFindable: visibility.found && visibility.selectedTextIncludesMarker,
            farHistoryIsAccessible: visibility.accessibilityNameFound,
            findRevealsExactGroup: visibility.markerWithinViewport,
            returnToTipIsExact: visibility.distanceFromTipAfterReturn <= 1,
          }
        : {}),
    },
  };
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (!Object.values(receipt.assertions).every(Boolean)) process.exitCode = 1;
  await cdp.detach();
  await context.close();
} finally {
  await browser.close();
}

async function measureVisibility(page: Page, cdp: CDPSession) {
  const target = "Marker U00001";
  const before = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
    return {
      scrollHeight: scroller?.scrollHeight ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
    };
  });
  const findStartedAt = await page.evaluate(() => performance.now());
  const found = await page.evaluate(
    (text) =>
      (
        window as unknown as Window & {
          find: (
            text: string,
            caseSensitive: boolean,
            backwards: boolean,
            wrap: boolean,
          ) => boolean;
        }
      ).find(text, false, false, true),
    target,
  );
  await settleFrames(page);
  const findObservedAt = await page.evaluate(() => performance.now());
  await page.evaluate(() => {
    window
      .getSelection()
      ?.anchorNode?.parentElement?.closest<HTMLElement>("[data-og-timeline-group-anchor]")
      ?.scrollIntoView({ block: "center" });
  });
  await settleFrames(page);
  const afterFind = await page.evaluate((text) => {
    const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
    const selection = window.getSelection();
    const selectedNode = selection?.anchorNode?.parentElement;
    const group = selectedNode?.closest<HTMLElement>("[data-og-timeline-group-anchor]");
    const groupRect = group?.getBoundingClientRect();
    const scrollerRect = scroller?.getBoundingClientRect();
    return {
      scrollHeight: scroller?.scrollHeight ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
      selectedTextIncludesMarker: selection?.toString().includes(text) ?? false,
      markerWithinViewport: Boolean(
        groupRect &&
        scrollerRect &&
        groupRect.bottom >= scrollerRect.top &&
        groupRect.top <= scrollerRect.bottom,
      ),
    };
  }, target);
  await cdp.send("Accessibility.enable");
  const accessibility = (await cdp.send("Accessibility.getFullAXTree")) as {
    nodes: Array<{ name?: { value?: string } }>;
  };
  const accessibilityNameFound = accessibility.nodes.some(({ name }) =>
    name?.value?.includes(target),
  );
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await settleFrames(page);
  const afterReturn = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
    return {
      scrollHeight: scroller?.scrollHeight ?? 0,
      scrollTop: scroller?.scrollTop ?? 0,
      distanceFromTip: scroller
        ? Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
        : Number.POSITIVE_INFINITY,
    };
  });
  return {
    target,
    found,
    findMs: findObservedAt - findStartedAt,
    accessibilityNameFound,
    ...afterFind,
    before,
    afterReturn,
    distanceFromTipAfterReturn: afterReturn.distanceFromTip,
  };
}

async function measureAcceptance(
  page: Page,
  queue: Awaited<ReturnType<typeof measureInteraction>>,
) {
  const startedAt = await page.evaluate(() => performance.now());
  await page.waitForFunction(
    (expected) => {
      const queueSignal = document.querySelector('[data-og-session-chrome-signal="queue"]');
      return (
        document.querySelector("[data-og-timeline-scroller]")?.textContent?.includes(expected) ===
          true && queueSignal?.textContent?.includes("queued prompt") === true
      );
    },
    queue.prompt,
    { timeout: 15_000, polling: 10 },
  );
  const observedAt = await page.evaluate(() => performance.now());
  return await page.evaluate(
    ({ expected, elapsedMs }) => {
      const timeline = document.querySelector("[data-og-timeline-scroller]");
      const queueSignal = document.querySelector('[data-og-session-chrome-signal="queue"]');
      const timelineText = timeline?.textContent ?? "";
      const deliveryFooter = [...(timeline?.querySelectorAll("button") ?? [])].filter((button) =>
        button.parentElement?.parentElement?.textContent?.includes(expected),
      );
      return {
        prompt: expected,
        settledAfterFeedbackMs: elapsedMs,
        timelineCopies: timelineText.split(expected).length - 1,
        promptInQueue: queueSignal?.textContent?.includes(expected) ?? false,
        queueLabel: queueSignal?.textContent?.trim() ?? null,
        retryVisible: deliveryFooter.some((button) => button.textContent?.trim() === "Retry"),
        removeVisible: deliveryFooter.some((button) => button.textContent?.trim() === "Remove"),
      };
    },
    { expected: queue.prompt, elapsedMs: observedAt - startedAt },
  );
}

async function measureQueuePanelOpen(page: Page, cdp: CDPSession) {
  const before = await performanceMetrics(cdp);
  const startedAt = await page.evaluate(() => performance.now());
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>('[data-og-session-chrome-signal="queue"]')?.click();
  });
  await page.waitForFunction(
    () => document.querySelectorAll("[data-queue-client-event-id]").length === 1,
    undefined,
    { timeout: 15_000, polling: 10 },
  );
  const observedAt = await page.evaluate(() => performance.now());
  const after = await performanceMetrics(cdp);
  return await page.evaluate(
    ({ openMs, metrics }) => {
      const shell = document.querySelector<HTMLElement>("[data-og-session-chrome-panel-shell]");
      const scroller = document.querySelector<HTMLElement>("[data-og-timeline-scroller]");
      return {
        openMs,
        metrics,
        placement: shell?.dataset.ogSessionChromePanelPlacement ?? null,
        position: shell ? getComputedStyle(shell).position : null,
        contain: shell ? getComputedStyle(shell).contain : null,
        panelRect: shell?.getBoundingClientRect().toJSON() ?? null,
        scrollerRect: scroller?.getBoundingClientRect().toJSON() ?? null,
      };
    },
    { openMs: observedAt - startedAt, metrics: metricDelta(before, after) },
  );
}

async function measureRejection(page: Page, queue: Awaited<ReturnType<typeof measureInteraction>>) {
  const startedAt = await page.evaluate(() => performance.now());
  await page.waitForFunction(
    (expected) => {
      const timeline = document.querySelector("[data-og-timeline-scroller]");
      return [...(timeline?.querySelectorAll("button") ?? [])].some(
        (button) =>
          button.textContent?.trim() === "Retry" &&
          button.parentElement?.parentElement?.textContent?.includes(expected),
      );
    },
    queue.prompt,
    { timeout: 15_000, polling: 10 },
  );
  const observedAt = await page.evaluate(() => performance.now());
  return await page.evaluate(
    ({ expected, elapsedMs }) => {
      const timeline = document.querySelector("[data-og-timeline-scroller]");
      const queueSignal = document.querySelector('[data-og-session-chrome-signal="queue"]');
      const failedFooter = [...(timeline?.querySelectorAll("button") ?? [])].find(
        (button) =>
          button.textContent?.trim() === "Retry" &&
          button.parentElement?.parentElement?.textContent?.includes(expected),
      )?.parentElement;
      return {
        prompt: expected,
        settledAfterFeedbackMs: elapsedMs,
        promptInFailedTimeline: timeline?.textContent?.includes(expected) ?? false,
        promptInQueue: queueSignal?.textContent?.includes(expected) ?? false,
        retryVisible:
          [...(failedFooter?.querySelectorAll("button") ?? [])].some(
            (button) => button.textContent?.trim() === "Retry",
          ) ?? false,
        removeVisible:
          [...(failedFooter?.querySelectorAll("button") ?? [])].some(
            (button) => button.textContent?.trim() === "Remove",
          ) ?? false,
      };
    },
    { expected: queue.prompt, elapsedMs: observedAt - startedAt },
  );
}

async function measureBurst(page: Page, cdp: CDPSession) {
  const prompts = Array.from({ length: 3 }, () => `burst-huge-history-${crypto.randomUUID()}`);
  const feedback: Array<{ prompt: string; visibleSurface: "collapsed" | "expanded"; ms: number }> =
    [];
  let firstExpandedRowMs: number | null = null;
  let firstExpandedRowMetrics: Record<string, number> | null = null;
  let firstPanelStartMetrics: Record<string, number> | null = null;
  for (const [index, prompt] of prompts.entries()) {
    await focusComposer(page);
    await page.keyboard.insertText(prompt);
    const startedAt = await page.evaluate(() => performance.now());
    await page.keyboard.press("Enter");
    if (index === 0) {
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector('[data-og-session-chrome-signal="queue"]')
            ?.textContent?.includes(expected),
        prompt,
        { timeout: 15_000, polling: 10 },
      );
      const collapsedObservedAt = await page.evaluate(() => performance.now());
      feedback.push({
        prompt,
        visibleSurface: "collapsed",
        ms: collapsedObservedAt - startedAt,
      });
      firstPanelStartMetrics = await performanceMetrics(cdp);
      await page.evaluate(() => {
        const signal = document.querySelector<HTMLButtonElement>(
          '[data-og-session-chrome-signal="queue"]',
        );
        signal?.click();
      });
    }
    await page.waitForFunction(
      (expectedCount) =>
        document.querySelectorAll("[data-queue-client-event-id]").length === expectedCount,
      index + 1,
      { timeout: 15_000, polling: 10 },
    );
    const observedAt = await page.evaluate(() => performance.now());
    if (index === 0) {
      firstExpandedRowMs = observedAt - startedAt;
      firstExpandedRowMetrics = metricDelta(
        firstPanelStartMetrics ?? {},
        await performanceMetrics(cdp),
      );
    } else {
      feedback.push({ prompt, visibleSurface: "expanded", ms: observedAt - startedAt });
    }
  }
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-queue-client-event-id]")].map((row) => ({
      clientEventId: row.dataset.queueClientEventId ?? null,
      text: row.textContent ?? "",
      interactive: row.querySelector("button") !== null,
    })),
  );
  const metrics = await performanceMetrics(cdp);
  return {
    prompts,
    feedback,
    firstExpandedRowMs,
    firstExpandedRowMetrics,
    rows,
    queueSignal: await page.locator('[data-og-session-chrome-signal="queue"]').textContent(),
    jsHeapUsedSize: metrics.JSHeapUsedSize,
  };
}

async function measureInteraction(
  page: Page,
  cdp: CDPSession,
  action: "queue" | "steer",
  waitForTimeline = true,
  profile = false,
  trace = false,
) {
  const prompt = `${action}-huge-history-${crypto.randomUUID()}`;
  await focusComposer(page);
  const beforeFillMetrics = await performanceMetrics(cdp);
  const fillStartedAt = await page.evaluate(() => performance.now());
  await page.keyboard.insertText(prompt);
  const fillObservedAt = await page.evaluate(() => performance.now());
  const afterFillMetrics = await performanceMetrics(cdp);
  await settleFrames(page);
  const beforeSubmit = await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message the agent"]',
    );
    const send = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Send message"], button[aria-label="Send and resume"]',
    );
    return {
      draft: input?.value ?? null,
      inputDisabled: input?.disabled ?? null,
      sendDisabled: send?.disabled ?? null,
    };
  });
  const longTaskStart = await page.evaluate(
    () =>
      (
        window as unknown as {
          __timelineComposerLongTasks: Array<{ duration: number; startTime: number }>;
        }
      ).__timelineComposerLongTasks.length,
  );
  const beforeSubmitMetrics = await performanceMetrics(cdp);
  const timelineTrace = trace ? await startTimelineTrace(cdp) : null;
  if (profile) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 250 });
    await cdp.send("Profiler.start");
  }
  const startedAt = await page.evaluate(() => performance.now());
  await page.keyboard.press(action === "steer" ? "Control+Enter" : "Enter");
  let feedbackTimedOut = false;
  try {
    if (action === "steer") {
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector('[data-og-session-chrome-signal="steering"]')
            ?.textContent?.includes(expected),
        prompt,
        { timeout: 15_000, polling: 10 },
      );
    } else {
      await page.waitForFunction(
        (expected) =>
          document
            .querySelector('[data-og-session-chrome-signal="queue"]')
            ?.textContent?.includes(expected),
        prompt,
        { timeout: 15_000, polling: 10 },
      );
    }
  } catch {
    feedbackTimedOut = true;
  }
  const observedAt = await page.evaluate(() => performance.now());
  const traceSummary = timelineTrace ? await timelineTrace.stop() : null;
  const cpuProfile = profile
    ? summarizeCpuProfile((await cdp.send("Profiler.stop")) as CpuProfileResult)
    : null;
  const afterFeedbackMetrics = await performanceMetrics(cdp);
  const feedbackState = await page.evaluate(
    ({ expected, kind, longTaskOffset }) => {
      const entries = (
        window as unknown as {
          __timelineComposerLongTasks: Array<{ duration: number; startTime: number }>;
        }
      ).__timelineComposerLongTasks.slice(longTaskOffset);
      const timeline = document.querySelector("[data-og-timeline-scroller]");
      const steering = document.querySelector('[data-og-session-chrome-signal="steering"]');
      const queue = document.querySelector('[data-og-session-chrome-signal="queue"]');
      const optimisticTimelineRows = [
        ...(timeline?.querySelectorAll<HTMLElement>('[data-og-group-key*="optimistic:"]') ?? []),
      ];
      const input = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message the agent"]',
      );
      const promptInTimeline = optimisticTimelineRows.some((row) =>
        row.textContent?.includes(expected),
      );
      const promptInSteering = steering?.textContent?.includes(expected) ?? false;
      const promptInQueue = queue?.textContent?.includes(expected) ?? false;
      return {
        promptCopies: Number(promptInTimeline) + Number(promptInSteering) + Number(promptInQueue),
        promptInTimeline,
        promptInSteering,
        promptInQueue,
        draftAfterFeedback: input?.value ?? null,
        longTasks: entries,
        expectedSurfaceVisible:
          kind === "queue"
            ? (queue?.textContent?.includes(expected) ?? false)
            : (steering?.textContent?.includes(expected) ?? false),
      };
    },
    { expected: prompt, kind: action, longTaskOffset: longTaskStart },
  );
  let timelineAppendTimedOut = false;
  if (action === "queue" && waitForTimeline && !feedbackState.promptInTimeline) {
    try {
      await page.waitForFunction(
        (expected) =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[data-og-timeline-scroller] [data-og-group-key*="optimistic:"]',
            ),
          ].some((row) => row.textContent?.includes(expected)),
        prompt,
        { timeout: 15_000, polling: 10 },
      );
    } catch {
      timelineAppendTimedOut = true;
    }
  }
  const timelineObservedAt = await page.evaluate(() => performance.now());
  return {
    action,
    fillMs: fillObservedAt - fillStartedAt,
    fillMetrics: metricDelta(beforeFillMetrics, afterFillMetrics),
    feedbackMs: observedAt - startedAt,
    feedbackMetrics: metricDelta(beforeSubmitMetrics, afterFeedbackMetrics),
    cpuProfile,
    trace: traceSummary,
    feedbackTimedOut,
    ...(action === "queue" && waitForTimeline
      ? {
          timelineAppendMs: timelineObservedAt - startedAt,
          timelineAppendTimedOut,
        }
      : {}),
    beforeSubmit,
    prompt,
    ...feedbackState,
  };
}

type TimelineTraceEvent = {
  name?: string | undefined;
  cat?: string | undefined;
  ph?: string | undefined;
  dur?: number | undefined;
};

async function startTimelineTrace(cdp: CDPSession) {
  const events: TimelineTraceEvent[] = [];
  const collect = (payload: { value: TimelineTraceEvent[] }) => events.push(...payload.value);
  cdp.on("Tracing.dataCollected", collect);
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline,blink.user_timing",
    transferMode: "ReportEvents",
  });
  return {
    stop: async () => {
      const complete = new Promise<void>((resolve) => {
        cdp.once("Tracing.tracingComplete", () => resolve());
      });
      await cdp.send("Tracing.end");
      await complete;
      cdp.off("Tracing.dataCollected", collect);
      return summarizeTimelineTrace(events);
    },
  };
}

function summarizeTimelineTrace(events: TimelineTraceEvent[]) {
  const completed = events.filter(
    (event): event is TimelineTraceEvent & { name: string; dur: number } =>
      event.ph === "X" && typeof event.name === "string" && typeof event.dur === "number",
  );
  const totals = new Map<string, { count: number; totalMicros: number; maxMicros: number }>();
  for (const event of completed) {
    const current = totals.get(event.name) ?? { count: 0, totalMicros: 0, maxMicros: 0 };
    current.count += 1;
    current.totalMicros += event.dur;
    current.maxMicros = Math.max(current.maxMicros, event.dur);
    totals.set(event.name, current);
  }
  return {
    eventCount: events.length,
    topTotals: [...totals.entries()]
      .map(([name, value]) => ({
        name,
        count: value.count,
        totalMs: value.totalMicros / 1_000,
        maxMs: value.maxMicros / 1_000,
      }))
      .sort((left, right) => right.totalMs - left.totalMs)
      .slice(0, 20),
    longest: completed
      .map((event) => ({ name: event.name, durationMs: event.dur / 1_000 }))
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 20),
  };
}

type CpuProfileResult = {
  profile: {
    nodes: Array<{
      id: number;
      callFrame: {
        functionName: string;
        url: string;
        lineNumber: number;
        columnNumber: number;
      };
    }>;
    samples?: number[] | undefined;
    timeDeltas?: number[] | undefined;
  };
};

function summarizeCpuProfile(result: CpuProfileResult) {
  const nodesById = new Map(result.profile.nodes.map((node) => [node.id, node]));
  const sampledMicrosById = new Map<number, number>();
  const samples = result.profile.samples ?? [];
  const timeDeltas = result.profile.timeDeltas ?? [];
  for (let index = 0; index < samples.length; index += 1) {
    const id = samples[index];
    if (id === undefined) continue;
    sampledMicrosById.set(id, (sampledMicrosById.get(id) ?? 0) + (timeDeltas[index] ?? 0));
  }
  const sampledMs = [...sampledMicrosById.values()].reduce((sum, value) => sum + value, 0) / 1_000;
  const top = [...sampledMicrosById.entries()]
    .map(([id, sampledMicros]) => {
      const frame = nodesById.get(id)?.callFrame;
      return {
        sampledMs: sampledMicros / 1_000,
        functionName: frame?.functionName || "(anonymous)",
        url: frame?.url ?? "",
        line: (frame?.lineNumber ?? -1) + 1,
        column: (frame?.columnNumber ?? -1) + 1,
      };
    })
    .sort((left, right) => right.sampledMs - left.sampledMs)
    .slice(0, 20);
  return {
    sampledMs,
    top,
  };
}

async function performanceMetrics(cdp: CDPSession): Promise<Record<string, number>> {
  const result = (await cdp.send("Performance.getMetrics")) as {
    metrics: Array<{ name: string; value: number }>;
  };
  return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
}

function metricDelta(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const names = [
    "TaskDuration",
    "ScriptDuration",
    "LayoutDuration",
    "RecalcStyleDuration",
    "LayoutCount",
    "RecalcStyleCount",
    "JSHeapUsedSize",
    "Nodes",
  ];
  return Object.fromEntries(names.map((name) => [name, (after[name] ?? 0) - (before[name] ?? 0)]));
}

async function markerCount(page: Page): Promise<number> {
  return await page.evaluate(
    () =>
      document
        .querySelector("[data-og-timeline-scroller]")
        ?.textContent?.match(/Marker [UA]\d{5}/gu)?.length ?? 0,
  );
}

async function waitForMarkerCount(
  page: Page,
  threshold: number,
  comparison: "at-least" | "greater-than",
  timeoutMs: number,
): Promise<number> {
  const handle = await page.waitForFunction(
    ({ expected, mode }) => {
      const count =
        document
          .querySelector("[data-og-timeline-scroller]")
          ?.textContent?.match(/Marker [UA]\d{5}/gu)?.length ?? 0;
      return (mode === "at-least" ? count >= expected : count > expected) ? count : false;
    },
    { expected: threshold, mode: comparison },
    { timeout: timeoutMs, polling: 50 },
  );
  return (await handle.jsonValue()) as number;
}

async function focusComposer(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message the agent"]',
    );
    input?.focus();
    return {
      focused: document.activeElement === input,
      href: location.href,
      inputCount: document.querySelectorAll('textarea[aria-label="Message the agent"]').length,
      tail: document.body.textContent?.slice(-1_000) ?? "",
    };
  });
  if (!result.focused) {
    throw new Error(`composer textarea could not be focused: ${JSON.stringify(result)}`);
  }
}

async function settleFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function integerArgument(name: string, fallback: number): number {
  const value = argument(name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error(`${name} must be an integer between 1 and 20`);
  }
  return parsed;
}
