import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CreateBrowserSessionRequest, type AccessGrant, type FileAsset } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import { BrowserControlRequestError } from "@opengeni/runtime/sandbox";
import { testSettings } from "@opengeni/testing";
import { createApp } from "../src/app";
import { allowedCorsOrigin, validateInteractionRequestOrigin } from "../src/http/cors";
import { USER_CONTENT_SECURITY_POLICY } from "../src/http/user-content";
import {
  browserNeedsStandaloneDisplayStack,
  browserFileAuthoritySubjectId,
  interactionActorForGrant,
  requireAuthorizedBrowserUploadFiles,
  parseBrowserScreenshotOptions,
  browserScreenshotResponse,
  browserScreenshotError,
  browserTabDiagnosisError,
  browserCreateInput,
  withInitialView,
} from "../src/routes/browser-sessions";

const routeUrl = new URL("../src/routes/browser-sessions.ts", import.meta.url);
const appUrl = new URL("../src/app.ts", import.meta.url);

const FILE_ID = "33333333-3333-4333-8333-333333333333";

test("a create returns the launch view only for the launch it activated in this request", () => {
  const browserSessionId = "44444444-4444-4444-8444-444444444444";
  const launched = {
    browserSessionId,
    controllerGeneration: "generation-1",
    observation: { target: { id: "tab-1" } },
    targets: [{ id: "tab-1" }],
  } as unknown as Parameters<typeof withInitialView>[1];
  const response = (
    change: { lifecycle?: string; generation?: string; state?: string; replayed?: boolean } = {},
  ) => ({
    session: {
      id: browserSessionId,
      lifecycle: change.lifecycle ?? "active",
      controller: { controllerGeneration: change.generation ?? "generation-1" },
    },
    operation: { state: change.state ?? "completed", replayed: change.replayed ?? false },
  });
  expect(withInitialView(response(), launched)).toEqual({
    ...response(),
    initialView: { targets: launched!.targets, observation: launched!.observation },
  });
  for (const other of [
    { replayed: true },
    { state: "failed" },
    { lifecycle: "failed" },
    { generation: "generation-2" },
  ]) {
    expect(withInitialView(response(other), launched)).toEqual(response(other));
  }
  // An older controller that did not report its tabs, or no launch at all.
  expect(withInitialView(response(), { ...launched!, targets: undefined })).toEqual(response());
  expect(withInitialView(response(), null)).toEqual(response());
});

