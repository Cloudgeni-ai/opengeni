import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  acquireLease,
  activateBrowserSession,
  activateComputerSession,
  ATTACHED_BROWSER_SESSION_CAPABILITIES,
  bindBrowserSessionNetworkRouteAuthority,
  bootstrapWorkspace,
  BrowserSessionNotFoundError,
  BrowserSessionOperationConflictError,
  BrowserSessionStateError,
  ComputerSessionStateError,
  clearSuspendedBrowserSessionController,
  commitBrowserSessionSuspension,
  commitWarmingToWarm,
  completeBrowserSessionEnd,
  createDb,
  createNetworkRoute,
  createSession,
  dispatchBrowserSessionOperation,
  dispatchComputerSessionOperation,
  failBrowserSessionSuspension,
  failBrowserSessionOperation,
  findBrowserSessionControlRecordByOperation,
  getBrowserSession,
  getBrowserSessionControlRecord,
  getBrowserPrivateCheckpointAuthority,
  listBrowserSessions,
  prepareBrowserSessionCreate,
  prepareBrowserSessionEnd,
  prepareBrowserSessionResume,
  prepareBrowserSessionSuspend,
  prepareComputerSessionCreate,
  prepareComputerSessionEnd,
  reapStaleLeaseHolders,
  touchBrowserSessionController,
} from "../src";
import type { BrowserStateArtifactCommitInput } from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("browser-sessions");
  if (!shared) {
    available = false;
    console.warn("[browser-sessions] postgres unavailable, skipping");
    return;
  }
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
});

