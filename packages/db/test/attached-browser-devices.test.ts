import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  ATTACHED_BROWSER_SESSION_CAPABILITIES,
  AttachedBrowserInventoryConflictError,
  activateBrowserSession,
  activateComputerSession,
  bootstrapWorkspace,
  createDb,
  createEnrollment,
  createSession,
  disconnectAttachedBrowserDevices,
  dispatchBrowserSessionOperation,
  dispatchComputerSessionOperation,
  getAttachedBrowserDevice,
  getBrowserSession,
  getComputerSessionControlRecord,
  listAttachedBrowserDevices,
  prepareBrowserSessionCreate,
  prepareComputerSessionCreate,
  prepareComputerSessionEnd,
  reconcileAttachedBrowserInventory,
  revokeEnrollment,
  touchBrowserSessionController,
  touchComputerSessionController,
} from "../src";

let available = true;
let shared: SharedTestDatabase | null = null;
let client: ReturnType<typeof createDb>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("attached-browser-devices");
  if (!shared) {
    available = false;
    console.warn("[attached-browser-devices] postgres unavailable, skipping");
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
    accountExternalId: `attached-browser-account-${suffix}`,
    accountName: "Attached browser test",
    workspaceExternalSource: "test",
    workspaceExternalId: `attached-browser-workspace-${suffix}`,
    workspaceName: "Attached browser test",
    subjectId: `attached-browser-subject-${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const enrollment = await createEnrollment(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    pubkey: `ed25519:${suffix}`,
    os: "macos",
    arch: "arm64",
  });
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    initialMessage: "initial",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId!,
    subjectId: grant.subjectId,
    sessionId: session.id,
    enrollmentId: enrollment.id,
  };
}

const capabilities = {
  tabInventory: true,
  debuggerAttachment: true,
  semanticObservation: true,
  screenshots: true,
  liveFrames: true,
  humanInput: true,
  diagnostics: true,
  rawCdp: false,
  linkedComputer: true,
} as const;

function device(
  id: string,
  name: string,
  inventoryRevision = 1,
  connectionGeneration = "extension-1",
) {
  return {
    id,
    name,
    profileLabel: name,
    browserName: "Google Chrome",
    browserVersion: "151.0.7922.108",
    extensionVersion: "1.0.0",
    platform: "macos" as const,
    architecture: "arm64" as const,
    connectionGeneration,
    inventoryRevision,
    tabCount: 2,
    capabilities,
  };
}

async function announceDevice(
  scope: Awaited<ReturnType<typeof fixture>>,
  deviceId: string,
  connectionGeneration: string,
  revision: number,
) {
  return await reconcileAttachedBrowserInventory(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    enrollmentId: scope.enrollmentId,
    snapshot: {
      bridgeGeneration: "bridge-1",
      revision,
      devices: [device(deviceId, "Primary Chrome", revision, connectionGeneration)],
    },
  });
}

const computerCapabilities = {
  semanticObservation: true,
  appDiscovery: true,
  appLaunch: true,
  windowCapture: true,
  screenCapture: true,
  semanticActions: true,
  pointerInput: true,
  keyboardInput: true,
  clipboard: true,
  backgroundActions: true,
  parallelApps: true,
} as const;

async function activateAttachedComputer(
  scope: Awaited<ReturnType<typeof fixture>>,
  deviceId: string,
  placementInstanceId: string,
) {
  const operationId = crypto.randomUUID();
  const prepared = await prepareComputerSessionCreate(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    operationId,
    associatedSessionId: scope.sessionId,
    actorSubjectId: scope.subjectId,
    name: "Attached Chrome computer",
    placement: { kind: "attached_device", deviceId },
  });
  const controller = {
    controllerId: "browserd:attached-test",
    controllerGeneration: crypto.randomUUID(),
    placementInstanceId,
  };
  await dispatchComputerSessionOperation(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    operationId,
    computerSessionId: prepared.session.id,
    controllerGeneration: controller.controllerGeneration,
    controller,
  });
  await activateComputerSession(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    operationId,
    computerSessionId: prepared.session.id,
    controller,
    platform: "macos",
    adapter: "opengeni.ax.v1",
    seatId: "console",
    displayId: "main",
    capabilities: computerCapabilities,
  });
  return { computerSessionId: prepared.session.id, controller };
}

async function activateAttachedBrowser(
  scope: Awaited<ReturnType<typeof fixture>>,
  deviceId: string,
  placementInstanceId: string,
  linkedComputerSessionId?: string,
) {
  const operationId = crypto.randomUUID();
  const prepared = await prepareBrowserSessionCreate(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    operationId,
    associatedSessionId: scope.sessionId,
    actorSubjectId: scope.subjectId,
    name: "Attached Chrome",
    initialUrl: null,
    placement: { kind: "attached_device", deviceId },
    driverId: "opengeni.attached-chrome.v1",
    engine: "chrome",
    headless: false,
    identityId: null,
    baseRevisionId: null,
    linkedComputerSessionId: linkedComputerSessionId ?? null,
    capabilities: ATTACHED_BROWSER_SESSION_CAPABILITIES,
  });
  const controller = {
    controllerId: "browserd:attached-test",
    controllerGeneration: crypto.randomUUID(),
    placementInstanceId,
  };
  await dispatchBrowserSessionOperation(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    operationId,
    browserSessionId: prepared.session.id,
    controllerGeneration: controller.controllerGeneration,
    controller,
  });
  await activateBrowserSession(client.db, {
    accountId: scope.accountId,
    workspaceId: scope.workspaceId,
    operationId,
    browserSessionId: prepared.session.id,
    controller,
    engineVersion: "151.0.7922.108",
  });
  return { browserSessionId: prepared.session.id, controller };
}

describe("attached browser endpoint registry", () => {
  test("reconciles full snapshots, ignores stale revisions, and preserves offline history", async () => {
    if (!available) return;
    const scope = await fixture();
    const firstId = crypto.randomUUID();
    const secondId = crypto.randomUUID();

    const created = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-1",
        revision: 1,
        devices: [device(firstId, "Primary Chrome"), device(secondId, "Work Chrome")],
      },
    });
    expect(created).toMatchObject({ accepted: true, changed: true });
    const initial = await listAttachedBrowserDevices(client.db, scope);
    expect(initial.bridges).toHaveLength(1);
    expect(initial.bridges[0]).toMatchObject({
      enrollmentId: scope.enrollmentId,
      state: "offline",
      bridgeGeneration: "bridge-1",
      inventoryRevision: 1,
      connectedProfileCount: 2,
    });
    expect(initial.devices.map((entry) => entry.id).sort()).toEqual([firstId, secondId].sort());
    expect(initial.devices.every((entry) => entry.state === "connected")).toBe(true);

    const replay = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-1",
        revision: 1,
        devices: [device(firstId, "Primary Chrome"), device(secondId, "Work Chrome")],
      },
    });
    expect(replay).toEqual({
      accepted: true,
      changed: false,
      revision: created.revision,
    });

    const stale = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: { bridgeGeneration: "bridge-1", revision: 0, devices: [] },
    });
    expect(stale).toEqual({
      accepted: false,
      changed: false,
      revision: created.revision,
    });
    expect((await listAttachedBrowserDevices(client.db, scope)).devices).toHaveLength(2);

    const changed = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-1",
        revision: 2,
        devices: [{ ...device(firstId, "Personal Chrome", 2), tabCount: 3 }],
      },
    });
    expect(changed.changed).toBe(true);
    expect(changed.revision).toBeGreaterThan(created.revision);
    const live = await listAttachedBrowserDevices(client.db, scope);
    expect(live.bridges[0]).toMatchObject({
      bridgeGeneration: "bridge-1",
      inventoryRevision: 2,
      connectedProfileCount: 1,
    });
    expect(live.devices).toHaveLength(1);
    expect(live.devices[0]).toMatchObject({
      id: firstId,
      name: "Personal Chrome",
      state: "connected",
      tabCount: 3,
    });
    const history = await listAttachedBrowserDevices(client.db, {
      ...scope,
      includeDisconnected: true,
    });
    expect(history.devices).toHaveLength(2);
    expect(history.devices.find((entry) => entry.id === secondId)).toMatchObject({
      state: "disconnected",
    });

    const disconnected = await disconnectAttachedBrowserDevices(client.db, scope);
    expect(disconnected.changed).toBe(true);
    expect(
      (
        await getAttachedBrowserDevice(client.db, {
          ...scope,
          deviceId: firstId,
        })
      ).state,
    ).toBe("disconnected");

    const reconnected = await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-2",
        revision: 0,
        devices: [
          {
            ...device(firstId, "Personal Chrome", 0),
            connectionGeneration: "extension-2",
          },
        ],
      },
    });
    expect(reconnected).toMatchObject({ accepted: true, changed: true });
    expect(
      (
        await getAttachedBrowserDevice(client.db, {
          ...scope,
          deviceId: firstId,
        })
      ).state,
    ).toBe("connected");
  });

  test("does not let another machine claim an existing endpoint id", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-a",
        revision: 1,
        devices: [device(deviceId, "First Chrome")],
      },
    });
    const other = await createEnrollment(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      os: "macos",
      arch: "arm64",
    });
    await expect(
      reconcileAttachedBrowserInventory(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        enrollmentId: other.id,
        snapshot: {
          bridgeGeneration: "bridge-b",
          revision: 1,
          devices: [device(deviceId, "Stolen Chrome")],
        },
      }),
    ).rejects.toBeInstanceOf(AttachedBrowserInventoryConflictError);
  });

  test("lets a re-enrolled machine reclaim a profile from its revoked enrollment", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await reconcileAttachedBrowserInventory(client.db, {
      ...scope,
      snapshot: {
        bridgeGeneration: "bridge-before-reinstall",
        revision: 1,
        devices: [device(deviceId, "Chrome before reinstall")],
      },
    });
    expect(
      await revokeEnrollment(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        enrollmentId: scope.enrollmentId,
      }),
    ).toEqual({ revoked: true });

    const replacement = await createEnrollment(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      pubkey: `ed25519:${crypto.randomUUID()}`,
      os: "macos",
      arch: "arm64",
    });
    const reclaimed = await reconcileAttachedBrowserInventory(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      enrollmentId: replacement.id,
      snapshot: {
        bridgeGeneration: "bridge-after-reinstall",
        revision: 0,
        devices: [
          {
            ...device(deviceId, "Chrome after reinstall", 0),
            connectionGeneration: "extension-after-reinstall",
          },
        ],
      },
    });

    expect(reclaimed).toMatchObject({ accepted: true, changed: true });
    expect(
      await getAttachedBrowserDevice(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        deviceId,
      }),
    ).toMatchObject({
      enrollmentId: replacement.id,
      name: "Chrome after reinstall",
      state: "connected",
      inventoryRevision: 0,
    });
  });

  test("terminalizes a linked BrowserSession/ComputerSession pair when generation changes", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await announceDevice(scope, deviceId, "extension-1", 1);
    const computer = await activateAttachedComputer(scope, deviceId, "extension-1");
    const browser = await activateAttachedBrowser(
      scope,
      deviceId,
      "extension-1",
      computer.computerSessionId,
    );
    const pendingOperationId = crypto.randomUUID();
    const pending = await prepareBrowserSessionCreate(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      operationId: pendingOperationId,
      associatedSessionId: scope.sessionId,
      actorSubjectId: scope.subjectId,
      name: "Pending attached Chrome",
      initialUrl: null,
      placement: { kind: "attached_device", deviceId },
      driverId: "opengeni.attached-chrome.v1",
      engine: "chrome",
      headless: false,
      identityId: null,
      baseRevisionId: null,
      linkedComputerSessionId: null,
      capabilities: ATTACHED_BROWSER_SESSION_CAPABILITIES,
    });
    await dispatchBrowserSessionOperation(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      operationId: pendingOperationId,
      browserSessionId: pending.session.id,
      controllerGeneration: crypto.randomUUID(),
    });

    const rotated = await announceDevice(scope, deviceId, "extension-2", 2);
    expect(rotated).toMatchObject({ accepted: true, changed: true });

    expect(
      await prepareBrowserSessionCreate(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        operationId: pendingOperationId,
        associatedSessionId: scope.sessionId,
        actorSubjectId: scope.subjectId,
        name: "Pending attached Chrome",
        initialUrl: null,
        placement: { kind: "attached_device", deviceId },
        driverId: "opengeni.attached-chrome.v1",
        engine: "chrome",
        headless: false,
        identityId: null,
        baseRevisionId: null,
        linkedComputerSessionId: null,
        capabilities: ATTACHED_BROWSER_SESSION_CAPABILITIES,
      }),
    ).toMatchObject({
      operation: {
        state: "outcome_unknown",
        replayed: true,
        error: { code: "outcome_unknown", retryable: false },
      },
    });

    const lostBrowser = await getBrowserSession(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      browserSessionId: browser.browserSessionId,
    });
    const lostComputer = (
      await getComputerSessionControlRecord(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        computerSessionId: computer.computerSessionId,
      })
    ).session;
    expect(lostBrowser).toMatchObject({
      lifecycle: "lost",
      failureCode: "controller_transition_expired",
      placement: { kind: "attached_device", deviceId },
      controller: {
        placementInstanceId: "extension-1",
      },
    });
    expect(lostComputer).toMatchObject({
      lifecycle: "lost",
      failureCode: "controller_transition_expired",
      placement: { kind: "attached_device", deviceId },
      controller: {
        placementInstanceId: "extension-1",
      },
    });
    expect(
      await touchBrowserSessionController(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        browserSessionId: browser.browserSessionId,
        controllerGeneration: browser.controller.controllerGeneration,
      }),
    ).toBe(false);
    expect(
      await touchComputerSessionController(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        computerSessionId: computer.computerSessionId,
        controllerGeneration: computer.controller.controllerGeneration,
      }),
    ).toBe(false);
  });

  test("terminalizes a browser-only attached session when generation changes", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await announceDevice(scope, deviceId, "extension-1", 1);
    const browser = await activateAttachedBrowser(scope, deviceId, "extension-1");

    await announceDevice(scope, deviceId, "extension-2", 2);
    expect(
      await getBrowserSession(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        browserSessionId: browser.browserSessionId,
      }),
    ).toMatchObject({
      lifecycle: "lost",
      failureCode: "controller_transition_expired",
      controller: { placementInstanceId: "extension-1" },
    });
  });

  test("leaves an in-flight ComputerSession end untouched when generation changes", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await announceDevice(scope, deviceId, "extension-1", 1);
    const computer = await activateAttachedComputer(scope, deviceId, "extension-1");
    const ending = await prepareComputerSessionEnd(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      computerSessionId: computer.computerSessionId,
      operationId: crypto.randomUUID(),
      actorSubjectId: scope.subjectId,
    });
    expect(ending.session.lifecycle).toBe("ending");

    await announceDevice(scope, deviceId, "extension-2", 2);
    expect(
      (
        await getComputerSessionControlRecord(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          computerSessionId: computer.computerSessionId,
        })
      ).session,
    ).toMatchObject({
      lifecycle: "ending",
      failureCode: null,
      controller: { placementInstanceId: "extension-1" },
    });
  });

  test("a lost linked BrowserSession does not block ComputerSession end after generation change", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await announceDevice(scope, deviceId, "extension-1", 1);
    const computer = await activateAttachedComputer(scope, deviceId, "extension-1");
    await activateAttachedBrowser(scope, deviceId, "extension-1", computer.computerSessionId);
    await announceDevice(scope, deviceId, "extension-2", 2);

    const ended = await prepareComputerSessionEnd(client.db, {
      accountId: scope.accountId,
      workspaceId: scope.workspaceId,
      computerSessionId: computer.computerSessionId,
      operationId: crypto.randomUUID(),
      actorSubjectId: scope.subjectId,
    });
    expect(ended.session).toMatchObject({
      id: computer.computerSessionId,
      lifecycle: "ending",
    });
  });

  test("same-generation inventory refresh leaves live attached sessions untouched", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await announceDevice(scope, deviceId, "extension-1", 1);
    const computer = await activateAttachedComputer(scope, deviceId, "extension-1");
    const browser = await activateAttachedBrowser(
      scope,
      deviceId,
      "extension-1",
      computer.computerSessionId,
    );

    const refreshed = await announceDevice(scope, deviceId, "extension-1", 1);
    expect(refreshed.accepted).toBe(true);
    expect(
      await getBrowserSession(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        browserSessionId: browser.browserSessionId,
      }),
    ).toMatchObject({
      lifecycle: "active",
      failureCode: null,
      controller: { placementInstanceId: "extension-1" },
    });
    expect(
      (
        await getComputerSessionControlRecord(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          computerSessionId: computer.computerSessionId,
        })
      ).session,
    ).toMatchObject({
      lifecycle: "active",
      failureCode: null,
      controller: { placementInstanceId: "extension-1" },
    });
    expect(
      await touchBrowserSessionController(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        browserSessionId: browser.browserSessionId,
        controllerGeneration: browser.controller.controllerGeneration,
      }),
    ).toBe(true);
  });

  test("rejects a controller heartbeat whose placement generation is already stale", async () => {
    if (!available) return;
    const scope = await fixture();
    const deviceId = crypto.randomUUID();
    await announceDevice(scope, deviceId, "extension-1", 1);
    const browser = await activateAttachedBrowser(scope, deviceId, "extension-1");
    const computer = await activateAttachedComputer(scope, deviceId, "extension-1");

    await shared!.admin`
      update attached_browser_devices
      set connection_generation = 'extension-stale'
      where workspace_id = ${scope.workspaceId} and id = ${deviceId}`;

    expect(
      await touchBrowserSessionController(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        browserSessionId: browser.browserSessionId,
        controllerGeneration: browser.controller.controllerGeneration,
      }),
    ).toBe(false);
    expect(
      await touchComputerSessionController(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        computerSessionId: computer.computerSessionId,
        controllerGeneration: computer.controller.controllerGeneration,
      }),
    ).toBe(false);
    expect(
      await getBrowserSession(client.db, {
        accountId: scope.accountId,
        workspaceId: scope.workspaceId,
        browserSessionId: browser.browserSessionId,
      }),
    ).toMatchObject({
      lifecycle: "active",
      controller: { placementInstanceId: "extension-1" },
    });
    expect(
      (
        await getComputerSessionControlRecord(client.db, {
          accountId: scope.accountId,
          workspaceId: scope.workspaceId,
          computerSessionId: computer.computerSessionId,
        })
      ).session,
    ).toMatchObject({
      lifecycle: "active",
      controller: { placementInstanceId: "extension-1" },
    });
  });
});
