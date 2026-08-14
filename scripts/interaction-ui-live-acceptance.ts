import type {
  BrowserObservation,
  BrowserSessionResource,
  InteractionSemanticNode,
} from "@opengeni/sdk";
import { chromium, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInteractionUiFixture } from "./interaction-ui-live-fixture";

type Metric =
  | "browserFirstFrame"
  | "browserTypeVisible"
  | "browserPasteVisible"
  | "browserReconnect"
  | "computerFirstFrame"
  | "computerTypeVisible"
  | "computerPasteVisible"
  | "computerReconnect";

const output = resolve(
  process.env.OPENGENI_INTERACTION_UI_OUTPUT ??
    `.agent/evidence/interaction-ui-live-${Date.now()}.json`,
);
const webOrigin = new URL(process.env.OPENGENI_INTERACTION_UI_WEB_URL ?? "http://127.0.0.1:3200")
  .origin;
const fixture = await createInteractionUiFixture();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1_440, height: 900 } });
await context.grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: webOrigin,
});
const page = await context.newPage();
const checks: string[] = [];
const timings: Partial<Record<Metric, number>> = {};
const diagnostics: {
  computerActions: Array<{
    operation: string | null;
    request: unknown;
    response: unknown;
    status: number | null;
  }>;
  computerClipboardReads: Array<{ response: unknown; status: number | null }>;
  computerTypeFailure: unknown;
  computerPasteFailure: unknown;
  consoleErrors: string[];
  failedResponses: Array<{ status: number; url: string }>;
  pageErrors: string[];
  rfbFramesSent: string[];
} = {
  computerActions: [],
  computerClipboardReads: [],
  computerTypeFailure: null,
  computerPasteFailure: null,
  consoleErrors: [],
  failedResponses: [],
  pageErrors: [],
  rfbFramesSent: [],
};
page.on("console", (message) => {
  if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
});
page.on("pageerror", (error) => diagnostics.pageErrors.push(error.message));
page.on("response", (response) => {
  if (response.status() < 400) return;
  diagnostics.failedResponses.push({ status: response.status(), url: response.url() });
});
page.on("websocket", (socket) => {
  if (!socket.url().includes("/rfb")) return;
  socket.on("framesent", ({ payload }) => {
    const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    if (bytes.byteLength <= 16 && diagnostics.rfbFramesSent.length < 200) {
      diagnostics.rfbFramesSent.push(Buffer.from(bytes).toString("hex"));
    }
  });
});
page.on("request", (request) => {
  const pathname = new URL(request.url()).pathname;
  if (/\/computer-sessions\/[^/]+\/clipboard$/.test(pathname)) {
    const entry: (typeof diagnostics.computerClipboardReads)[number] = {
      response: null,
      status: null,
    };
    diagnostics.computerClipboardReads.push(entry);
    void request.response().then(async (response) => {
      entry.status = response?.status() ?? null;
      entry.response = response ? await response.json().catch(() => null) : null;
    });
    return;
  }
  if (!/\/computer-sessions\/[^/]+\/actions$/.test(pathname)) return;
  let operation: string | null = null;
  let requestBody: unknown = null;
  try {
    const body = request.postDataJSON() as { action?: { operation?: unknown } };
    requestBody = body;
    operation = typeof body.action?.operation === "string" ? body.action.operation : null;
  } catch {
    // Diagnostics must never make the acceptance path fail.
  }
  const entry: (typeof diagnostics.computerActions)[number] = {
    operation,
    request: requestBody,
    response: null,
    status: null,
  };
  diagnostics.computerActions.push(entry);
  void request.response().then(async (response) => {
    entry.status = response?.status() ?? null;
    entry.response = response ? await response.json().catch(() => null) : null;
  });
});