test("automatic managed directory recovery preserves current authority and refused outcomes", async () => {
  const directory = await mkdtemp("/tmp/og-api-working-recovery-");
  const script = join(directory, "synthetic-route.ts");
  await writeFile(script, `(${automaticBrowserRecoveryFixture.toString()})()`, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, "--no-env-file", script, routeUrl.href], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const results = JSON.parse(stdout) as {
      scenario: string;
      status: number;
      reads: number;
      creates: number;
      intent: boolean | null;
      sourceChecks: number;
      touches: number;
      lost: number;
    }[];
    expect(results).toEqual([
      {
        scenario: "recovered",
        status: 200,
        reads: 2,
        creates: 1,
        intent: true,
        sourceChecks: 2,
        touches: 2,
        lost: 0,
      },
      ...["unknown", "unattested"].map((scenario) => ({
        scenario,
        status: 409,
        reads: 1,
        creates: 1,
        intent: true,
        sourceChecks: 2,
        touches: 2,
        lost: 0,
      })),
      ...["token-changed", "generation-changed", "route-changed", "machine-moved"].map(
        (scenario) => ({
          scenario,
          status: 409,
          reads: 1,
          creates: 0,
          intent: null,
          sourceChecks: 2,
          touches: 1,
          lost: 0,
        }),
      ),
      {
        scenario: "holder-lost",
        status: 409,
        reads: 1,
        creates: 0,
        intent: null,
        sourceChecks: 2,
        touches: 2,
        lost: 0,
      },
      {
        scenario: "access-revoked",
        status: 404,
        reads: 1,
        creates: 0,
        intent: null,
        sourceChecks: 2,
        touches: 1,
        lost: 0,
      },
      {
        scenario: "ephemeral",
        status: 409,
        reads: 1,
        creates: 0,
        intent: null,
        sourceChecks: 1,
        touches: 1,
        lost: 1,
      },
      {
        scenario: "lightpanda",
        status: 200,
        reads: 2,
        creates: 1,
        intent: null,
        sourceChecks: 1,
        touches: 1,
        lost: 0,
      },
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("metadata-only open uses control authority, refuses stale bindings and preserves unknown outcomes", async () => {
  const directory = await mkdtemp("/tmp/og-api-target-inventory-");
  const script = join(directory, "synthetic-route.ts");
  await writeFile(script, `(${automaticBrowserRecoveryFixture.toString()})()`, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, "--no-env-file", script, routeUrl.href, "inventory"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        scenario: "inventory",
        status: 201,
        opens: 1,
        reads: 0,
        creates: 0,
        sourceChecks: 1,
        touches: 1,
        content: false,
      },
      {
        scenario: "default",
        status: 201,
        opens: 1,
        reads: 0,
        creates: 0,
        sourceChecks: 1,
        touches: 1,
        content: true,
      },
      ...["wrong-session", "wrong-controller", "wrong-target"].map((scenario) => ({
        scenario,
        status: 502,
        opens: 1,
        reads: 0,
        creates: 0,
        sourceChecks: 1,
        touches: 1,
        content: false,
      })),
      {
        scenario: "unknown",
        status: 409,
        opens: 1,
        reads: 0,
        creates: 0,
        sourceChecks: 1,
        touches: 1,
        content: false,
      },
      {
        scenario: "permission-denied",
        status: 403,
        opens: 0,
        reads: 0,
        creates: 0,
        sourceChecks: 0,
        touches: 0,
        content: false,
      },
      {
        scenario: "access-revoked",
        status: 404,
        opens: 0,
        reads: 0,
        creates: 0,
        sourceChecks: 1,
        touches: 0,
        content: false,
      },
      {
        scenario: "holder-lost",
        status: 409,
        opens: 0,
        reads: 0,
        creates: 0,
        sourceChecks: 1,
        touches: 1,
        content: false,
      },
      {
        scenario: "machine-moved",
        status: 409,
        opens: 0,
        reads: 0,
        creates: 0,
        sourceChecks: 1,
        touches: 0,
        content: false,
      },
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

async function automaticBrowserRecoveryFixture() {
  const inventoryOnly = process.argv[3] === "inventory";
  let opens = 0;
  const routeHref = process.argv[2]!;
  const apiDirectory = new URL("..", routeHref).pathname;
  const resolveFromApi = (name: string) => Bun.resolveSync(name, apiDirectory);
  const { mock } = await import("bun:test");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = (await import(resolveFromApi("hono"))) as typeof import("hono");
  const { HTTPException: FixtureHTTPException } = (await import(
    resolveFromApi("hono/http-exception")
  )) as typeof import("hono/http-exception");
  const db = (await import(resolveFromApi("@opengeni/db"))) as typeof import("@opengeni/db");
  const core = (await import(resolveFromApi("@opengeni/core"))) as typeof import("@opengeni/core");
  const { testSettings: fixtureSettings } = (await import(
    resolveFromApi("@opengeni/testing")
  )) as typeof import("@opengeni/testing");
  const authority = await import(new URL("../browser-controller-authority.ts", routeHref).href);
  const accountId = randomUUID(),
    workspaceId = randomUUID(),
    browserSessionId = randomUUID();
  const sourceSessionId = randomUUID(),
    machineId = randomUUID(),
    instanceId = randomUUID();
  const controllerGeneration = randomUUID(),
    rootSecret = "synthetic-controller-authority";
  const grant = {
    accountId,
    workspaceId,
    subjectId: "synthetic-user",
    permissions: ["sessions:read"],
  };
  const baseRecord = {
    sourceSessionId,
    tokenGeneration: 1,
    controllerHostSandboxGroupId: null,
    networkRouteAuthority: null,
    session: {
      id: browserSessionId,
      workspaceId,
      lifecycle: "active",
      placement: { kind: "connected_machine", sandboxId: machineId },
      controller: {
        controllerId: "opengeni-browserd",
        controllerGeneration,
        placementInstanceId: instanceId,
      },
      driverId: "opengeni.cdp.v1",
      engine: "chromium",
      headless: true,
      linkedComputerSessionId: null,
      networkRouteId: null,
    },
  };
  let state = {
    scenario: "recovered",
    missing: false,
    recovered: false,
    reads: 0,
    creates: [] as Record<string, unknown>[],
    sourceChecks: 0,
    touches: 0,
    lost: 0,
  };
  mock.module(resolveFromApi("@opengeni/db"), () => ({
    ...db,
    getBrowserSessionControlRecord: async () => {
      const record = structuredClone(baseRecord);
      if (state.scenario === "ephemeral")
        record.session.driverId = "opengeni.cdp.ephemeral-context.v1";
      if (state.scenario === "lightpanda") record.session.engine = "lightpanda";
      if (state.missing && state.scenario === "token-changed") record.tokenGeneration++;
      if (state.missing && state.scenario === "generation-changed")
        record.session.controller.controllerGeneration = randomUUID();
      if (state.missing && state.scenario === "route-changed")
        record.session.networkRouteId = randomUUID() as never;
      return record;
    },
    getSession: async () => ({
      id: sourceSessionId,
      workspaceId,
      activeSandboxId:
        (state.missing || inventoryOnly) && state.scenario === "machine-moved"
          ? randomUUID()
          : machineId,
    }),
    touchBrowserSessionController: async () => {
      state.touches++;
      return !((state.missing || inventoryOnly) && state.scenario === "holder-lost");
    },
    terminalizeStaleConnectedInteractionPlacement: async () => ({ sourcePlacementChanged: false }),
    markEphemeralBrowserSessionLost: async () => {
      state.lost++;
      return true;
    },
  }));
  mock.module(resolveFromApi("@opengeni/core"), () => ({
    ...core,
    requireAccessGrant: async (
      _context: unknown,
      _deps: unknown,
      _workspace: string,
      permission: string,
    ) => {
      if (inventoryOnly && permission !== "sessions:control")
        throw new Error("synthetic permission mismatch");
      if (inventoryOnly && state.scenario === "permission-denied")
        throw new FixtureHTTPException(403);
      return grant;
    },
    requireSessionAuthorization: async (
      _deps: unknown,
      _grant: unknown,
      input: { operation: string },
    ) => {
      state.sourceChecks++;
      if (inventoryOnly && input.operation !== "session.control")
        throw new Error("synthetic source operation mismatch");
      if ((state.missing || inventoryOnly) && state.scenario === "access-revoked")
        throw new core.SessionAuthorizationDeniedError("revoked");
      return {};
    },
  }));
  const success = (data: unknown) => Response.json({ protocolVersion: 1, ok: true, data });
  const failure = (status: number, code: string) =>
    Response.json(
      {
        protocolVersion: 1,
        ok: false,
        error: { code, message: "synthetic retained recovery state", retryable: false },
      },
      { status },
    );
  const expectedTokens = authority.deriveBrowserSessionControllerTokens({
    rootSecret,
    accountId,
    workspaceId,
    placement: baseRecord.session.placement,
    placementInstanceId: instanceId,
    browserSessionId,
    controllerGeneration,
    tokenGeneration: 1,
  });
  const expectedAdmin = authority.deriveBrowserControllerAdminToken({
    rootSecret,
    accountId,
    workspaceId,
    placement: baseRecord.session.placement,
    placementInstanceId: instanceId,
  });
  const observation = {
    protocolVersion: 1,
    observationId: randomUUID(),
    browserSessionId,
    target: {
      id: "synthetic-target",
      browserSessionId,
      controllerGeneration,
      targetGeneration: "synthetic-target-generation",
      documentGeneration: "synthetic-document",
      kind: "page",
      title: "Fixture",
      url: "about:blank",
      selected: true,
      attached: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    frameId: "synthetic-frame",
    semantic: { kind: "snapshot", roots: [], nodeCount: 0 },
    screenshot: null,
    focusedRef: null,
    changedRegions: [],
    diagnostics: {
      consoleErrorCount: 0,
      failedRequestCount: 0,
      downloadCount: 0,
      pageErrorCount: 0,
    },
    dialog: null,
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (
        inventoryOnly &&
        request.method === "POST" &&
        (path.endsWith("/open-with-inventory") || path.endsWith("/targets"))
      ) {
        opens++;
        if (request.headers.get("authorization") !== `Bearer ${expectedTokens.controlToken}`)
          throw new Error("synthetic control authority mismatch");
        const body = await request.json();
        if (JSON.stringify(body) !== JSON.stringify({ url: "https://new.example.test/" }))
          throw new Error("synthetic open request mismatch");
        if (state.scenario === "unknown") return failure(409, "outcome_unknown");
        if (state.scenario === "default") return success(observation);
        return success({
          browserSessionId: state.scenario === "wrong-session" ? randomUUID() : browserSessionId,
          controllerGeneration:
            state.scenario === "wrong-controller" ? randomUUID() : controllerGeneration,
          targets: [
            {
              ...observation.target,
              controllerGeneration:
                state.scenario === "wrong-target" ? randomUUID() : controllerGeneration,
            },
          ],
        });
      }
      if (request.method === "GET" && path.endsWith("/targets")) {
        state.reads++;
        if (request.headers.get("authorization") !== `Bearer ${expectedTokens.viewToken}`)
          throw new Error("synthetic view authority mismatch");
        if (!state.recovered) {
          state.missing = true;
          return failure(401, "permission_denied");
        }
        return success([]);
      }
      if (request.method !== "POST" || path !== "/v1/browser-sessions")
        throw new Error("unexpected synthetic controller request");
      const body = (await request.json()) as Record<string, unknown>;
      state.creates.push(body);
      if (
        request.headers.get("authorization") !== `Bearer ${expectedAdmin}` ||
        body.browserSessionId !== browserSessionId ||
        body.controllerGeneration !== controllerGeneration ||
        body.tokenGeneration !== 1 ||
        body.controlToken !== expectedTokens.controlToken ||
        body.viewToken !== expectedTokens.viewToken ||
        body.headed !== false ||
        body.initialUrl !== undefined ||
        body.restore !== undefined
      )
        throw new Error("synthetic recovery authority mismatch");
      if (state.scenario !== "lightpanda" && body.recoverExistingWorkingDirectory !== true)
        return failure(409, "resource_unavailable");
      if (["unknown", "unattested"].includes(state.scenario))
        return failure(409, "resource_unavailable");
      state.recovered = true;
      return success({ browserSessionId, controllerGeneration, observation });
    },
  });
  const channelHref = new URL("../sandbox/channel-a.ts", routeHref).href;
  const channel = await import(channelHref);
  mock.module(channelHref, () => ({
    ...channel,
    withChannelARead: async (
      _services: unknown,
      _context: unknown,
      callback: (handle: unknown) => Promise<unknown>,
    ) => {
      if (
        inventoryOnly &&
        (_context as { operation: string; retryControllerTransport: boolean }).operation !==
          "browser.control"
      )
        throw new Error("synthetic channel operation mismatch");
      if (
        inventoryOnly &&
        (_context as { retryControllerTransport: boolean }).retryControllerTransport !== false
      )
        throw new Error("synthetic mutation replay posture mismatch");
      return await callback({
        routingSession: {
          prime: async () => ({
            kind: "selfhosted",
            sandboxId: machineId,
            providerInstanceId: instanceId,
            session: {
              resolveExposedPort: async () => ({
                host: "127.0.0.1",
                port: server.port,
                tls: false,
              }),
            },
          }),
        },
      });
    },
    withChannelA: async () => {
      throw new Error("unexpected synthetic lifecycle operation");
    },
  }));
  const { registerBrowserSessionRoutes } = await import(routeHref);
  const app = new Hono();
  app.onError((error, context) =>
    context.json(
      { message: error.message },
      (error instanceof FixtureHTTPException ? error.status : 500) as never,
    ),
  );
  registerBrowserSessionRoutes(app, {
    settings: fixtureSettings({ delegationSecret: rootSecret }),
    db: {},
    bus: {},
  } as never);
  // Expected refusals remain observable through the HTTP result, without printing fixture tokens.
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const results = [];
    if (inventoryOnly) {
      for (const scenario of [
        "inventory",
        "default",
        "wrong-session",
        "wrong-controller",
        "wrong-target",
        "unknown",
        "permission-denied",
        "access-revoked",
        "holder-lost",
        "machine-moved",
      ]) {
        state = {
          scenario,
          missing: false,
          recovered: true,
          reads: 0,
          creates: [],
          sourceChecks: 0,
          touches: 0,
          lost: 0,
        };
        opens = 0;
        const response = await app.request(
          `https://api.example.test/v1/workspaces/${workspaceId}/browser-sessions/${browserSessionId}/targets${scenario === "default" ? "" : "/open-with-inventory"}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: "https://new.example.test/" }),
          },
        );
        const body = (await response.json()) as Record<string, unknown>;
        results.push({
          scenario,
          status: response.status,
          opens,
          reads: state.reads,
          creates: state.creates.length,
          sourceChecks: state.sourceChecks,
          touches: state.touches,
          content: "semantic" in body,
        });
      }
      console.log(JSON.stringify(results));
      return;
    }
    for (const scenario of [
      "recovered",
      "unknown",
      "unattested",
      "token-changed",
      "generation-changed",
      "route-changed",
      "machine-moved",
      "holder-lost",
      "access-revoked",
      "ephemeral",
      "lightpanda",
    ]) {
      state = {
        scenario,
        missing: false,
        recovered: false,
        reads: 0,
        creates: [],
        sourceChecks: 0,
        touches: 0,
        lost: 0,
      };
      const response = await app.request(
        `https://api.example.test/v1/workspaces/${workspaceId}/browser-sessions/${browserSessionId}/targets`,
      );
      const intent = state.creates[0]?.recoverExistingWorkingDirectory ?? null;
      results.push({
        scenario,
        status: response.status,
        reads: state.reads,
        creates: state.creates.length,
        intent,
        sourceChecks: state.sourceChecks,
        touches: state.touches,
        lost: state.lost,
      });
    }
    console.log(JSON.stringify(results));
  } finally {
    console.error = originalError;
    await server.stop(true);
  }
}

function readyFile(id = FILE_ID): FileAsset {
  return {
    id,
    workspaceId: "22222222-2222-4222-8222-222222222222",
    status: "ready",
    filename: "drive.txt",
    safeFilename: "drive.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    sha256: "a".repeat(64),
    bucket: "test",
    objectKey: `files/${id}`,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function httpStatus(operation: () => unknown): number | "resolved" {
  try {
    operation();
    return "resolved";
  } catch (error) {
    if (error instanceof HTTPException) return error.status;
    throw error;
  }
}

describe("BrowserSession route discipline", () => {
  test("preserves a definite tab diagnosis in GET and DOM-read POST API envelopes", async () => {
    const app = createApp({
      settings: testSettings(),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    const internal = new BrowserControlRequestError(409, {
      code: "tab_not_responding",
      message: "This tab is not responding. Reload or close it.",
      retryable: false,
    });
    app.on(["GET", "POST"], "/v1/test/tab-not-responding", () => {
      throw browserTabDiagnosisError(internal);
    });
    for (const method of ["GET", "POST"] as const) {
      const response = await app.request("http://localhost/v1/test/tab-not-responding", {
        method,
        headers: { "x-opengeni-correlation-id": "hung-tab-request" },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          status: 409,
          code: "tab_not_responding",
          message: internal.error.message,
          retryable: false,
          requestId: "hung-tab-request",
        },
      });
    }
    const uncertain = new BrowserControlRequestError(409, {
      code: "outcome_unknown",
      message: "input sent",
      retryable: false,
    });
    expect(browserTabDiagnosisError(uncertain)).toBe(uncertain);
  });

  test("publishes a crashed tab as its own definite diagnosis, not a retryable outage", async () => {
    const app = createApp({
      settings: testSettings(),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    const crashed = new BrowserControlRequestError(409, {
      code: "tab_crashed",
      message:
        "This browser tab crashed and no longer responds. Open a new tab (and close this one), then continue there.",
      retryable: false,
    });
    app.get("/v1/test/tab-crashed", () => {
      throw browserTabDiagnosisError(crashed);
    });
    const response = await app.request("http://localhost/v1/test/tab-crashed", {
      headers: { "x-opengeni-correlation-id": "crashed-tab-request" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        status: 409,
        code: "tab_crashed",
        message: crashed.error.message,
        retryable: false,
        requestId: "crashed-tab-request",
      },
    });
    // Any other unavailable verdict keeps the ordinary envelope, which never
    // publishes a driver's free-form message.
    const other = new BrowserControlRequestError(503, {
      code: "resource_unavailable",
      message: "PRIVATE /home/user/profile detail",
      retryable: true,
    });
    expect(browserTabDiagnosisError(other)).toBe(other);
  });

  test("publishes a definite screenshot timeout through the ordinary API error envelope", async () => {
    const app = createApp({
      settings: testSettings(),
      db: {} as never,
      bus: {} as never,
      workflowClient: {} as never,
      managedAuth: null,
    });
    const internal = new BrowserControlRequestError(504, {
      code: "timeout",
      message: "PRIVATE /home/user/profile secret",
      retryable: true,
      details: { privatePath: "/home/user/profile" },
    });
    const projected = browserScreenshotError(internal);
    expect(projected).toBeInstanceOf(HTTPException);
    expect((projected as Error).cause).toBe(internal);
    app.get("/v1/test/browser-capture-timeout", () => {
      throw projected;
    });
    const response = await app.request("http://localhost/v1/test/browser-capture-timeout", {
      headers: { "x-opengeni-correlation-id": "capture-request-42" },
    });
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: {
        status: 504,
        code: "upstream_unavailable",
        message:
          "This tab did not produce a screenshot in time. Other browser operations may still work.",
        retryable: true,
        requestId: "capture-request-42",
      },
    });
  });

  test("does not relabel another screenshot failure as a timeout", () => {
    for (const error of [
      new Error("unexpected"),
      new BrowserControlRequestError(403, {
        code: "permission_denied",
        message: "browser action denied",
        retryable: false,
      }),
      new BrowserControlRequestError(409, {
        code: "outcome_unknown",
        message: "uncertain",
        retryable: false,
      }),
    ])
      expect(browserScreenshotError(error)).toBe(error);
  });

  test("existing managed browser control retains the durable provider instance across image upgrades", async () => {
    const source = await readFile(routeUrl, "utf8");
    const placement = source.slice(source.indexOf("async function withBrowserPlacement"));
    expect(placement).toContain("retainedInstanceId: expectedPlacementInstanceId");
    expect(placement).toContain('expectedPlacement?.kind === "sandbox_group"');
    expect(placement).toContain(
      "assertPlacementInstance(expectedPlacementInstanceId, handle.lease.instanceId)",
    );
    const channel = await readFile(new URL("../src/sandbox/channel-a.ts", import.meta.url), "utf8");
    expect(channel).toContain("retainedInstanceId: ctx.retainedInstanceId");
    const holder = source.slice(
      source.indexOf("async function ensureInteractionHolder"),
      source.indexOf("async function releaseInteractionHolder"),
    );
    expect(holder).toContain('imagePolicy: "new_creates_only"');
    expect(holder).toContain("expectedEpoch: placement.lease.leaseEpoch");
    expect(holder).toContain("rigVersionId: sourceSession.rigVersionId");
  });
  test("explicit Lightpanda preserves Connected Machine placement and semantic capabilities", () => {
    const grant: AccessGrant = {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      subjectId: "browser-user",
      permissions: ["sessions:control"],
    };
    const request = CreateBrowserSessionRequest.parse({
      operationId: "44444444-4444-4444-8444-444444444444",
      sessionId: FILE_ID,
      engine: "lightpanda",
    });
    const placement = {
      kind: "connected_machine" as const,
      sandboxId: FILE_ID,
    };
    const input = browserCreateInput(grant, grant.workspaceId, request, placement);
    expect(input).toMatchObject({
      engine: "lightpanda",
      driverId: "opengeni.lightpanda.cdp.v1",
      headless: true,
      placement,
      identityId: null,
      linkedComputerSessionId: null,
      capabilities: {
        liveFrames: false,
        humanInput: false,
        linkedComputer: false,
      },
    });
    const defaultInput = browserCreateInput(
      grant,
      grant.workspaceId,
      CreateBrowserSessionRequest.parse({
        operationId: request.operationId,
        sessionId: FILE_ID,
      }),
      placement,
    );
    expect(defaultInput.engine).toBe("chromium");
    for (const unsupported of [
      { kind: "attached_device" as const, deviceId: FILE_ID },
      {
        kind: "external_provider" as const,
        providerId: "browserbase",
        placementId: "default",
      },
    ]) {
      expect(() => browserCreateInput(grant, grant.workspaceId, request, unsupported)).toThrow(
        "Lightpanda requires a managed sandbox or Connected Machine browser placement",
      );
    }
  });

  test("browser screenshot query validates capture options", () => {
    expect(parseBrowserScreenshotOptions(new URLSearchParams())).toEqual({});
    expect(
      parseBrowserScreenshotOptions(new URLSearchParams("fullPage=true&format=png&quality=75")),
    ).toEqual({ fullPage: true, format: "png", quality: 75 });
    for (const query of [
      "fullPage=1",
      "format=gif",
      "quality=0",
      "quality=101",
      "quality=",
      "fullPage=true&fullPage=false",
    ]) {
      expect(httpStatus(() => parseBrowserScreenshotOptions(new URLSearchParams(query)))).toBe(400);
    }
  });

  test("browser screenshot response sends only Buffer view bytes", async () => {
    const image = Buffer.from([99, 0xff, 0xd8, 0xff, 0xd9, 88]).subarray(1, 5);
    const response = browserScreenshotResponse({
      data: image,
      mediaType: "image/jpeg",
      metadataHeader: "frame-metadata",
    });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(USER_CONTENT_SECURITY_POLICY);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("registers the complete lifecycle, semantic control, diagnostics, and frame surface", async () => {
    const source = await readFile(routeUrl, "utf8");
    for (const route of [
      '"/v1/workspaces/:workspaceId/attached-browsers"',
      '"/v1/workspaces/:workspaceId/attached-browsers/:deviceId"',
      '"/v1/workspaces/:workspaceId/browser-sessions"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/select"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/observation"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/state"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/dom-read"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/screenshot"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads/:downloadId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads/:downloadId/save"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/clipboard"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/report"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth/interactive"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/verify"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/operations/:operationId"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/diagnostics"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/attachments"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/heartbeat"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/revisions"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/suspend"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/resume"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"',
    ]) {
      expect(source).toContain(route);
    }
    expect(await readFile(appUrl, "utf8")).toContain(
      "registerBrowserSessionRoutes(app, routeDeps, { interactionSecrets })",
    );
  });

  test("authenticates before parsing and never places frame credentials in URLs", async () => {
    const source = await readFile(routeUrl, "utf8");
    const createStart = source.indexOf('app.post("/v1/workspaces/:workspaceId/browser-sessions"');
    const createEnd = source.indexOf("app.get(", createStart);
    const create = source.slice(createStart, createEnd);
    expect(create.indexOf("requireAccessGrant")).toBeGreaterThanOrEqual(0);
    expect(create.indexOf("requireAccessGrant")).toBeLessThan(
      create.indexOf("parseJsonBody(context, CreateBrowserSessionRequest)"),
    );
    expect(source).toContain('kind: "direct_websocket"');
    expect(source).toContain('kind: "relay"');
    expect(source).toContain("BROWSER_CONTROL_WEBSOCKET_BEARER_PREFIX");
    expect(source).not.toMatch(/url[^\n]*relayToken/u);
    const attachment = source.slice(
      source.indexOf(
        '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/attachments"',
      ),
      source.indexOf('"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/heartbeat"'),
    );
    expect(attachment).toContain("requestOrigin(context, deps.settings)");
    expect(attachment).toContain("client.addAllowedOrigins([origin])");
    expect(attachment).toContain("placementUsesInteractionFrameProxy(placement.lease?.backend, {");
    expect(attachment).toContain(
      "openSandboxSignedEndpoints: deps.settings.openSandboxSignedEndpoints",
    );
    expect(attachment).toContain("createInteractionFrameProxyAttachment");
    expect(attachment).toContain("publicBaseUrl: deps.settings.publicBaseUrl");
    expect(attachment).toContain('context.req.header("x-forwarded-proto")');
  });

  test("rejects archived identities before acquiring a browser placement", async () => {
    const source = await readFile(routeUrl, "utf8");
    const createStart = source.indexOf('app.post("/v1/workspaces/:workspaceId/browser-sessions"');
    const createEnd = source.indexOf("app.get(", createStart);
    const create = source.slice(createStart, createEnd);
    expect(create).toContain("await getBrowserIdentity(deps.db");
    expect(create.indexOf("await getBrowserIdentity(deps.db")).toBeLessThan(
      create.indexOf("await withBrowserPlacement("),
    );
    expect(create).toContain('identity.status !== "active"');
  });

  test("routes attached-device BrowserSession end through the original placement fence", async () => {
    const source = await readFile(routeUrl, "utf8");
    const placement = source.slice(
      source.indexOf("async function withBrowserPlacement"),
      source.indexOf("async function withActiveBrowserController"),
    );
    expect(placement).toContain("attachedEndPlacementInstanceId(");
    expect(source).toContain('operation === "browser.end" && expectedPlacementInstanceId');
  });

  test("retires a stale Connected Machine placement instead of advertising a retryable 409", async () => {
    const source = await readFile(routeUrl, "utf8");
    const placement = source.slice(
      source.indexOf("async function withBrowserPlacement"),
      source.indexOf("async function withActiveBrowserController"),
    );
    const active = source.slice(
      source.indexOf("async function withActiveBrowserController"),
      source.indexOf("async function recoverActiveBrowserController"),
    );
    expect(placement).toContain("throwBrowserSourcePlacementChanged");
    expect(active).toContain("terminalizeStaleConnectedInteractionPlacement");
    expect(active.indexOf("terminalizeStaleConnectedInteractionPlacement")).toBeLessThan(
      active.indexOf('sourcePlacementChangedApiError("browser_session")'),
    );
    expect(source).toContain('interactionFailureCode: "source_placement_changed"');
    expect(source).toContain('interactionLifecycle: "lost"');
    expect(source).toContain("retryable: false");
  });

  test("admits every controller call through the durable generation fence", async () => {
    const source = await readFile(routeUrl, "utf8");
    expect(source).toContain("touchBrowserSessionController(deps.db");
    expect(source).toContain("BrowserSession controller authority changed");
    const activeController = source.slice(
      source.indexOf("async function withActiveBrowserController"),
    );
    expect(activeController.indexOf("if (!admitted)")).toBeLessThan(
      activeController.indexOf("return await withBrowserPlacement("),
    );
  });

  test("shares attempt reads only until the controller call, and lets a denial win", async () => {
    const source = await readFile(routeUrl, "utf8");
    const active = source.slice(
      source.indexOf("async function withActiveBrowserController"),
      source.indexOf("async function throwBrowserSourcePlacementChanged"),
    );
    // The source-session check and Channel-A's machine-route check prove the
    // same live attempt back to back; the controller call and anything after
    // it read fresh.
    expect(active).toContain("withSessionAuthorizationReadReuse(");
    const run = active.slice(active.indexOf("const run = async ("));
    expect(run.indexOf("authorizationReads.handOffToToolDispatch()")).toBeGreaterThan(-1);
    expect(run.indexOf("authorizationReads.handOffToToolDispatch()")).toBeLessThan(
      run.indexOf("await callback(controller)"),
    );
    // The source session is read alongside authorization; a denial is
    // surfaced first and the session is used only once authorized.
    expect(active.indexOf('if (authorized.status === "rejected")')).toBeLessThan(
      active.indexOf('if (sourceRead.status === "rejected")'),
    );
  });

  test("serves no brokered credential fill route; logins use secret references in actions", async () => {
    const source = await readFile(routeUrl, "utf8");
    expect(source).not.toContain("/protected-fill");
    expect(source).not.toContain("protectedAuth");
  });

  test("keeps provider auth durable while gating its hosted flow to humans", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth"',
    );
    const interactiveStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/external-auth/interactive"',
      start,
    );
    const durable = source.slice(start, interactiveStart);
    const interactive = source.slice(
      interactiveStart,
      source.indexOf(
        '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs/:authRunId/verify"',
        interactiveStart,
      ),
    );
    expect(durable.indexOf("prepareExternalAuth")).toBeLessThan(
      durable.indexOf("dispatchExternalAuth"),
    );
    expect(durable.indexOf("dispatchExternalAuth")).toBeLessThan(
      durable.indexOf("sessionClient.externalAuth"),
    );
    expect(durable.indexOf("sessionClient.externalAuth")).toBeLessThan(
      durable.indexOf("completeExternalAuth"),
    );
    expect(durable).toContain(
      "provider exposed a hosted login URL outside the human-only endpoint",
    );
    expect(interactive).toContain('grant.principalKind !== "human_session"');
    expect(interactive).toContain('action: "interactive"');
    expect(interactive).not.toContain("completeExternalAuth");
  });

  test("stages upload bytes privately before the canonical browser action", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions"',
    );
    const end = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs"',
      start,
    );
    const route = source.slice(start, end);
    expect(route).toContain('requireAccessGrant(context, deps, workspaceId, "files:read")');
    expect(route).not.toContain("getFiles(deps.db");
    expect(route).toContain("getFilesForSubject(deps.db");
    expect(route).toContain("browserFileAuthoritySubjectId(grant, sourceAuthorization)");
    expect(route.indexOf("getFilesForSubject(deps.db")).toBeLessThan(
      route.indexOf("requireAuthorizedBrowserUploadFiles"),
    );
    expect(route.indexOf("requireAuthorizedBrowserUploadFiles")).toBeLessThan(
      route.indexOf("createGetUrl"),
    );
    expect(route.indexOf("createGetUrl")).toBeLessThan(
      route.indexOf("sessionClient.stageWorkspaceFiles"),
    );
    expect(route.indexOf("sessionClient.stageWorkspaceFiles")).toBeLessThan(
      route.indexOf("sessionClient.action("),
    );
    expect(route).toContain("sessionClient.receipt(request.operationId)");
  });

  test("resolves agent secret references last, right before the canonical action", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/actions"',
    );
    const end = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/auth-runs"',
      start,
    );
    const route = source.slice(start, end);
    // The public command is validated before any reference is resolved.
    expect(route.indexOf("BrowserActionCommand.parse(commandFields)")).toBeLessThan(
      route.indexOf("resolveInteractionSecretValues"),
    );
    expect(route.indexOf("sessionClient.stageWorkspaceFiles")).toBeLessThan(
      route.indexOf("resolveInteractionSecretValues"),
    );
    expect(route.indexOf("resolveInteractionSecretValues")).toBeLessThan(
      route.indexOf("sessionClient.action("),
    );
    expect(route).toContain("texts: browserActionSecretTexts(request.action)");
    expect(route).toContain('surface: "browser"');
    // Passkeys sync before (taking over the principal's lease, settled before
    // dispatch) and after the action, never instead of it.
    expect(route.match(/passkeySync\((?:true|false)\)/g)?.length).toBe(2);
    expect(route.indexOf("const passkeyTakeover = passkeySync(true)")).toBeLessThan(
      route.indexOf("await passkeyTakeover"),
    );
    expect(route.indexOf("await passkeyTakeover")).toBeLessThan(
      route.indexOf("sessionClient.action("),
    );
    expect(route.indexOf("sessionClient.action(")).toBeLessThan(
      route.indexOf("void passkeySync(false)"),
    );
    // The response is the controller receipt; the side map is never echoed.
    expect(route).not.toContain("secretValues: request");
  });

  test("binds agent uploads to the frozen initiating human, not the worker subject", () => {
    const grant = {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      subjectId: "worker:first-party-mcp",
      permissions: [] as const,
      principalKind: "agent_attempt" as const,
    };
    const authorization = {
      actor: {
        kind: "agent_attempt" as const,
        subjectId: "worker:first-party-mcp",
        callerSessionId: "44444444-4444-4444-8444-444444444444",
        callerRootSessionId: "44444444-4444-4444-8444-444444444444",
        turnId: "55555555-5555-4555-8555-555555555555",
        attemptId: "66666666-6666-4666-8666-666666666666",
        executionGeneration: 1,
        initiator: { kind: "subject" as const, subjectId: "user:drive-owner" },
        initiatorContext: { source: "user" as const },
        initiatingHumanSubjectId: "user:drive-owner",
      },
      target: {
        sessionId: "44444444-4444-4444-8444-444444444444",
        rootSessionId: "44444444-4444-4444-8444-444444444444",
      },
      relatedSessionAccess: "root" as const,
      reauthorizeAfterMs: null,
    };
    expect(browserFileAuthoritySubjectId(grant, authorization)).toBe("user:drive-owner");
    expect(browserFileAuthoritySubjectId(grant, null)).toBeNull();
  });

  for (const condition of [
    "denied ACL evidence",
    "stale ACL evidence",
    "disconnected Drive authority",
    "revoked Drive scope",
  ]) {
    test(`fails the upload closed before signing when authority is omitted for ${condition}`, () => {
      expect(httpStatus(() => requireAuthorizedBrowserUploadFiles([FILE_ID], []))).toBe(404);
    });
  }

  test("fails a mixed ordinary/Drive upload when any requested file is unauthorized", () => {
    const ordinaryId = "77777777-7777-4777-8777-777777777777";
    expect(
      httpStatus(() =>
        requireAuthorizedBrowserUploadFiles([ordinaryId, FILE_ID], [readyFile(ordinaryId)]),
      ),
    ).toBe(404);
  });

  test("publishes one exact private download before one fenced workspace import", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/downloads/:downloadId/save"',
    );
    const end = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/targets/:targetId/observation"',
      start,
    );
    const route = source.slice(start, end);
    expect(route.indexOf("findBrowserDownloadSave")).toBeLessThan(
      route.indexOf("if (!objectStorage)"),
    );
    expect(route.indexOf("sessionClient.exportDownload")).toBeLessThan(
      route.indexOf("finalizeBrowserDownloadFile"),
    );
    expect(route.indexOf("finalizeBrowserDownloadFile")).toBeLessThan(
      route.indexOf("dispatchBrowserDownloadSave"),
    );
    expect(route.indexOf("dispatchBrowserDownloadSave")).toBeLessThan(
      route.indexOf("service.importWorkspaceFile"),
    );
    expect(route.indexOf("service.importWorkspaceFile")).toBeLessThan(
      route.indexOf("completeBrowserDownloadSave"),
    );
    expect(route).toContain('operation: "browser.download.save"');
    expect(route).toContain("mayReplaceExisting: save.overwrite && dispatched.dispatchedNow");
    expect(route).toContain("createParents: true");
  });

  test("resolves linked browsers through the exact active ComputerSession placement", async () => {
    const source = await readFile(routeUrl, "utf8");
    const createStart = source.indexOf('app.post("/v1/workspaces/:workspaceId/browser-sessions"');
    const createEnd = source.indexOf("app.get(", createStart);
    const create = source.slice(createStart, createEnd);
    expect(create.indexOf("ensureLinkedComputerController")).toBeGreaterThanOrEqual(0);
    expect(create.indexOf("ensureLinkedComputerController")).toBeLessThan(
      create.indexOf("client.createSession"),
    );
    const binding = source.slice(source.indexOf("async function ensureLinkedComputerController"));
    expect(binding).toContain("sameInteractionPlacement");
    expect(binding).toContain("record.session.controller.placementInstanceId");
    expect(binding).toContain(
      "controllerGeneration: record.session.controller.controllerGeneration",
    );
    expect(binding.indexOf("await sessionClient.heartbeat()")).toBeLessThan(
      binding.indexOf("await client.createComputerSession"),
    );
    expect(binding).toContain("isMissingLinkedComputerControllerSession(error)");
  });

  test("uses linked and native displays without bootstrapping a standalone desktop", async () => {
    expect(
      browserNeedsStandaloneDisplayStack({
        headless: false,
        linkedComputer: true,
        nativeBrowserControl: false,
      }),
    ).toBe(false);
    expect(
      browserNeedsStandaloneDisplayStack({
        headless: false,
        linkedComputer: false,
        nativeBrowserControl: true,
      }),
    ).toBe(false);
    expect(
      browserNeedsStandaloneDisplayStack({
        headless: false,
        linkedComputer: false,
        nativeBrowserControl: false,
      }),
    ).toBe(true);
    expect(
      browserNeedsStandaloneDisplayStack({
        headless: true,
        linkedComputer: false,
        nativeBrowserControl: false,
      }),
    ).toBe(false);

    const source = await readFile(routeUrl, "utf8");
    expect(source.match(/linkedComputer !== null,/gu)).toHaveLength(4);
    expect(source).toContain(
      'nativeBrowserControl: typeof session.ensureBrowserControl === "function"',
    );
  });

  test("publishes encrypted profile state only after durable dispatch", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/revisions"',
    );
    const end = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"',
      start,
    );
    const route = source.slice(start, end);
    expect(route.indexOf("prepareBrowserRevisionPublication")).toBeGreaterThanOrEqual(0);
    expect(route.indexOf('prepared.kind === "completed"')).toBeLessThan(
      route.indexOf("const objectStorage = deps.objectStorage"),
    );
    expect(route.indexOf("dispatchBrowserRevisionPublication")).toBeLessThan(
      route.indexOf("stateUpload"),
    );
    expect(route.indexOf("stateUpload")).toBeLessThan(route.indexOf("createPutUrl"));
    expect(route.indexOf("createPutUrl")).toBeLessThan(route.indexOf("client.captureState"));
    expect(route.indexOf("client.captureState")).toBeLessThan(
      route.indexOf("commitBrowserRevisionPublication"),
    );
    expect(route).toContain("dataKey.fill(0)");
    expect(route).toContain("rootKey.fill(0)");
  });

  test("ends a browser whose controller is gone in the control plane, fenced by its generation", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"',
    );
    const route = source.slice(start, source.indexOf("async function withBrowserPlacement", start));
    const gone = route.indexOf(
      "browserControllerGone(grant, workspaceId, record.session.placement)",
    );
    expect(gone).toBeGreaterThan(route.indexOf("const binding = record.session.controller"));
    // The gone check runs before any controller dispatch, and the server-side
    // completion keeps the bound generation so that controller stays fenced.
    expect(gone).toBeLessThan(route.indexOf("dispatchBrowserSessionOperation"));
    expect(gone).toBeLessThan(route.indexOf("withBrowserPlacement("));
    const completion = route.slice(gone, route.indexOf("requireSourceSession", gone));
    expect(completion).toContain(
      "expectedControllerGeneration: binding?.controllerGeneration ?? null",
    );
    expect(completion).toContain("releaseInteractionHolder");
    expect(completion).toContain("releaseBrowserPasskeys");
    const helper = source.slice(source.indexOf("async function browserControllerGone"));
    expect(helper.slice(0, helper.indexOf("\n  }\n"))).toContain("interactionControllerGone(");
  });

  test("only the person's explicit end may discard a lost browser's preserved runtime", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"',
    );
    const route = source.slice(start, source.indexOf("async function withBrowserPlacement", start));
    expect(route).toContain("endBrowserDiscardingLostRuntime(client");
    // Cleanup after a failed or expired resume keeps a possibly accepted
    // launch preserved for recovery.
    expect(source.split("endBrowserDiscardingLostRuntime(").length - 1).toBe(1);
    expect(source).not.toContain("discardWorkingRuntime");
  });

  test("adopts a preserved working copy only under existing control authority, attributed before any effect", async () => {
    const source = await readFile(routeUrl, "utf8");
    for (const route of [
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/working-copy/inspection"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/working-copy/adoptions"',
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/working-copy/adoptions/:operationId"',
    ]) {
      expect(source).toContain(route);
    }
    const helperStart = source.indexOf("async function withPreservedWorkingCopy");
    const helper = source.slice(helperStart, source.indexOf("app.post(", helperStart));
    // The same session.control + placement authority as any browser control;
    // no extra role gate, and a missing controller session is never relaunched.
    expect(helper).toContain('"sessions:control"');
    expect(helper).toContain('"session.control"');
    expect(helper).toContain('"browser.control"');
    expect(helper).toMatch(/\/\/ A missing controller session[\s\S]*false,\n {4}\);/u);
    expect(helper).toContain('browserSessionStorageMode(record.session) !== "private_profile"');
    const adoptStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/working-copy/adoptions",',
    );
    const adopt = source.slice(adoptStart, source.indexOf("app.get(", adoptStart));
    expect(adopt.indexOf("parseJsonBody(context, BrowserWorkingCopyAdoptionRequest)")).toBeLessThan(
      adopt.indexOf("withPreservedWorkingCopy("),
    );
    expect(adopt.indexOf('"browserSession.working_copy.adoption_requested"')).toBeLessThan(
      adopt.indexOf("client.adoptWorkingCopy("),
    );
    expect(adopt.split("client.adoptWorkingCopy(").length - 1).toBe(1);
    // Freshness is reported as unknown, never inferred.
    expect(source).toContain('freshness: { status: "unknown"');
  });

  test("suspends only after encrypted capture and resumes only from durable authority", async () => {
    const source = await readFile(routeUrl, "utf8");
    const suspendStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/suspend"',
    );
    const resumeStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/resume"',
      suspendStart,
    );
    const endStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"',
      resumeStart,
    );
    const suspend = source.slice(suspendStart, resumeStart);
    const resume = source.slice(resumeStart, endStart);
    expect(suspend).toContain("if (isTerminalOperation(prepared.operation.state))");
    expect(resume).toContain("if (isTerminalOperation(prepared.operation.state))");
    expect(suspend.indexOf("dispatchBrowserSessionOperation")).toBeLessThan(
      suspend.indexOf("stateUpload"),
    );
    expect(suspend.indexOf("stateUpload")).toBeLessThan(suspend.indexOf("createPutUrl"));
    expect(suspend.indexOf("createPutUrl")).toBeLessThan(suspend.indexOf("client.captureState"));
    expect(suspend).toContain('afterCapture: "stop"');
    expect(suspend.indexOf("client.captureState")).toBeLessThan(
      suspend.indexOf("commitBrowserSessionSuspension"),
    );
    expect(suspend.indexOf("commitBrowserSessionSuspension")).toBeLessThan(
      suspend.indexOf("endCapturedBrowserController"),
    );
    expect(resume.indexOf("getBrowserPrivateCheckpointAuthority")).toBeLessThan(
      resume.indexOf("prepareBrowserPrivateCheckpointRestore"),
    );
    expect(resume.indexOf("prepareBrowserPrivateCheckpointRestore")).toBeLessThan(
      resume.indexOf("resolveBrowserNetworkRouteLaunch"),
    );
    expect(resume.indexOf("resolveBrowserNetworkRouteLaunch")).toBeLessThan(
      resume.indexOf("ensureDispatchedGeneration"),
    );
    expect(resume.indexOf("ensureDispatchedGeneration")).toBeLessThan(
      resume.indexOf("client.createSession"),
    );
    expect(resume).toContain("...(networkRoute ? { networkRoute } : {})");
  });

  test("resumes an expired resume only after ending its retained controller generation", async () => {
    const source = await readFile(routeUrl, "utf8");
    const resumeStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/resume"',
    );
    const resume = source.slice(
      resumeStart,
      source.indexOf('"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"'),
    );
    expect(resume).toContain('before.session.failureCode === "controller_transition_expired"');
    expect(resume.indexOf("settleExpiredBrowserResume(")).toBeLessThan(
      resume.indexOf("prepareBrowserSessionResume(deps.db"),
    );
    const settle = source.slice(
      source.indexOf("async function settleExpiredBrowserResume"),
      source.indexOf("async function finishSuspendedBrowserControllerCleanup"),
    );
    // Ineligible losses (create, suspend, end) never reach a controller call.
    expect(settle.indexOf("if (!expired) return;")).toBeGreaterThan(
      settle.indexOf("getExpiredBrowserSessionResume(deps.db"),
    );
    expect(settle.indexOf("if (!expired) return;")).toBeLessThan(
      settle.indexOf("withBrowserPlacement("),
    );
    expect(settle).toContain("binding.placementInstanceId");
    // An interrupted launch is set aside intact, never discarded.
    expect(settle.indexOf("endExpiredResumeSettingAsideInterruptedLaunch(")).toBeGreaterThan(-1);
    expect(settle.indexOf("endExpiredResumeSettingAsideInterruptedLaunch(")).toBeLessThan(
      settle.indexOf("settleExpiredBrowserSessionResume(deps.db"),
    );
    expect(settle).not.toContain("discardWorkingRuntime");
    expect(settle).toContain("expectedControllerGeneration: expired.controllerGeneration");
  });

  test("continues an expired resume on its retained working copy before restoring over it", async () => {
    const source = await readFile(routeUrl, "utf8");
    const resumeStart = source.indexOf(
      '"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/resume"',
    );
    const resume = source.slice(
      resumeStart,
      source.indexOf('"/v1/workspaces/:workspaceId/browser-sessions/:browserSessionId/end"'),
    );
    // Continuation is tried first; only a refusal falls back to settle + restore.
    expect(resume.indexOf("continueExpiredBrowserResume(")).toBeGreaterThan(-1);
    expect(resume.indexOf("continueExpiredBrowserResume(")).toBeLessThan(
      resume.indexOf("settleExpiredBrowserResume("),
    );
    expect(resume.indexOf("if (continued)")).toBeLessThan(
      resume.indexOf("settleExpiredBrowserResume("),
    );
    const continuation = source.slice(
      source.indexOf("async function continueExpiredBrowserResume"),
      source.indexOf("async function settleExpiredBrowserResume"),
    );
    expect(continuation).toContain("if (!expired?.controllerGeneration) return null;");
    expect(continuation).toContain(
      'browserSessionStorageMode(record.session) !== "private_profile"',
    );
    // The same generation is re-adopted from its own working directory on the
    // controller instance that holds it; nothing is restored or discarded.
    expect(continuation).toContain("binding.placementInstanceId");
    expect(continuation).toContain("controllerGeneration: binding.controllerGeneration");
    expect(continuation).toContain("recoverExistingWorkingDirectory: true");
    // Its operation is recorded only after adoption, so the heartbeat holds the
    // expired resume itself rather than a not-yet-recorded operation.
    expect(continuation).toContain("continuesExpiredBrowserResume: true");
    expect(continuation).not.toContain("restore:");
    expect(continuation).not.toContain("endSession");
    expect(continuation).not.toContain("removeState");
    expect(continuation).toContain('error.error.code === "resource_unavailable"');
    expect(continuation.indexOf("client.createSession(")).toBeLessThan(
      continuation.indexOf("continueExpiredBrowserSessionResume(deps.db"),
    );
  });

  test("preserves exact human, service, and agent-attempt action provenance", () => {
    const grant = {
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      subjectId: "subject",
      permissions: [] as const,
    };
    expect(interactionActorForGrant({ ...grant, principalKind: "human_session" })).toEqual({
      kind: "human",
      subjectId: "subject",
    });
    expect(interactionActorForGrant({ ...grant, principalKind: "service" })).toEqual({
      kind: "system",
      subjectId: "subject",
    });
    expect(
      interactionActorForGrant({
        ...grant,
        principalKind: "agent_attempt",
        metadata: {
          sessionId: "33333333-3333-4333-8333-333333333333",
          turnId: "44444444-4444-4444-8444-444444444444",
          attemptId: "55555555-5555-4555-8555-555555555555",
          executionGeneration: 2,
        },
      }),
    ).toEqual({
      kind: "agent",
      subjectId: "subject",
      sessionId: "33333333-3333-4333-8333-333333333333",
      turnId: "44444444-4444-4444-8444-444444444444",
      attemptId: "55555555-5555-4555-8555-555555555555",
      executionGeneration: 2,
    });
  });

  test("accepts first-party interaction origins without widening credentialed CORS", () => {
    const input = {
      corsAllowOriginRegex: "https://trusted-embed\\.test",
      publicBaseUrl: "https://app.opengeni.test/",
      webBaseUrl: "https://web.opengeni.test",
    };
    expect(validateInteractionRequestOrigin(undefined, input)).toBeNull();
    expect(validateInteractionRequestOrigin("https://app.opengeni.test", input)).toBe(
      "https://app.opengeni.test",
    );
    expect(allowedCorsOrigin(input.corsAllowOriginRegex, "https://app.opengeni.test")).toBe(false);
    expect(validateInteractionRequestOrigin("https://web.opengeni.test", input)).toBe(
      "https://web.opengeni.test",
    );
    expect(validateInteractionRequestOrigin("https://trusted-embed.test", input)).toBe(
      "https://trusted-embed.test",
    );
    expect(() => validateInteractionRequestOrigin("https://other.test", input)).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => validateInteractionRequestOrigin("https://app.opengeni.test/path", input)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

test("working copy routes carry the browser record's exact authority, and only adoption changes anything", async () => {
  const directory = await mkdtemp("/tmp/og-api-working-copy-");
  const script = join(directory, "synthetic-working-copy-route.ts");
  await writeFile(script, `(${workingCopyRoutesFixture.toString()})()`, { mode: 0o600 });
  const child = Bun.spawn([process.execPath, "--no-env-file", script, routeUrl.href], {
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      {
        scenario: "inspect",
        status: 200,
        calls: ["POST /working-copy/inspection"],
        exactAuthority: true,
        audits: [],
        adoptable: true,
        explainsExclusions: true,
      },
      {
        scenario: "status",
        status: 200,
        calls: ["GET /working-copy/adoptions/:operationId"],
        exactAuthority: true,
        audits: [],
        phase: "receipt",
      },
      {
        scenario: "adopt",
        status: 200,
        calls: ["POST /working-copy/adoptions"],
        exactAuthority: true,
        audits: [
          "browserSession.working_copy.adoption_requested",
          "controller",
          "browserSession.working_copy.adoption_settled",
        ],
        phase: "adopted",
      },
      {
        scenario: "adopt-token-rotated",
        status: 200,
        calls: ["POST /working-copy/adoptions"],
        exactAuthority: true,
        audits: [
          "browserSession.working_copy.adoption_requested",
          "controller",
          "browserSession.working_copy.adoption_settled",
        ],
        phase: "adopted",
      },
      {
        scenario: "revert",
        status: 200,
        calls: ["POST /working-copy/adoptions/:operationId/revert"],
        exactAuthority: true,
        audits: [
          "browserSession.working_copy.revert_requested",
          "controller",
          "browserSession.working_copy.revert_settled",
        ],
        phase: "reverted",
      },
      ...["holder-lost", "machine-moved", "access-revoked"].map((scenario) => ({
        scenario,
        // A revoked source session hides the browser instead of refusing it.
        status: scenario === "access-revoked" ? 404 : 409,
        calls: [],
        exactAuthority: true,
        audits: [],
      })),
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

/** Drives the three working copy routes in a separate process against a fake
 * controller, recording every controller request and audit write. */
async function workingCopyRoutesFixture() {
  const routeHref = process.argv[2]!;
  const apiDirectory = new URL("..", routeHref).pathname;
  const resolveFromApi = (name: string) => Bun.resolveSync(name, apiDirectory);
  const { mock } = await import("bun:test");
  const { randomUUID } = await import("node:crypto");
  const { Hono } = (await import(resolveFromApi("hono"))) as typeof import("hono");
  const { HTTPException: FixtureHTTPException } = (await import(
    resolveFromApi("hono/http-exception")
  )) as typeof import("hono/http-exception");
  const db = (await import(resolveFromApi("@opengeni/db"))) as typeof import("@opengeni/db");
  const core = (await import(resolveFromApi("@opengeni/core"))) as typeof import("@opengeni/core");
  const { testSettings: fixtureSettings } = (await import(
    resolveFromApi("@opengeni/testing")
  )) as typeof import("@opengeni/testing");
  const authority = await import(new URL("../browser-controller-authority.ts", routeHref).href);
  const accountId = randomUUID(),
    workspaceId = randomUUID(),
    browserSessionId = randomUUID(),
    sourceSessionId = randomUUID(),
    machineId = randomUUID(),
    instanceId = randomUUID(),
    controllerGeneration = randomUUID(),
    operationId = randomUUID(),
    rootSecret = "synthetic-controller-authority",
    digest = "d".repeat(64);
  const grant = {
    accountId,
    workspaceId,
    subjectId: "synthetic-user",
    permissions: ["sessions:control"],
  };
  const placement = { kind: "connected_machine", sandboxId: machineId };
  let scenario = "inspect";
  let calls: string[] = [];
  let audits: string[] = [];
  let exactAuthority = true;
  const tokenGeneration = () => (scenario === "adopt-token-rotated" ? 2 : 1);
  mock.module(resolveFromApi("@opengeni/db"), () => ({
    ...db,
    getBrowserSessionControlRecord: async () => ({
      sourceSessionId,
      tokenGeneration: tokenGeneration(),
      controllerHostSandboxGroupId: null,
      networkRouteAuthority: null,
      session: {
        id: browserSessionId,
        workspaceId,
        lifecycle: "active",
        placement,
        controller: {
          controllerId: "opengeni-browserd",
          controllerGeneration,
          placementInstanceId: instanceId,
        },
        driverId: "opengeni.cdp.v1",
        engine: "chromium",
        headless: true,
        linkedComputerSessionId: null,
        networkRouteId: null,
      },
    }),
    getSession: async () => ({
      id: sourceSessionId,
      workspaceId,
      activeSandboxId: scenario === "machine-moved" ? randomUUID() : machineId,
    }),
    touchBrowserSessionController: async () => scenario !== "holder-lost",
    terminalizeStaleConnectedInteractionPlacement: async () => ({ sourcePlacementChanged: false }),
    getBrowserPrivateCheckpointAuthority: async () => null,
    recordAuditEvent: async (_db: unknown, event: { action: string }) => {
      audits.push(event.action);
    },
  }));
  mock.module(resolveFromApi("@opengeni/core"), () => ({
    ...core,
    requireAccessGrant: async () => grant,
    requireSessionAuthorization: async (
      _deps: unknown,
      _grant: unknown,
      input: { operation: string },
    ) => {
      if (input.operation !== "session.control") throw new Error("synthetic operation mismatch");
      if (scenario === "access-revoked") throw new core.SessionAuthorizationDeniedError("revoked");
      return {};
    },
  }));
  const success = (data: unknown) => Response.json({ protocolVersion: 1, ok: true, data });
  const expectedAdmin = authority.deriveBrowserControllerAdminToken({
    rootSecret,
    accountId,
    workspaceId,
    placement,
    placementInstanceId: instanceId,
  });
  const adoption = (phase: string) => ({
    operationId,
    browserSessionId,
    controllerGeneration,
    manifestDigest: digest,
    phase,
    failureCode: null,
    retainedDirectories: [],
    createdAt: "2026-10-16T10:00:00.000Z",
    updatedAt: "2026-10-16T10:00:01.000Z",
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const prefix = `/v1/browser-sessions/${browserSessionId}`;
      const route = path.startsWith(prefix)
        ? path.slice(prefix.length).replace(operationId, ":operationId")
        : path;
      calls.push(`${request.method} ${route}`);
      audits.push("controller");
      if (request.headers.get("authorization") !== `Bearer ${expectedAdmin}`)
        exactAuthority = false;
      if (request.method === "POST") {
        const tokens = authority.deriveBrowserSessionControllerTokens({
          rootSecret,
          accountId,
          workspaceId,
          placement,
          placementInstanceId: instanceId,
          browserSessionId,
          controllerGeneration,
          tokenGeneration: tokenGeneration(),
        });
        const body = (await request.json()) as Record<string, unknown>;
        const { operationId: requestedOperation, manifestDigest, ...authorityBody } = body;
        if (
          JSON.stringify(authorityBody) !==
          JSON.stringify({
            controllerGeneration,
            tokenGeneration: tokenGeneration(),
            controlToken: tokens.controlToken,
            viewToken: tokens.viewToken,
          })
        )
          exactAuthority = false;
        if (route === "/working-copy/adoptions") {
          if (requestedOperation !== operationId || manifestDigest !== digest)
            exactAuthority = false;
          return success(adoption("adopted"));
        }
        if (route === "/working-copy/adoptions/:operationId/revert") {
          if (requestedOperation !== undefined || manifestDigest !== undefined)
            exactAuthority = false;
          return success({ inFlight: false, adoption: adoption("reverted") });
        }
        return success({
          browserSessionId,
          controllerGeneration,
          platformSupported: true,
          manifest: {
            digest,
            entries: 12,
            bytes: 4096,
            excluded: ["chrome-launch", "working-runtime.sqlite-shm"],
          },
          currentProfile: { device: 1, inode: 2 },
          receipt: {
            operationId: randomUUID(),
            intent: "launch",
            state: "completed",
            recordedProfile: { device: 1, inode: 3 },
            restoreAuthorityDigest: "e".repeat(64),
            directoryLaunchAllowed: true,
            authorityMatches: true,
            adoption: null,
          },
          profileIdentityMatches: false,
          profileInUse: false,
          activeAdoption: null,
          refusal: null,
        });
      }
      return success({ inFlight: false, adoption: adoption("receipt") });
    },
  });
  const channelHref = new URL("../sandbox/channel-a.ts", routeHref).href;
  const channel = await import(channelHref);
  const routed = async (
    _services: unknown,
    _context: unknown,
    callback: (handle: unknown) => Promise<unknown>,
  ) =>
    await callback({
      routingSession: {
        prime: async () => ({
          kind: "selfhosted",
          sandboxId: machineId,
          providerInstanceId: instanceId,
          session: {
            resolveExposedPort: async () => ({ host: "127.0.0.1", port: server.port, tls: false }),
          },
        }),
      },
    });
  mock.module(channelHref, () => ({ ...channel, withChannelARead: routed, withChannelA: routed }));
  const { registerBrowserSessionRoutes } = await import(routeHref);
  const app = new Hono();
  app.onError((error, context) =>
    context.json(
      { message: error.message },
      (error instanceof FixtureHTTPException
        ? error.status
        : ((error as { status?: number }).status ?? 500)) as never,
    ),
  );
  registerBrowserSessionRoutes(app, {
    settings: fixtureSettings({ delegationSecret: rootSecret }),
    db: {},
    bus: {},
  } as never);
  const originalError = console.error;
  console.error = () => {};
  try {
    const base = `https://api.example.test/v1/workspaces/${workspaceId}/browser-sessions/${browserSessionId}/working-copy`;
    const results = [];
    for (const next of [
      "inspect",
      "status",
      "adopt",
      "adopt-token-rotated",
      "revert",
      "holder-lost",
      "machine-moved",
      "access-revoked",
    ]) {
      scenario = next;
      calls = [];
      audits = [];
      exactAuthority = true;
      const response =
        next === "inspect"
          ? await app.request(`${base}/inspection`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            })
          : next === "status"
            ? await app.request(`${base}/adoptions/${operationId}`)
            : next === "revert"
              ? await app.request(`${base}/adoptions/${operationId}/revert`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: "{}",
                })
              : await app.request(`${base}/adoptions`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ operationId, manifestDigest: digest }),
                });
      const body = (await response.json()) as Record<string, any>;
      const result: Record<string, unknown> = {
        scenario: next,
        status: response.status,
        calls,
        exactAuthority,
        audits: audits.filter(
          (entry) => entry !== "controller" || next.startsWith("adopt") || next === "revert",
        ),
      };
      if (response.status === 200 && next === "inspect") {
        result.adoptable = body.adoptable;
        result.explainsExclusions = String(body.explanation).includes(
          "chrome-launch, working-runtime.sqlite-shm",
        );
      } else if (response.status === 200) {
        result.phase = body.adoption?.phase;
      }
      results.push(result);
    }
    console.log(JSON.stringify(results));
  } finally {
    console.error = originalError;
    await server.stop(true);
  }
}