async function fixture() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `browser-account-${suffix}`,
    accountName: "BrowserSession test",
    workspaceExternalSource: "test",
    workspaceExternalId: `browser-workspace-${suffix}`,
    workspaceName: "BrowserSession test",
    subjectId: `browser-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    sandboxBackend: "none",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    sessionId: session.id,
    sandboxGroupId: session.sandboxGroupId,
  };
}

function createInput(
  scope: Awaited<ReturnType<typeof fixture>>,
  operationId = crypto.randomUUID(),
) {
  return {
    ...scope,
    operationId,
    associatedSessionId: scope.sessionId,
    actorSubjectId: scope.subjectId,
    name: "Research browser",
    initialUrl: "https://example.com/",
    placement: { kind: "sandbox_group" as const, sandboxGroupId: scope.sandboxGroupId },
    driverId: "opengeni.cdp.v1",
    engine: "chromium" as const,
    headless: true,
    identityId: null,
    baseRevisionId: null,
  };
}

async function activeBrowser(scope: Awaited<ReturnType<typeof fixture>>) {
  const operationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(client.db, createInput(scope, operationId));
  const controllerGeneration = crypto.randomUUID();
  await dispatchBrowserSessionOperation(client.db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controllerGeneration,
  });
  const active = await activateBrowserSession(client.db, {
    ...scope,
    operationId,
    browserSessionId: prepared.session.id,
    controller: {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    },
    engineVersion: "151.0.7922.108",
  });
  return { ...active, controllerGeneration };
}

function checkpointArtifact(
  scope: Awaited<ReturnType<typeof fixture>>,
  operationId: string,
): BrowserStateArtifactCommitInput {
  return {
    kind: "chromium_profile",
    format: "application/vnd.opengeni.browser-profile.v1+tar+gzip+aes256gcm",
    artifactDigest: "a".repeat(64),
    contentDigest: "b".repeat(64),
    manifestDigest: "c".repeat(64),
    objectKey: `workspaces/${scope.workspaceId}/browser-state/checkpoints/${operationId}.ogbp`,
    encryptedDataKey: `wrapped-data-key-${operationId}`,
    sizeBytes: 4_096,
    materialization: {
      portability: "portable",
      reason: null,
      platform: "linux",
      architecture: "x64",
      engine: "chromium",
      engineVersion: "151.0.7922.108",
      driverId: "opengeni.cdp.v1",
      driverSchemaVersion: 1,
      profileCrypto: "chromium_basic",
      providerId: null,
      placement: null,
    },
  };
}

describe("durable BrowserSession lifecycle", () => {
  test("binds a headed browser to one active same-placement ComputerSession", async () => {
    if (!available) return;
    const scope = await fixture();
    const computerOperationId = crypto.randomUUID();
    const computer = await prepareComputerSessionCreate(client.db, {
      ...scope,
      operationId: computerOperationId,
      associatedSessionId: scope.sessionId,
      actorSubjectId: scope.subjectId,
      name: "Browser computer",
      placement: { kind: "sandbox_group", sandboxGroupId: scope.sandboxGroupId },
    });
    const computerController = {
      controllerId: "browserd:test",
      controllerGeneration: crypto.randomUUID(),
      placementInstanceId: "placement:test",
    };
    await dispatchComputerSessionOperation(client.db, {
      ...scope,
      operationId: computerOperationId,
      computerSessionId: computer.session.id,
      controllerGeneration: computerController.controllerGeneration,
      controller: computerController,
    });
    await activateComputerSession(client.db, {
      ...scope,
      operationId: computerOperationId,
      computerSessionId: computer.session.id,
      controller: computerController,
      platform: "linux",
      adapter: "opengeni.atspi-x11.v1",
      seatId: "seat:browser",
      displayId: ":101",
      capabilities: {
        semanticObservation: true,
        appDiscovery: true,
        appLaunch: true,
        windowCapture: true,
        screenCapture: true,
        semanticActions: true,
        pointerInput: true,
        keyboardInput: true,
        backgroundActions: true,
        parallelApps: true,
      },
    });

    const browser = await prepareBrowserSessionCreate(client.db, {
      ...createInput(scope),
      headless: false,
      linkedComputerSessionId: computer.session.id,
    });
    expect(browser.session).toMatchObject({
      headless: false,
      linkedComputerSessionId: computer.session.id,
      capabilities: { linkedComputer: true },
    });
    const browserController = {
      controllerId: "browserd:test",
      controllerGeneration: crypto.randomUUID(),
      placementInstanceId: computerController.placementInstanceId,
    };
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId: browser.operation.operationId,
      browserSessionId: browser.session.id,
      controllerGeneration: browserController.controllerGeneration,
      controller: browserController,
    });
    await activateBrowserSession(client.db, {
      ...scope,
      operationId: browser.operation.operationId,
      browserSessionId: browser.session.id,
      controller: browserController,
      engineVersion: "151.0.7922.108",
    });
    await expect(
      prepareComputerSessionEnd(client.db, {
        ...scope,
        computerSessionId: computer.session.id,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
      }),
    ).rejects.toBeInstanceOf(ComputerSessionStateError);
    await prepareBrowserSessionEnd(client.db, {
      ...scope,
      browserSessionId: browser.session.id,
      operationId: crypto.randomUUID(),
      actorSubjectId: scope.subjectId,
    });
    await expect(
      prepareComputerSessionEnd(client.db, {
        ...scope,
        computerSessionId: computer.session.id,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
      }),
    ).rejects.toBeInstanceOf(ComputerSessionStateError);
    await expect(
      prepareBrowserSessionCreate(client.db, {
        ...createInput(scope),
        placement: { kind: "connected_machine", sandboxId: crypto.randomUUID() },
        headless: false,
        linkedComputerSessionId: computer.session.id,
      }),
    ).rejects.toBeInstanceOf(BrowserSessionStateError);
  });

  test("rejects checkpoint suspension when the BrowserSession lacks that capability", async () => {
    if (!available) return;
    const scope = await fixture();
    const operationId = crypto.randomUUID();
    const prepared = await prepareBrowserSessionCreate(client.db, {
      ...createInput(scope, operationId),
      capabilities: ATTACHED_BROWSER_SESSION_CAPABILITIES,
    });
    const controllerGeneration = crypto.randomUUID();
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      controllerGeneration,
    });
    await activateBrowserSession(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      controller: {
        controllerId: "browserd:test",
        controllerGeneration,
        placementInstanceId: "chrome-generation:test",
      },
      engineVersion: "151.0.7922.108",
    });

    await expect(
      prepareBrowserSessionSuspend(client.db, {
        ...scope,
        browserSessionId: prepared.session.id,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
      }),
    ).rejects.toBeInstanceOf(BrowserSessionStateError);
  });

  test("collapses concurrent create retries into one immutable resource", async () => {
    if (!available) return;
    const scope = await fixture();
    const operationId = crypto.randomUUID();
    const input = createInput(scope, operationId);
    const [first, second] = await Promise.all([
      prepareBrowserSessionCreate(client.db, input),
      prepareBrowserSessionCreate(client.db, input),
    ]);

    expect(first.session.id).toBe(second.session.id);
    expect(new Set([first.operation.replayed, second.operation.replayed])).toEqual(
      new Set([false, true]),
    );
    expect(first.session.lifecycle).toBe("starting");
    expect(
      (
        await findBrowserSessionControlRecordByOperation(client.db, {
          ...scope,
          operationId,
        })
      )?.session.id,
    ).toBe(first.session.id);
    expect((await listBrowserSessions(client.db, scope)).sessions).toHaveLength(1);

    await expect(
      prepareBrowserSessionCreate(client.db, { ...input, name: "Different request" }),
    ).rejects.toBeInstanceOf(BrowserSessionOperationConflictError);
  });

  test("persists dispatch and activation under the exact controller fence", async () => {
    if (!available) return;
    const scope = await fixture();
    const operationId = crypto.randomUUID();
    const prepared = await prepareBrowserSessionCreate(client.db, createInput(scope, operationId));
    expect(
      await getBrowserSessionControlRecord(client.db, {
        ...scope,
        browserSessionId: prepared.session.id,
        operationId,
      }),
    ).toMatchObject({
      tokenGeneration: 1,
      sourceSessionId: scope.sessionId,
      createOperationId: operationId,
      operation: {
        operationId,
        kind: "create",
        state: "prepared",
        controllerGeneration: null,
        actorSubjectId: scope.subjectId,
      },
    });
    const controllerGeneration = crypto.randomUUID();
    const controller = {
      controllerId: "browserd:test",
      controllerGeneration,
      placementInstanceId: "placement:test",
    };
    const dispatched = await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      controllerGeneration,
      controller,
    });
    expect(dispatched.state).toBe("dispatched");
    expect(
      (
        await getBrowserSessionControlRecord(client.db, {
          ...scope,
          browserSessionId: prepared.session.id,
          operationId,
        })
      ).operation,
    ).toMatchObject({ state: "dispatched", controllerGeneration });
    expect(
      (
        await getBrowserSessionControlRecord(client.db, {
          ...scope,
          browserSessionId: prepared.session.id,
        })
      ).session.controller,
    ).toEqual(controller);

    const activated = await activateBrowserSession(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      controller,
      engineVersion: "151.0.7922.108",
    });
    expect(activated.operation.state).toBe("completed");
    expect(activated.session).toMatchObject({
      lifecycle: "active",
      controller: { controllerGeneration },
      engineVersion: "151.0.7922.108",
    });
    const replay = await activateBrowserSession(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      controller: activated.session.controller!,
      engineVersion: "151.0.7922.108",
    });
    expect(replay.operation.replayed).toBe(true);
    expect((await listBrowserSessions(client.db, scope)).revision).toBe(2);

    await expect(
      dispatchBrowserSessionOperation(client.db, {
        ...scope,
        operationId,
        browserSessionId: prepared.session.id,
        controllerGeneration: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(BrowserSessionOperationConflictError);
  });

  test("settles failure once with a durable structured error", async () => {
    if (!available) return;
    const scope = await fixture();
    const operationId = crypto.randomUUID();
    const prepared = await prepareBrowserSessionCreate(client.db, createInput(scope, operationId));
    const failed = await failBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      error: { code: "driver_failed", message: "Chromium exited", retryable: true },
    });
    expect(failed.session).toMatchObject({ lifecycle: "failed", failureCode: "driver_failed" });
    expect(failed.operation).toMatchObject({
      state: "failed",
      error: { code: "driver_failed", retryable: true },
    });
    const replay = await failBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      error: { code: "timeout", message: "different retry", retryable: true },
    });
    expect(replay.operation).toMatchObject({
      replayed: true,
      error: { code: "driver_failed", message: "Chromium exited" },
    });
  });

  test("preserves an uncertain dispatched controller binding for exact cleanup", async () => {
    if (!available) return;
    const scope = await fixture();
    const operationId = crypto.randomUUID();
    const prepared = await prepareBrowserSessionCreate(client.db, createInput(scope, operationId));
    const controller = {
      controllerId: "browserd:test",
      controllerGeneration: crypto.randomUUID(),
      placementInstanceId: "placement:test",
    };
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      controllerGeneration: controller.controllerGeneration,
      controller,
    });
    const failed = await failBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      state: "outcome_unknown",
      error: { code: "driver_failed", message: "malformed receipt", retryable: false },
    });
    expect(failed.session).toMatchObject({ lifecycle: "lost", controller });
  });

  test("serializes end and rejects a second active lifecycle operation", async () => {
    if (!available) return;
    const scope = await fixture();
    const active = await activeBrowser(scope);
    const operationId = crypto.randomUUID();
    const ending = await prepareBrowserSessionEnd(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId,
      actorSubjectId: scope.subjectId,
    });
    expect(ending.session.lifecycle).toBe("ending");
    await expect(
      prepareBrowserSessionEnd(client.db, {
        ...scope,
        browserSessionId: active.session.id,
        operationId: crypto.randomUUID(),
        actorSubjectId: scope.subjectId,
      }),
    ).rejects.toBeInstanceOf(BrowserSessionOperationConflictError);

    const ended = await completeBrowserSessionEnd(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId,
      expectedControllerGeneration: active.controllerGeneration,
    });
    expect(ended.session).toMatchObject({ lifecycle: "ended", controller: null });
    expect(ended.operation.state).toBe("completed");
    expect(
      (
        await completeBrowserSessionEnd(client.db, {
          ...scope,
          browserSessionId: active.session.id,
          operationId,
          expectedControllerGeneration: active.controllerGeneration,
        })
      ).operation.replayed,
    ).toBe(true);
  });

  test("never resurrects a failed terminal end operation", async () => {
    if (!available) return;
    const scope = await fixture();
    const active = await activeBrowser(scope);
    const operationId = crypto.randomUUID();
    await prepareBrowserSessionEnd(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId,
      actorSubjectId: scope.subjectId,
    });
    const failed = await failBrowserSessionOperation(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId,
      error: { code: "driver_failed", message: "end rejected", retryable: false },
    });
    expect(failed).toMatchObject({
      session: { lifecycle: "failed" },
      operation: { state: "failed" },
    });

    await expect(
      completeBrowserSessionEnd(client.db, {
        ...scope,
        browserSessionId: active.session.id,
        operationId,
        expectedControllerGeneration: null,
      }),
    ).rejects.toBeInstanceOf(BrowserSessionStateError);
    expect(
      (
        await failBrowserSessionOperation(client.db, {
          ...scope,
          browserSessionId: active.session.id,
          operationId,
          error: { code: "driver_failed", message: "replay", retryable: false },
        })
      ).operation,
    ).toMatchObject({ state: "failed", replayed: true });
  });

  test("resumes routed private state under fresh controller and route authority fences", async () => {
    if (!available) return;
    const scope = await fixture();
    const route = await createNetworkRoute(client.db, {
      ...scope,
      actorSubjectId: scope.subjectId,
      operationId: crypto.randomUUID(),
      name: `Resume route ${crypto.randomUUID()}`,
      configuration: { kind: "direct" },
      consistency: {
        dns: "placement",
        expectedPublicIp: null,
        expectedRegion: null,
        locale: null,
        timezone: null,
        geolocation: null,
        webRtc: "default",
        stability: "session",
      },
    });
    const createOperationId = crypto.randomUUID();
    const prepared = await prepareBrowserSessionCreate(client.db, {
      ...createInput(scope, createOperationId),
      networkRouteId: route.route.id,
    });
    const initialRouteDigest = `route.${"a".repeat(43)}`;
    await bindBrowserSessionNetworkRouteAuthority(client.db, {
      ...scope,
      browserSessionId: prepared.session.id,
      operationId: createOperationId,
      routeVersion: route.route.version,
      credentialVersion: null,
      authorityDigest: initialRouteDigest,
    });
    const controllerGeneration = crypto.randomUUID();
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId: createOperationId,
      browserSessionId: prepared.session.id,
      controllerGeneration,
    });
    const activated = await activateBrowserSession(client.db, {
      ...scope,
      operationId: createOperationId,
      browserSessionId: prepared.session.id,
      controller: {
        controllerId: "browserd:test",
        controllerGeneration,
        placementInstanceId: "placement:test",
      },
      engineVersion: "151.0.7922.108",
    });
    const active = { ...activated, controllerGeneration };
    const suspendOperationId = crypto.randomUUID();
    const suspending = await prepareBrowserSessionSuspend(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId: suspendOperationId,
      actorSubjectId: scope.subjectId,
    });
    expect(suspending.session.lifecycle).toBe("suspending");
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId: suspendOperationId,
      browserSessionId: active.session.id,
      controllerGeneration: active.controllerGeneration,
    });
    const suspended = await commitBrowserSessionSuspension(client.db, {
      ...scope,
      operationId: suspendOperationId,
      browserSessionId: active.session.id,
      controllerGeneration: active.controllerGeneration,
      artifact: checkpointArtifact(scope, suspendOperationId),
    });
    expect(suspended.session).toMatchObject({
      lifecycle: "suspended",
      controller: { controllerGeneration: active.controllerGeneration },
    });
    expect(
      await getBrowserPrivateCheckpointAuthority(client.db, {
        ...scope,
        browserSessionId: active.session.id,
      }),
    ).toMatchObject({
      objectKey: checkpointArtifact(scope, suspendOperationId).objectKey,
      manifestDigest: "c".repeat(64),
    });

    expect(
      await clearSuspendedBrowserSessionController(client.db, {
        ...scope,
        browserSessionId: active.session.id,
        expectedControllerGeneration: active.controllerGeneration,
      }),
    ).toBe(true);
    expect(
      (
        await getBrowserSessionControlRecord(client.db, {
          ...scope,
          browserSessionId: active.session.id,
        })
      ).session.controller,
    ).toBeNull();

    const resumeOperationId = crypto.randomUUID();
    const restoring = await prepareBrowserSessionResume(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId: resumeOperationId,
      actorSubjectId: scope.subjectId,
    });
    expect(restoring.session.lifecycle).toBe("restoring");
    expect(
      (
        await getBrowserSessionControlRecord(client.db, {
          ...scope,
          browserSessionId: active.session.id,
          operationId: resumeOperationId,
        })
      ).networkRouteAuthority,
    ).toMatchObject({
      routeId: route.route.id,
      routeVersion: route.route.version,
      authorityDigest: null,
    });
    const resumedRouteDigest = `route.${"b".repeat(43)}`;
    await bindBrowserSessionNetworkRouteAuthority(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId: resumeOperationId,
      routeVersion: route.route.version,
      credentialVersion: null,
      authorityDigest: resumedRouteDigest,
    });
    const resumedGeneration = crypto.randomUUID();
    const resumedController = {
      controllerId: "browserd:test",
      controllerGeneration: resumedGeneration,
      placementInstanceId: "placement:resumed",
    };
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId: resumeOperationId,
      browserSessionId: active.session.id,
      controllerGeneration: resumedGeneration,
      controller: resumedController,
    });
    await expect(
      bindBrowserSessionNetworkRouteAuthority(client.db, {
        ...scope,
        browserSessionId: active.session.id,
        operationId: resumeOperationId,
        routeVersion: route.route.version,
        credentialVersion: null,
        authorityDigest: `route.${"c".repeat(43)}`,
      }),
    ).rejects.toBeInstanceOf(BrowserSessionOperationConflictError);
    const resumed = await activateBrowserSession(client.db, {
      ...scope,
      operationId: resumeOperationId,
      browserSessionId: active.session.id,
      controller: resumedController,
      engineVersion: "151.0.7922.108",
    });
    expect(resumed.session).toMatchObject({
      lifecycle: "active",
      controller: resumedController,
    });
    expect(resumedGeneration).not.toBe(active.controllerGeneration);
    expect(
      (
        await getBrowserSessionControlRecord(client.db, {
          ...scope,
          browserSessionId: active.session.id,
        })
      ).networkRouteAuthority,
    ).toMatchObject({ authorityDigest: resumedRouteDigest });
    expect(
      await getBrowserPrivateCheckpointAuthority(client.db, {
        ...scope,
        browserSessionId: active.session.id,
      }),
    ).not.toBeNull();
  });

  test("returns a failed suspension to the same active controller", async () => {
    if (!available) return;
    const scope = await fixture();
    const active = await activeBrowser(scope);
    const operationId = crypto.randomUUID();
    await prepareBrowserSessionSuspend(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId,
      actorSubjectId: scope.subjectId,
    });
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: active.session.id,
      controllerGeneration: active.controllerGeneration,
    });
    const failed = await failBrowserSessionSuspension(client.db, {
      ...scope,
      operationId,
      browserSessionId: active.session.id,
      controllerGeneration: active.controllerGeneration,
      error: { code: "driver_failed", message: "capture failed", retryable: false },
    });
    expect(failed.session).toMatchObject({
      lifecycle: "active",
      controller: { controllerGeneration: active.controllerGeneration },
    });
    expect(failed.operation.state).toBe("failed");
    const replay = await prepareBrowserSessionSuspend(client.db, {
      ...scope,
      browserSessionId: active.session.id,
      operationId,
      actorSubjectId: scope.subjectId,
    });
    expect(replay.operation).toMatchObject({ state: "failed", replayed: true });
    expect(replay.session).toMatchObject({
      lifecycle: "active",
      controller: { controllerGeneration: active.controllerGeneration },
    });
  });

  test("enforces workspace RLS for reads", async () => {
    if (!available) return;
    const owner = await fixture();
    const outsider = await fixture();
    const browser = await prepareBrowserSessionCreate(client.db, createInput(owner));
    expect((await listBrowserSessions(client.db, outsider)).sessions).toHaveLength(0);
    await expect(
      getBrowserSession(client.db, {
        ...outsider,
        browserSessionId: browser.session.id,
      }),
    ).rejects.toBeInstanceOf(BrowserSessionNotFoundError);
    await expect(
      getBrowserSessionControlRecord(client.db, {
        ...outsider,
        browserSessionId: browser.session.id,
      }),
    ).rejects.toBeInstanceOf(BrowserSessionNotFoundError);
  });

  test("rejects a control operation bound to another BrowserSession", async () => {
    if (!available) return;
    const scope = await fixture();
    const first = await prepareBrowserSessionCreate(client.db, createInput(scope));
    const second = await prepareBrowserSessionCreate(client.db, createInput(scope));
    await expect(
      getBrowserSessionControlRecord(client.db, {
        ...scope,
        browserSessionId: first.session.id,
        operationId: second.operation.operationId,
      }),
    ).rejects.toBeInstanceOf(BrowserSessionOperationConflictError);
    expect(
      await findBrowserSessionControlRecordByOperation(client.db, {
        ...scope,
        operationId: crypto.randomUUID(),
      }),
    ).toBeNull();
  });

  test("heartbeats resource and placement holder atomically, then exposes controller loss", async () => {
    if (!available) return;
    const scope = await fixture();
    const holderId = `browser-session:pending`;
    const acquired = await acquireLease(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      sandboxGroupId: scope.sandboxGroupId,
      kind: "interaction",
      holderId,
      subjectId: scope.sessionId,
      backend: "modal",
      leaseTtlMs: 45_000,
    });
    expect(acquired.role).toBe("spawner");
    const warm = await commitWarmingToWarm(client.db, {
      ...scope,
      expectedEpoch: acquired.lease.leaseEpoch,
      instanceId: "placement:test",
      leaseTtlMs: 45_000,
    });
    expect(warm.committed).toBe(true);

    const operationId = crypto.randomUUID();
    const prepared = await prepareBrowserSessionCreate(client.db, createInput(scope, operationId));
    await shared!.admin`
      update sandbox_lease_holders
      set holder_id = ${`browser-session:${prepared.session.id}`}
      where workspace_id = ${scope.workspaceId} and holder_id = ${holderId}`;
    const controllerGeneration = crypto.randomUUID();
    await dispatchBrowserSessionOperation(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      controllerGeneration,
    });
    await activateBrowserSession(client.db, {
      ...scope,
      operationId,
      browserSessionId: prepared.session.id,
      controller: {
        controllerId: "browserd:test",
        controllerGeneration,
        placementInstanceId: "placement:test",
      },
      engineVersion: "151.0.7922.108",
    });
    expect(
      await touchBrowserSessionController(client.db, {
        ...scope,
        browserSessionId: prepared.session.id,
        controllerGeneration,
      }),
    ).toBe(true);
    expect(
      await touchBrowserSessionController(client.db, {
        ...scope,
        browserSessionId: prepared.session.id,
        controllerGeneration: crypto.randomUUID(),
      }),
    ).toBe(false);

    await shared!.admin`
      update sandbox_lease_holders
      set last_heartbeat_at = now() - interval '10 minutes'
      where workspace_id = ${scope.workspaceId} and holder_id = ${`browser-session:${prepared.session.id}`}`;
    const reaped = await reapStaleLeaseHolders(client.db, {
      workspaceId: scope.workspaceId,
      viewerHolderTtlMs: 90_000,
      interactionHolderTtlMs: 90_000,
      idleGraceMs: 45_000,
    });
    expect(reaped.reapedInteractions).toBe(1);
    expect(
      await getBrowserSession(client.db, { ...scope, browserSessionId: prepared.session.id }),
    ).toMatchObject({
      lifecycle: "lost",
      controller: null,
      failureCode: "controller_heartbeat_expired",
    });
  }, 60_000);
});