try {
  await page.goto(
    new URL(`/workspaces/${fixture.workspaceId}/sessions/${fixture.sessionId}`, `${webOrigin}/`)
      .href,
    { waitUntil: "domcontentloaded" },
  );
  const browserTab = page.getByRole("tab", { name: "Browser", exact: true });
  const showPanel = page.getByRole("button", { name: "Show session panel", exact: true });
  const dockDeadline = performance.now() + 15_000;
  while (!(await browserTab.isVisible().catch(() => false))) {
    if (await showPanel.isVisible().catch(() => false)) await showPanel.click();
    if (performance.now() >= dockDeadline) throw new Error("session dock did not become visible");
    await page.waitForTimeout(100);
  }

  let started = performance.now();
  await browserTab.click();
  const browserCanvas = page.locator('canvas[aria-label="Interactive browser page"]');
  await waitForPaintedCanvas(page, browserCanvas);
  timings.browserFirstFrame = performance.now() - started;
  checks.push("browser.ui-first-frame");

  const browserResource = fixture.client.interaction.browsers.session(
    fixture.workspaceId,
    fixture.browserSessionId,
  );
  const initial = await currentBrowserObservation(browserResource);
  await focusAcceptanceInput(browserResource, initial);
  const browserMarker = `UI_BROWSER_${Date.now()}_Ω`;
  started = performance.now();
  await clickCanvasFraction(browserCanvas, 0.5, 0.4);
  await page.keyboard.type(browserMarker);
  await waitForBrowserValue(browserResource, browserMarker);
  timings.browserTypeVisible = performance.now() - started;
  checks.push("browser.ui-type-exact");

  const browserPasteMarker = `UI_BROWSER_PASTE_${Date.now()}_λ`;
  await copyThroughComposer(page, browserPasteMarker);
  started = performance.now();
  await clickCanvasFraction(browserCanvas, 0.5, 0.4);
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Meta+V");
  await waitForBrowserValue(browserResource, browserPasteMarker);
  timings.browserPasteVisible = performance.now() - started;
  checks.push("browser.ui-paste-exact");

  const selectedBeforeTabs = await currentBrowserObservation(browserResource);
  const originalTargetId = selectedBeforeTabs.target.id;
  const originalTargetTitle = selectedBeforeTabs.target.title;
  const second = await browserResource.tabs.open(
    `data:text/html;charset=utf-8,${encodeURIComponent("<!doctype html><title>UI second target</title><h1>UI_SECOND_TARGET</h1>")}`,
  );
  await page.getByRole("button", { name: second.target.title, exact: true }).waitFor({
    state: "visible",
    timeout: 5_000,
  });
  await page.getByRole("button", { name: originalTargetTitle, exact: true }).click();
  await waitForSelectedTarget(browserResource, originalTargetId);
  await page.getByRole("button", { name: second.target.title, exact: true }).click();
  await waitForSelectedTarget(browserResource, second.target.id);
  checks.push("browser.ui-tab-selection-exact");

  started = performance.now();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("tab", { name: "Browser", exact: true }).click();
  await waitForPaintedCanvas(page, browserCanvas);
  timings.browserReconnect = performance.now() - started;
  checks.push("browser.ui-reconnect");

  await browserResource.tabs.select(originalTargetId);
  const computerResource = fixture.client.interaction.computers.session(
    fixture.workspaceId,
    fixture.computerSessionId,
  );
  const computerTargets = await computerResource.targets.list();
  const computerWindow =
    computerTargets.targets.find((target) => target.kind === "window" && target.focused) ??
    computerTargets.targets.find((target) => target.kind === "window");
  if (!computerWindow) throw new Error("UI fixture computer has no Chromium window");
  let computerObservation = await computerResource.observe(computerWindow.id);
  const inputNode = findSemanticNode(
    computerObservation,
    (node) => node.role === "entry" && node.name === "Acceptance input",
  );
  const focused = await computerResource.act({
    operationId: crypto.randomUUID(),
    targetId: computerObservation.target.id,
    expectedTargetGeneration: computerObservation.target.targetGeneration,
    expectedObservationId: computerObservation.observationId,
    expectedFrameId: null,
    action: { type: "semantic", locator: { kind: "ref", ref: inputNode.ref }, action: "focus" },
  });
  if (focused.state !== "completed") throw new Error("computer semantic focus failed");

  started = performance.now();
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  const desktop = page.locator('[data-opengeni-desktop][data-ui-state="connected"]');
  await desktop.waitFor({ state: "visible", timeout: 7_500 });
  const desktopCanvas = page.locator("[data-opengeni-desktop-canvas] canvas");
  await waitForPaintedCanvas(page, desktopCanvas);
  timings.computerFirstFrame = performance.now() - started;
  checks.push("computer.ui-first-frame");

  const computerMarker = `uicomputer${Date.now()}`;
  started = performance.now();
  await ensureDesktopControl(desktop);
  await clickCanvasFraction(desktopCanvas, 0.5, 0.47);
  await page.keyboard.press("Meta+A");
  await page.keyboard.type(computerMarker);
  try {
    await waitForBrowserValue(browserResource, computerMarker);
  } catch (cause) {
    diagnostics.computerTypeFailure = {
      observation: await currentBrowserObservation(browserResource),
      activeElement: await page.evaluate(() => ({
        ariaLabel: document.activeElement?.getAttribute("aria-label") ?? null,
        className:
          document.activeElement instanceof HTMLElement ? document.activeElement.className : null,
        tagName: document.activeElement?.tagName ?? null,
      })),
      desktopState: {
        inControl: await desktop.getAttribute("data-in-control"),
        state: await desktop.getAttribute("data-state"),
        targetPlatform: await desktop.getAttribute("data-target-platform"),
        uiState: await desktop.getAttribute("data-ui-state"),
      },
      hostPlatform: await page.evaluate(() => navigator.platform),
      targets: await computerResource.targets.list(),
    };
    throw cause;
  }
  timings.computerTypeVisible = performance.now() - started;
  checks.push("computer.ui-type-exact");

  const computerPasteMarker = `uicomputerpaste${Date.now()}z`;
  await copyThroughComposer(page, computerPasteMarker);
  started = performance.now();
  await ensureDesktopControl(desktop);
  await clickCanvasFraction(desktopCanvas, 0.5, 0.47);
  await page.keyboard.press("Meta+A");
  const pasteAccepted = await desktop.evaluate((element, value) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", value);
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, computerPasteMarker);
  if (!pasteAccepted) throw new Error("live desktop did not accept the browser paste event");
  try {
    await waitForBrowserValue(browserResource, computerPasteMarker);
  } catch (cause) {
    const afterPaste = await currentBrowserObservation(browserResource);
    const activeElementBeforeProbe = await page.evaluate(() => ({
      ariaLabel: document.activeElement?.getAttribute("aria-label") ?? null,
      className:
        document.activeElement instanceof HTMLElement ? document.activeElement.className : null,
      tagName: document.activeElement?.tagName ?? null,
    }));
    const focusProbe = `focusprobe${Date.now()}q`;
    await page.keyboard.type(focusProbe);
    const focusProbeReached = await browserContainsWithin(browserResource, focusProbe, 1_500);
    const refocusProbe = `refocusprobe${Date.now()}r`;
    await desktopCanvas.focus();
    await page.keyboard.type(refocusProbe);
    const refocusProbeReached = await browserContainsWithin(browserResource, refocusProbe, 1_500);
    await page.keyboard.press("Control+V");
    const secondPasteReached = await browserContainsWithin(
      browserResource,
      computerPasteMarker,
      1_500,
    );
    diagnostics.computerPasteFailure = {
      afterPaste,
      activeElementBeforeProbe,
      desktopState: {
        inControl: await desktop.getAttribute("data-in-control"),
        uiState: await desktop.getAttribute("data-ui-state"),
      },
      focusProbe,
      focusProbeReached,
      refocusProbe,
      refocusProbeReached,
      secondPasteReached,
      targets: await computerResource.targets.list(),
    };
    throw cause;
  }
  timings.computerPasteVisible = performance.now() - started;
  checks.push("computer.ui-paste-exact");

  started = performance.now();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("tab", { name: "Computer", exact: true }).click();
  await desktop.waitFor({ state: "visible", timeout: 6_000 });
  await waitForPaintedCanvas(page, desktopCanvas);
  timings.computerReconnect = performance.now() - started;
  checks.push("computer.ui-reconnect");

  const browserErrors = await page.evaluate(() =>
    performance.getEntriesByType("resource").filter((entry) => entry.name.includes("undefined")),
  );
  if (browserErrors.length > 0) throw new Error("UI requested an undefined resource URL");
  checks.push("ui.no-undefined-resource");
  if (diagnostics.pageErrors.length > 0) {
    throw new Error(`UI raised page errors: ${diagnostics.pageErrors.join("; ")}`);
  }
  const unexpectedResponses = diagnostics.failedResponses.filter(
    ({ status, url }) =>
      status !== 404 ||
      !/\/v1\/workspaces\/[^/]+\/sessions\/[^/]+\/goal$/.test(new URL(url).pathname),
  );
  if (unexpectedResponses.length > 0) {
    throw new Error(`UI received unexpected HTTP failures: ${JSON.stringify(unexpectedResponses)}`);
  }
  const genericResourceErrors = diagnostics.consoleErrors.filter(
    (message) =>
      message === "Failed to load resource: the server responded with a status of 404 (Not Found)",
  );
  const unexpectedConsoleErrors = diagnostics.consoleErrors.filter(
    (message) => !genericResourceErrors.includes(message),
  );
  if (
    unexpectedConsoleErrors.length > 0 ||
    genericResourceErrors.length > diagnostics.failedResponses.length
  ) {
    throw new Error(`UI raised console errors: ${diagnostics.consoleErrors.join("; ")}`);
  }
  checks.push("ui.only-expected-optional-404s");
  checks.push("ui.no-runtime-errors");

  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: "opengeni/interaction-ui-live-acceptance/v1",
        generatedAt: new Date().toISOString(),
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        browserSessionId: fixture.browserSessionId,
        computerSessionId: fixture.computerSessionId,
        timings,
        checks,
        diagnostics,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ status: "passed", output, timings, checks }) + "\n");
} catch (cause) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify(
      {
        schemaVersion: "opengeni/interaction-ui-live-acceptance/v1",
        generatedAt: new Date().toISOString(),
        status: "failed",
        error: cause instanceof Error ? cause.message : String(cause),
        workspaceId: fixture.workspaceId,
        sessionId: fixture.sessionId,
        browserSessionId: fixture.browserSessionId,
        computerSessionId: fixture.computerSessionId,
        timings,
        checks,
        diagnostics,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  process.stderr.write(`${JSON.stringify({ status: "failed", output, diagnostics })}\n`);
  throw cause;
} finally {
  await page.close().catch(() => undefined);
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await fixture.dispose();
}

async function waitForPaintedCanvas(
  playwrightPage: Page,
  canvas: import("playwright").Locator,
): Promise<void> {
  await canvas.waitFor({ state: "visible", timeout: 7_500 });
  await playwrightPage.waitForFunction(
    (selector) => {
      const element = document.querySelector(selector);
      return element instanceof HTMLCanvasElement && element.width > 0 && element.height > 0;
    },
    await canvas
      .getAttribute("aria-label")
      .then((label) =>
        label
          ? `canvas[aria-label=${JSON.stringify(label)}]`
          : "[data-opengeni-desktop-canvas] canvas",
      ),
    { timeout: 7_500 },
  );
}

async function clickCanvasFraction(
  canvas: import("playwright").Locator,
  xFraction: number,
  yFraction: number,
): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error("live interaction canvas has no visible bounds");
  await canvas.page().mouse.click(box.x + box.width * xFraction, box.y + box.height * yFraction);
}

