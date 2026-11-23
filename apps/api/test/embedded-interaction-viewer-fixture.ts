import { expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  BrowserControlServer,
  LatestBrowserFrameSubscription,
  LatestComputerFrameSubscription,
  type BrowserSupervisor,
  type ComputerSupervisor,
} from "@opengeni/browserd";
import type { AccessGrant, BrowserActionCommand, ComputerActionCommand } from "@opengeni/contracts";
import * as core from "@opengeni/core";
import * as db from "@opengeni/db";
import { OpenGeniClient, createSessionProxyHandler } from "@opengeni/sdk";
import { MemoryEventBus } from "@opengeni/testing/fakes";
import { testSettings } from "@opengeni/testing/settings";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { chromium } from "playwright";
import sharp from "sharp";
import {
  deriveBrowserControllerAdminToken,
  deriveBrowserSessionControllerTokens,
  deriveComputerSessionControllerTokens,
} from "../src/browser-controller-authority";

const accountId = randomUUID();
const workspaceId = randomUUID();
const sessionId = randomUUID();
const browserSessionId = randomUUID();
const computerSessionId = randomUUID();
const sandboxGroupId = randomUUID();
const rootSecret = "interaction-viewer-e2e-root";
const subjectId = "user:product-viewer";
const now = new Date().toISOString();
const controllerGeneration = "controller-1";
const placementInstanceId = "placement-1";
const placement = { kind: "sandbox_group", sandboxGroupId } as const;
const authority = { rootSecret, accountId, workspaceId, placement, placementInstanceId };
const binding = { controllerId: "fixture", controllerGeneration, placementInstanceId };
const browserRef = { browserSessionId, controllerGeneration };
const computerRef = { computerSessionId, controllerGeneration };
const bounds = { x: 0, y: 0, width: 96, height: 72 };
const target = { id: "target-1", controllerGeneration, targetGeneration: "target-1-gen" };
const browserTarget = {
  ...target,
  browserSessionId,
  kind: "page",
  title: "Fixture page",
  url: "https://example.test/",
  documentGeneration: "document-1",
  selected: true,
  attached: true,
  createdAt: now,
};
const computerTarget = {
  ...target,
  computerSessionId,
  kind: "screen",
  title: "Fixture screen",
  bounds,
  applicationId: null,
  processId: null,
  focused: true,
};
const sessionFields = {
  accountId,
  workspaceId,
  placement,
  controller: binding,
  lifecycle: "active",
  associations: [
    {
      sessionId,
      turnId: null,
      attemptId: null,
      relationship: "using",
      actorSubjectId: subjectId,
      lastUsedAt: now,
    },
  ],
  createdBySubjectId: subjectId,
  createdAt: now,
  lastUsedAt: now,
  failureCode: null,
};
const browserSession = {
  ...sessionFields,
  id: browserSessionId,
  name: "Fixture browser",
  driverId: "fixture.cdp",
  engine: "chromium",
  engineVersion: null,
  headless: true,
  identityId: null,
  baseRevisionId: null,
  networkRouteId: null,
  linkedComputerSessionId: null,
  capabilities: {
    semanticObservation: true,
    screenshots: true,
    liveFrames: true,
    humanInput: true,
    tabs: true,
    downloads: false,
    uploads: false,
    clipboard: false,
    permissions: false,
    diagnostics: true,
    rawCdp: false,
    linkedComputer: false,
    privateCheckpoint: false,
    identityPublication: false,
    parallelTargets: false,
  },
};
const computerSession = {
  ...sessionFields,
  id: computerSessionId,
  name: "Fixture desktop",
  platform: "linux",
  adapter: "fixture.desktop",
  seatId: "seat-1",
  displayId: ":99",
  capabilities: {
    semanticObservation: true,
    appDiscovery: false,
    appLaunch: false,
    windowCapture: true,
    screenCapture: true,
    semanticActions: false,
    pointerInput: true,
    keyboardInput: true,
    clipboard: false,
    backgroundActions: false,
    parallelApps: false,
  },
};
const grant: AccessGrant = {
  accountId,
  workspaceId,
  subjectId,
  principalKind: "human_session",
  permissions: ["sessions:read", "sessions:control", "stream:view"],
};

test("a product-origin Chromium viewer fits, paints and controls a browser and paints and controls a desktop", async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL(
        "../../../packages/react/test/embedded-interaction-viewer-fixture.tsx",
        import.meta.url,
      ).pathname,
    ],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!build.success || !build.outputs[0]) throw new Error(build.logs.join("\n"));
  const javascript = build.outputs[0];
  const css = Bun.file(new URL("../../../packages/react/styles/compiled.css", import.meta.url));
  const { controller, inputs } = await fixtureController();
  let api: ReturnType<typeof Bun.serve> | undefined;
  let product: ReturnType<typeof Bun.serve> | undefined;
  let chromiumBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const app = new Hono();
    api = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    let handler: ReturnType<typeof createSessionProxyHandler>;
    product = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const { pathname } = new URL(request.url);
        if (pathname.startsWith("/api/opengeni/")) return handler(request);
        if (pathname === "/viewer.js")
          return new Response(javascript, { headers: { "content-type": "text/javascript" } });
        if (pathname === "/styles.css") return new Response(css);
        return new Response(
          '<!doctype html><link rel="stylesheet" href="/styles.css"><div id="viewer" class="og-root" style="height:95vh"></div><script type="module" src="/viewer.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    handler = createSessionProxyHandler(
      new OpenGeniClient({ baseUrl: api.url.origin, apiKey: "fixture-organization-key" }),
      {
        basePath: "/api/opengeni",
        interactionViewerOrigin: product.url.origin,
        resolve: (request) =>
          request.headers.get("cookie") === "product-session=fixture"
            ? { user: "viewer", workspaceId }
            : new Response("Sign in first", { status: 401 }),
      },
    );
    await registerFixtureApi(app, controller, product.url.origin);
    chromiumBrowser = await chromium.launch(
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : undefined,
    );
    for (const viewer of ["browser", "computer"] as const) {
      const page = await chromiumBrowser.newPage({
        viewport: viewer === "browser" ? { width: 980, height: 700 } : { width: 420, height: 800 },
      });
      if (viewer === "browser") await page.clock.install();
      await page
        .context()
        .addCookies([{ name: "product-session", value: "fixture", url: product.url.origin }]);
      const attachments = page.waitForResponse(
        (response) =>
          response.url().includes(`/${viewer}-sessions/`) &&
          response.url().endsWith("/attachments"),
      );
      const query = new URLSearchParams({ workspace: workspaceId, session: sessionId, viewer });
      await page.goto(`${product.url.origin}/?${query}`);
      const attachment = await attachments;
      expect(attachment.status()).toBe(201);
      expect((await attachment.json()).stream).toMatchObject({
        kind: "direct_websocket",
        url: expect.stringContaining(`/${viewer}-sessions/`),
      });
      const label = viewer === "browser" ? "Interactive browser page" : "Interactive screen view";
      const canvas = page.getByLabel(label);
      await canvas.waitFor({ state: "visible" });
      const expectPixel = (red: number, green: number) =>
        page.waitForFunction(
          ({ ariaLabel, expectedRed, expectedGreen }) => {
            const surface = document.querySelector<HTMLCanvasElement>(
              `canvas[aria-label="${ariaLabel}"]`,
            );
            const color = surface?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
            return color?.[0] === expectedRed && color?.[1] === expectedGreen;
          },
          { ariaLabel: label, expectedRed: red, expectedGreen: green },
        );
      await expectPixel(255, 0);
      if (viewer === "browser") {
        const fitted = await canvas.evaluate((surface) => ({
          width: surface.parentElement!.clientWidth,
          height: surface.parentElement!.clientHeight,
        }));
        const resized = page.waitForResponse(
          (response) => response.url().endsWith(`/browser-sessions/${browserSessionId}/actions`),
          { timeout: 5_000 },
        );
        await page.clock.fastForward(500);
        const resizeResponse = await resized;
        expect(resizeResponse.status()).toBe(200);
        expect(await resizeResponse.json()).toMatchObject({ state: "completed" });
        expect(inputs.browser).toHaveLength(1);
        expect(inputs.browser[0]).toMatchObject({
          expectedFrameId: "frame-1",
          actor: { kind: "human", subjectId },
          action: { type: "viewport", ...fitted, mobile: false, mode: "fit" },
        });
        await page
          .waitForFunction(
            ({ width, height }) => {
              const surface = document.querySelector<HTMLCanvasElement>(
                'canvas[aria-label="Interactive browser page"]',
              );
              return surface?.width === width && surface.height === height;
            },
            fitted,
            { timeout: 5_000 },
          )
          .catch(async (cause) => {
            const painted = await canvas.evaluate((surface) => ({
              width: surface.getAttribute("width"),
              height: surface.getAttribute("height"),
            }));
            throw new Error(
              `Expected the resized frame ${JSON.stringify(fitted)} but painted ${JSON.stringify(painted)}`,
              { cause },
            );
          });
        // An embedded viewer must count as browser activity without any human input.
        const heartbeat = page.waitForResponse((response) =>
          response.url().endsWith(`/browser-sessions/${browserSessionId}/heartbeat`),
        );
        await page.clock.fastForward(31_000);
        const response = await heartbeat;
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({ browserSessionId, alive: true });
        expect(await page.getByRole("textbox", { name: "Address" }).inputValue()).toBe(
          browserTarget.url,
        );
        expect(await page.getByRole("button", { name: "New browser" }).count()).toBe(0);
        expect(await page.getByRole("button", { name: "Debug" }).count()).toBe(0);
      }
      await canvas.click();
      await expectPixel(0, 255);
      expect(inputs[viewer]).toHaveLength(viewer === "browser" ? 2 : 1);
      expect(inputs[viewer].at(-1)).toMatchObject({
        expectedFrameId: viewer === "browser" ? "frame-2" : "frame-1",
        actor: { kind: "human", subjectId },
        action: { type: "pointer", action: "click" },
      });
      await page.close();
    }
  } finally {
    await chromiumBrowser?.close();
    product?.stop(true);
    api?.stop(true);
    await controller.stop();
    mock.restore();
  }
}, 40_000);