async function copyThroughComposer(playwrightPage: Page, value: string): Promise<void> {
  const composer = playwrightPage.getByRole("textbox", { name: "Message the agent", exact: true });
  await composer.fill(value);
  await composer.press("Meta+A");
  await composer.press("Meta+C");
  const copied = await playwrightPage.evaluate(() => navigator.clipboard.readText());
  if (copied !== value)
    throw new Error("browser did not place the exact composer selection on clipboard");
  await composer.fill("");
}

async function ensureDesktopControl(desktop: import("playwright").Locator): Promise<void> {
  if ((await desktop.getAttribute("data-in-control")) === "true") return;
  await desktop.getByRole("button", { name: "Take control of the desktop", exact: true }).click();
  const deadline = performance.now() + 3_000;
  while ((await desktop.getAttribute("data-in-control")) !== "true") {
    if (performance.now() >= deadline) throw new Error("desktop did not grant local input control");
    await Bun.sleep(25);
  }
}

async function currentBrowserObservation(
  resource: BrowserSessionResource,
): Promise<BrowserObservation> {
  const targets = await resource.tabs.list();
  const target = targets.targets.find((candidate) => candidate.selected) ?? targets.targets[0];
  if (!target) throw new Error("UI fixture browser has no page target");
  return await resource.observe(target.id);
}

async function focusAcceptanceInput(
  resource: BrowserSessionResource,
  observation: BrowserObservation,
): Promise<void> {
  const node = findSemanticNode(
    observation,
    (candidate) => candidate.role === "textbox" && candidate.name === "Acceptance input",
  );
  const receipt = await resource.act({
    operationId: crypto.randomUUID(),
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId,
    action: { type: "click", locator: { kind: "ref", ref: node.ref } },
  });
  if (receipt.state !== "completed") throw new Error("browser input focus failed");
}

function findSemanticNode(
  observation: BrowserObservation | { semantic: BrowserObservation["semantic"] },
  predicate: (node: InteractionSemanticNode) => boolean,
): InteractionSemanticNode {
  const semantic = observation.semantic;
  const pending = semantic?.kind === "snapshot" ? [...(semantic.roots ?? [])] : [];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (predicate(node)) return node;
    pending.unshift(...(node.children ?? []));
  }
  throw new Error("acceptance input is missing from the semantic tree");
}

async function waitForBrowserValue(resource: BrowserSessionResource, value: string): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (true) {
    const observation = await currentBrowserObservation(resource);
    if (hasExactSemanticText(observation, value)) return;
    if (performance.now() >= deadline)
      throw new Error(`UI input did not reach exact DOM state: ${value}`);
    await Bun.sleep(25);
  }
}