async function registerFixtureApi(app: Hono, controller: BrowserControlServer, origin: string) {
  // Real interaction routes and controller protocol, with in-memory session
  // records and fake app admission. The API integration suite exercises the
  // same attachment admission through real organization-key authentication.
  const record = { tokenGeneration: 1, sourceSessionId: sessionId, operation: null };
  const requireGrant = (
    c: Parameters<typeof core.requireAccessGrant>[0],
    _deps: unknown,
    workspace: string,
  ) => {
    const actor = c.req.header("x-opengeni-external-actor");
    if (
      workspace !== workspaceId ||
      c.req.header("authorization") !== "Bearer fixture-organization-key" ||
      !actor?.includes("viewer")
    ) {
      throw new HTTPException(403);
    }
    return grant;
  };
  mock.module("@opengeni/core", () => ({
    ...core,
    requireAccessGrant: requireGrant,
    requireAccessGrantAuthorization: (...args: Parameters<typeof requireGrant>) => ({
      grant: requireGrant(...args),
    }),
    externalAttributionForAuthorization: () => ({}),
    requireSessionAuthorization: async (
      _deps: unknown,
      viewer: AccessGrant,
      input: { sessionId: string },
    ) => {
      expect(viewer).toBe(grant);
      expect(input.sessionId).toBe(sessionId);
      return null;
    },
  }));
  mock.module("@opengeni/db", () => ({
    ...db,
    getBrowserSessionControlRecord: async () => ({
      ...record,
      session: browserSession,
      controllerHostSandboxGroupId: sandboxGroupId,
      deviceWorkspaceId: null,
    }),
    getComputerSessionControlRecord: async () => ({ ...record, session: computerSession }),
    touchBrowserSessionController: async () => true,
    touchComputerSessionController: async () => true,
    readLease: async () => ({
      sandboxGroupId,
      instanceId: placementInstanceId,
      leaseEpoch: 1,
      liveness: "warm",
      backend: "modal",
      controllerDataPlaneUrl: controller.url.replace("http:", "ws:"),
    }),
  }));
  const { registerBrowserSessionRoutes } = await import("../src/routes/browser-sessions");
  const { registerComputerSessionRoutes } = await import("../src/routes/computer-sessions");
  const deps = {
    db: {},
    bus: new MemoryEventBus(),
    settings: testSettings({
      delegationSecret: rootSecret,
      interactionViewerOrigins: origin,
      corsAllowOriginRegex: String.raw`https://console\.example\.test`,
    }),
  } as unknown as core.ApiRouteDeps;
  const base = `/v1/workspaces/${workspaceId}`;
  app.get(`${base}/browser-sessions`, (c) => c.json({ revision: 1, sessions: [browserSession] }));
  app.get(`${base}/computer-sessions`, (c) => c.json({ revision: 1, sessions: [computerSession] }));
  app.get(`${base}/interaction-interventions`, (c) => c.json({ revision: 1, interventions: [] }));
  app.get(`${base}/interaction-events/stream`, (c) =>
    c.body(": ping\n\n", 200, { "content-type": "text/event-stream" }),
  );
  app.get("/v1/config/client", (c) => c.json({}));
  app.get(`${base}/access/grant`, (c) => c.json(grant));
  registerBrowserSessionRoutes(app, deps);
  registerComputerSessionRoutes(app, deps);
}