function hasExactSemanticText(observation: BrowserObservation, value: string): boolean {
  const visit = (nodes: readonly InteractionSemanticNode[]): boolean =>
    nodes.some(
      (node) =>
        (node.role === "text" && node.name === value) ||
        (node.children !== undefined && visit(node.children)),
    );
  return visit(observation.semantic.roots);
}

async function browserContainsWithin(
  resource: BrowserSessionResource,
  value: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (semanticText(await currentBrowserObservation(resource)).includes(value)) return true;
    await Bun.sleep(50);
  }
  return false;
}

async function waitForSelectedTarget(
  resource: BrowserSessionResource,
  targetId: string,
): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (true) {
    const targets = await resource.tabs.list();
    if (targets.targets.some((target) => target.id === targetId && target.selected)) return;
    if (performance.now() >= deadline)
      throw new Error(`UI did not select browser target ${targetId}`);
    await Bun.sleep(25);
  }
}

function semanticText(observation: BrowserObservation): string {
  const semantic = observation.semantic;
  const pending = semantic?.kind === "snapshot" ? [...(semantic.roots ?? [])] : [];
  const values: string[] = [];
  while (pending.length > 0) {
    const node = pending.shift()!;
    if (node.name) values.push(node.name);
    if (typeof node.value === "string") values.push(node.value);
    pending.unshift(...(node.children ?? []));
  }
  return values.join(" ");
}