async function fixtureController() {
  const png = (background: "#ff0000" | "#00ff00", size = bounds) =>
    sharp({ create: { width: size.width, height: size.height, channels: 3, background } })
      .png()
      .toBuffer();
  const [before, after] = await Promise.all([png("#ff0000"), png("#00ff00")]);
  let browserSize = bounds;
  let browserImage = before;
  const inputs = { browser: [] as BrowserActionCommand[], computer: [] as ComputerActionCommand[] };
  const frame = (sequence: number) => ({
    sequence,
    frameId: `frame-${sequence}`,
    targetId: target.id,
    targetGeneration: target.targetGeneration,
    controllerGeneration,
    width: bounds.width,
    height: bounds.height,
    capturedAt: now,
    mediaType: "image/png" as const,
    data: sequence === 1 ? before : after,
  });
  const browserFrame = (sequence: number) => ({
    ...frame(sequence),
    width: browserSize.width,
    height: browserSize.height,
    data: browserImage,
    browserSessionId,
    documentGeneration: browserTarget.documentGeneration,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
  });
  const computerFrame = (sequence: number) => ({ ...frame(sequence), computerSessionId });
  const observation = (kind: "browser" | "computer") => ({
    protocolVersion: 1,
    observationId: "observation-1",
    frameId: "frame-1",
    observedAt: now,
    semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    ...(kind === "browser"
      ? {
          browserSessionId,
          target: browserTarget,
          dialog: null,
          diagnostics: {
            consoleErrorCount: 0,
            failedRequestCount: 0,
            downloadCount: 0,
            pageErrorCount: 0,
          },
        }
      : { computerSessionId, target: computerTarget }),
  });
  const receipt = (kind: "browser" | "computer", operationId: string) => ({
    protocolVersion: 1,
    operationId,
    controllerGeneration,
    targetId: target.id,
    ...(kind === "browser" ? { browserSessionId } : { computerSessionId }),
    state: "completed",
    error: null,
    dispatchedAt: now,
    settledAt: now,
    observation: null,
  });
  const browserFrames = new Set<LatestBrowserFrameSubscription>();
  const computerFrames = new Set<LatestComputerFrameSubscription>();
  const adminToken = deriveBrowserControllerAdminToken(authority);
  const controller = BrowserControlServer.start({
    port: 0,
    adminToken,
    supervisor: {
      createSession: async () => browserRef,
      listTargets: async () => [browserTarget],
      observe: async () => observation("browser"),
      supportsFencedInputBatches: () => false,
      supportsFocusedInputObservations: () => false,
      subscribeFrames: async () => {
        const stream = new LatestBrowserFrameSubscription(async () => {
          browserFrames.delete(stream);
        });
        browserFrames.add(stream);
        stream.push(browserFrame(inputs.browser.length + 1));
        return stream;
      },
      action: async (command: BrowserActionCommand) => {
        inputs.browser.push(command);
        if (command.action.type === "viewport") {
          const { width, height } = command.action;
          browserSize = { ...bounds, width, height };
          browserImage = await png("#ff0000", browserSize);
        } else {
          browserImage = await png("#00ff00", browserSize);
        }
        for (const stream of browserFrames) stream.push(browserFrame(inputs.browser.length + 1));
        return receipt("browser", command.operationId);
      },
      close: async () => {},
    } as unknown as BrowserSupervisor,
    computerSupervisor: {
      createSession: async () => computerRef,
      listTargets: async () => [computerTarget],
      capabilities: () => computerSession.capabilities,
      observe: async () => observation("computer"),
      subscribeFrames: async () => {
        const stream = new LatestComputerFrameSubscription(async () => {
          computerFrames.delete(stream);
        });
        computerFrames.add(stream);
        stream.push(computerFrame(inputs.computer.length + 1));
        return stream;
      },
      action: async (command: ComputerActionCommand) => {
        inputs.computer.push(command);
        for (const stream of computerFrames) stream.push(computerFrame(2));
        return receipt("computer", command.operationId);
      },
      close: async () => {},
    } as unknown as ComputerSupervisor,
  });
  try {
    const tokenGeneration = 1;
    for (const [kind, body] of [
      [
        "browser",
        {
          ...browserRef,
          tokenGeneration,
          headed: false,
          ...deriveBrowserSessionControllerTokens({ ...authority, ...browserRef, tokenGeneration }),
        },
      ],
      [
        "computer",
        {
          ...computerRef,
          tokenGeneration,
          ...deriveComputerSessionControllerTokens({
            ...authority,
            ...computerRef,
            tokenGeneration,
          }),
        },
      ],
    ] as const) {
      const response = await fetch(`${controller.url}/v1/${kind}-sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (response.status !== 201)
        throw new Error(`Fixture controller setup: ${await response.text()}`);
      await response.body?.cancel();
    }
    return { controller, inputs };
  } catch (error) {
    await controller.stop();
    throw error;
  }
}
