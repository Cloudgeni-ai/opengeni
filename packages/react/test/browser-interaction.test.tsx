import { describe, expect, test } from "bun:test";
import { StreamFrame, StreamOpen, StreamOpenAck } from "@opengeni/agent-proto";
import { OpenGeniApiError } from "@opengeni/sdk";
import type {
  AttachedBrowserBridge,
  AttachedBrowserDevice,
  BrowserActionReceipt,
  BrowserDownload,
  BrowserFrame,
  BrowserFrameMetadata,
  BrowserIdentity,
  BrowserObservation,
  BrowserRevision,
  BrowserSession,
  BrowserSessionAttachment,
  BrowserSessionMutationResponse,
  BrowserTarget,
  InteractionPlacement,
  InteractionIntervention,
  SiteAuthConnection,
} from "@opengeni/sdk/interaction";
import { act } from "react";
import { browserKey, normalizeBrowserAddress } from "../src/components/browser-input";
import { BrowserViewer } from "../src/components/browser-viewer";
import { useAttachedBrowsers } from "../src/hooks/use-attached-browsers";
import type {
  BrowserFrameWebSocket,
  BrowserFrameWebSocketFactory,
} from "../src/hooks/use-browser-frame-stream";
import { useBrowserFrameStream } from "../src/hooks/use-browser-frame-stream";
import { useBrowserDownloads } from "../src/hooks/use-browser-downloads";
import { useBrowserSession } from "../src/hooks/use-browser-session";
import { useBrowserSessions } from "../src/hooks/use-browser-sessions";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";

registerDom();

const BROWSER_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const PEER_BROWSER_SESSION_ID = "55555555-5555-4555-8555-555555555555";
const PEER_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SANDBOX_GROUP_ID = "66666666-6666-4666-8666-666666666666";
const OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const BROWSER_IDENTITY_ID = "88888888-8888-4888-8888-888888888888";
const BROWSER_REVISION_ID = "99999999-9999-4999-8999-999999999999";
const COMPUTER_SESSION_ID = "abababab-abab-4bab-8bab-abababababab";
const NOW = "2026-08-09T12:00:00.000Z";

function browserDownload(overrides: Partial<BrowserDownload> = {}): BrowserDownload {
  return {
    id: "12121212-1212-4212-8212-121212121212",
    browserSessionId: BROWSER_SESSION_ID,
    controllerGeneration: "controller-1",
    targetId: "target-1",
    filename: "report.pdf",
    status: "completed",
    receivedBytes: 42_000,
    totalBytes: 42_000,
    sha256: "a".repeat(64),
    version: 1,
    startedAt: NOW,
    settledAt: NOW,
    failureCode: null,
    ...overrides,
  };
}

function attachedBrowserDevice(): AttachedBrowserDevice {
  return {
    id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    enrollmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Work Chrome",
    profileLabel: "cloudgeni.ai",
    browserName: "Chrome",
    browserVersion: "151.0.0.0",
    extensionVersion: "1.0.0",
    platform: "macos",
    architecture: "arm64",
    state: "connected",
    connectionGeneration: "chrome-generation-1",
    inventoryRevision: 4,
    tabCount: 3,
    capabilities: {
      tabInventory: true,
      debuggerAttachment: true,
      semanticObservation: true,
      screenshots: true,
      liveFrames: true,
      humanInput: true,
      diagnostics: true,
      rawCdp: false,
      linkedComputer: true,
    },
    lastSeenAt: NOW,
    disconnectedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function attachedBrowserBridge(): AttachedBrowserBridge {
  return {
    enrollmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    state: "online",
    bridgeGeneration: "bridge-generation-1",
    inventoryRevision: 4,
    connectedProfileCount: 0,
    lastSeenAt: NOW,
  };
}

function browserSession(
  id = BROWSER_SESSION_ID,
  associationSessionId = SESSION_ID,
  name = "Agent browser",
): BrowserSession {
  return {
    id,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name,
    lifecycle: "active",
    placement: { kind: "sandbox_group", sandboxGroupId: SANDBOX_GROUP_ID },
    controller: {
      controllerId: "opengeni-browserd",
      controllerGeneration: "controller-1",
      placementInstanceId: "placement-1",
    },
    driverId: "opengeni.cdp.v1",
    engine: "chromium",
    engineVersion: "151",
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
      downloads: true,
      uploads: true,
      clipboard: true,
      permissions: true,
      diagnostics: true,
      rawCdp: false,
      linkedComputer: false,
      privateCheckpoint: true,
      identityPublication: false,
      parallelTargets: true,
    },
    associations: [
      {
        sessionId: associationSessionId,
        turnId: null,
        attemptId: null,
        relationship: "using",
        actorSubjectId: "user:test",
        lastUsedAt: NOW,
      },
    ],
    createdBySubjectId: "user:test",
    createdAt: NOW,
    lastUsedAt: NOW,
    failureCode: null,
  };
}

function lostConnectedBrowser(): BrowserSession {
  return {
    ...browserSession(),
    lifecycle: "lost",
    failureCode: "source_placement_changed",
    placement: { kind: "connected_machine", sandboxId: SANDBOX_GROUP_ID },
  };
}

function browserIdentity(): BrowserIdentity {
  return {
    id: BROWSER_IDENTITY_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name: "Work",
    status: "active",
    version: 1,
    defaultRevisionId: null,
    headGeneration: 0,
    revisionCount: 0,
    createdBySubjectId: "user:test",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function browserRevision(identity: BrowserIdentity, session: BrowserSession): BrowserRevision {
  return {
    id: BROWSER_REVISION_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    identityId: identity.id,
    parentRevisionId: null,
    ordinal: 1,
    sourceBrowserSessionId: session.id,
    manifestDigest: "a".repeat(64),
    components: [
      {
        id: crypto.randomUUID(),
        kind: "chromium_profile",
        format: "opengeni.chromium-profile.v1+gzip+aes-256-gcm",
        artifactDigest: "b".repeat(64),
        sizeBytes: 1_024,
        materialization: {
          portability: "portable",
          reason: null,
          platform: "linux",
          architecture: "x64",
          engine: "chromium",
          engineVersion: "151",
          driverId: "opengeni.cdp.v1",
          driverSchemaVersion: 1,
          profileCrypto: "chromium_basic",
          providerId: null,
          placement: null,
        },
      },
    ],
    createdBySubjectId: "user:test",
    createdAt: NOW,
  };
}

function siteAuthConnection(
  identity: BrowserIdentity,
  overrides: Partial<SiteAuthConnection> = {},
): SiteAuthConnection {
  return {
    id: "12121212-abab-4bab-8bab-121212121212",
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name: "Google",
    accountLabel: "jorgen@cloudgeni.ai",
    origins: ["https://accounts.google.com"],
    loginUrl: "https://accounts.google.com/",
    verificationUrlPrefixes: ["https://myaccount.google.com/"],
    authorities: [{ id: "human", kind: "human", label: "Human", fields: [] }],
    methods: [{ id: "passkey", kind: "passkey", label: "Passkey", authorityIds: ["human"] }],
    preferredIdentityId: identity.id,
    preferredPlacement: null,
    preferredNetworkRouteId: null,
    healthPolicy: { mode: "on_use", intervalSeconds: null, automaticRepair: false },
    status: "active",
    verificationState: "needs_repair",
    lastVerifiedAt: null,
    lastVerifiedUrl: null,
    lastCheckedAt: NOW,
    nextCheckAt: null,
    maintenance: null,
    repairCode: "passkey_required",
    version: 1,
    createdBySubjectId: "user:test",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function target(
  browserSessionId = BROWSER_SESSION_ID,
  id = "target-1",
  documentGeneration = "document-1",
): BrowserTarget {
  return {
    id,
    browserSessionId,
    controllerGeneration: "controller-1",
    targetGeneration: `${id}-generation`,
    documentGeneration,
    kind: "page",
    title: "OpenGeni",
    url: "https://opengeni.ai/",
    selected: true,
    attached: true,
    createdAt: NOW,
  };
}

function observation(
  browserSessionId = BROWSER_SESSION_ID,
  browserTarget = target(browserSessionId),
): BrowserObservation {
  return {
    protocolVersion: 1,
    observationId: `observation-${browserTarget.documentGeneration}`,
    browserSessionId,
    target: browserTarget,
    frameId: `frame-${browserTarget.documentGeneration}`,
    semantic: {
      kind: "snapshot",
      roots: [
        {
          ref: "e1",
          role: "button",
          name: "Continue",
          states: [],
          actions: ["click"],
        },
      ],
      nodeCount: 1,
    },
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
    observedAt: NOW,
  };
}

function mutation(
  session = browserSession(),
  kind: BrowserSessionMutationResponse["operation"]["kind"] = "create",
  operationId = OPERATION_ID,
): BrowserSessionMutationResponse {
  return {
    session,
    operation: {
      operationId,
      resourceKind: "browser_session",
      resourceId: session.id,
      kind,
      state: "completed",
      replayed: false,
      error: null,
      createdAt: NOW,
      dispatchedAt: NOW,
      settledAt: NOW,
    },
  };
}

function receipt(current: BrowserObservation, operationId = OPERATION_ID): BrowserActionReceipt {
  return {
    protocolVersion: 1,
    operationId,
    browserSessionId: current.browserSessionId,
    controllerGeneration: current.target.controllerGeneration,
    targetId: current.target.id,
    state: "completed",
    dispatchedAt: NOW,
    settledAt: NOW,
    observation: current,
    error: null,
  };
}

function attachment(
  targetId: string,
  controllerGeneration = "controller-1",
): BrowserSessionAttachment {
  return {
    browserSessionId: BROWSER_SESSION_ID,
    controllerGeneration,
    targetId,
    stream: {
      kind: "direct_websocket",
      url: "wss://browser.example.test/v1/frames",
      protocols: ["opengeni.browser.v1", "opengeni.auth.super-secret"],
    },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

function intervention(overrides: Partial<InteractionIntervention> = {}): InteractionIntervention {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    resourceKind: "browser_session",
    resourceId: BROWSER_SESSION_ID,
    targetId: "target-1",
    controllerGeneration: "controller-1",
    targetGeneration: "target-1-generation",
    documentGeneration: "document-1",
    kind: "manual_login",
    reason: "Sign in to continue checkout.",
    status: "open",
    authRunId: null,
    originatingSessionId: SESSION_ID,
    originatingTurnId: null,
    originatingAttemptId: null,
    originatingToolOperationId: null,
    responseActorSubjectId: null,
    version: 1,
    operationId: "88888888-8888-4888-8888-888888888888",
    expiresAt: "2026-08-10T12:15:00.000Z",
    createdAt: NOW,
    updatedAt: NOW,
    settledAt: null,
    ...overrides,
  };
}

function relayAttachment(targetId: string): BrowserSessionAttachment {
  return {
    browserSessionId: BROWSER_SESSION_ID,
    controllerGeneration: "controller-1",
    targetId,
    stream: {
      kind: "relay",
      url: "wss://relay.example.test/stream?opaque-routing-key",
      token: "ogs_test-relay-grant",
      channel: {
        channelId: "browser-channel-1",
        workspaceId: WORKSPACE_ID,
        agentId: "agent-1",
        kind: 3,
        port: 20_001,
      },
    },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

class FakeBrowserSocket {
  binaryType = "blob";
  readyState = 0;
  closed = false;
  sent: ArrayBuffer[] = [];
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: any) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  emit(type: string, event: any = {}): void {
    if (type === "open") this.readyState = 1;
    if (type === "close") this.readyState = 3;
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

describe("BrowserSession React resources", () => {
  test("discovers connected Chrome profile endpoints through the public client", async () => {
    const device = attachedBrowserDevice();
    const bridge = attachedBrowserBridge();
    const calls: unknown[] = [];
    const client = fakeClient({
      listAttachedBrowsers: async (_workspaceId, options) => {
        calls.push(options);
        return { revision: 7, bridges: [bridge], devices: [device] };
      },
    });
    const hook = await renderHook(
      () =>
        useAttachedBrowsers({
          client,
          workspaceId: WORKSPACE_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    expect(hook.result.current.revision).toBe(7);
    expect(hook.result.current.bridges).toEqual([bridge]);
    expect(hook.result.current.devices).toEqual([device]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ includeDisconnected: false });
    await hook.unmount();
  });

  test("discovers current-agent and peer browsers without hiding either", async () => {
    const current = browserSession();
    const peer = browserSession(PEER_BROWSER_SESSION_ID, PEER_SESSION_ID, "Peer browser");
    const created = browserSession(
      "88888888-8888-4888-8888-888888888888",
      SESSION_ID,
      "Second browser",
    );
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 3, sessions: [peer, current] }),
      createBrowserSession: async () => mutation(created),
    });
    const hook = await renderHook(
      () =>
        useBrowserSessions({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    expect(hook.result.current.sessions.map((session) => session.id).sort()).toEqual(
      [BROWSER_SESSION_ID, PEER_BROWSER_SESSION_ID].sort(),
    );
    expect(hook.result.current.relevantSessions.map((session) => session.id)).toEqual([
      BROWSER_SESSION_ID,
    ]);

    await actRun(async () => {
      await hook.result.current.create({ sessionId: SESSION_ID, name: "Second browser" });
    });
    expect(hook.result.current.sessions.some((session) => session.id === created.id)).toBe(true);
    await hook.unmount();
  });

  test("merges suspended and resumed lifecycle state immediately", async () => {
    const active = browserSession();
    const suspended: BrowserSession = { ...active, lifecycle: "suspended", controller: null };
    const resumed: BrowserSession = {
      ...active,
      controller: { ...active.controller!, controllerGeneration: "controller-2" },
    };
    const calls: Array<{ kind: "suspend" | "resume"; operationId: string }> = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [active] }),
      suspendBrowserSession: async (_workspaceId, _browserSessionId, request) => {
        calls.push({ kind: "suspend", operationId: request.operationId });
        return mutation(suspended, "suspend", request.operationId);
      },
      resumeBrowserSession: async (_workspaceId, _browserSessionId, request) => {
        calls.push({ kind: "resume", operationId: request.operationId });
        return mutation(resumed, "resume", request.operationId);
      },
    });
    const hook = await renderHook(
      () =>
        useBrowserSessions({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    await actRun(async () => {
      await hook.result.current.suspend(BROWSER_SESSION_ID, "suspend-operation");
    });
    expect(hook.result.current.sessions[0]?.lifecycle).toBe("suspended");
    await actRun(async () => {
      await hook.result.current.resume(BROWSER_SESSION_ID, "resume-operation");
    });
    expect(hook.result.current.sessions[0]?.lifecycle).toBe("active");
    expect(hook.result.current.sessions[0]?.controller?.controllerGeneration).toBe("controller-2");
    expect(calls).toEqual([
      { kind: "suspend", operationId: "suspend-operation" },
      { kind: "resume", operationId: "resume-operation" },
    ]);
    await hook.unmount();
  });

  test("lists exact downloads and preserves one save operation across an ambiguous retry", async () => {
    const download = browserDownload();
    const operationIds: string[] = [];
    let saveAttempts = 0;
    const client = fakeClient({
      listBrowserDownloads: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        downloads: [download],
      }),
      saveBrowserDownload: async (_workspaceId, _browserSessionId, _downloadId, request) => {
        operationIds.push(request.operationId);
        saveAttempts += 1;
        if (saveAttempts === 1) throw new Error("connection closed after dispatch");
        return {
          download,
          destinationPath: request.destinationPath,
          fileId: "13131313-1313-4313-8313-131313131313",
          operationId: request.operationId,
          replayed: true,
        };
      },
    });
    const hook = await renderHook(
      (enabled: boolean) =>
        useBrowserDownloads({
          client,
          workspaceId: WORKSPACE_ID,
          browserSessionId: BROWSER_SESSION_ID,
          enabled,
          pollIntervalMs: 60_000,
        }),
      true as boolean,
    );
    await flush(20);

    expect(hook.result.current.downloads).toEqual([download]);
    let firstError: unknown;
    await actRun(async () => {
      try {
        await hook.result.current.saveToWorkspace(download.id, "reports/report.pdf");
      } catch (cause) {
        firstError = cause;
      }
    });
    expect(firstError).toBeInstanceOf(Error);
    await hook.rerender(false);
    await hook.rerender(true);
    await flush(20);
    const response = await actRun(
      async () => await hook.result.current.saveToWorkspace(download.id, "reports/report.pdf"),
    );
    expect(response.replayed).toBe(true);
    expect(operationIds).toHaveLength(2);
    expect(operationIds[0]).toBe(operationIds[1]);
    expect(hook.result.current.savingDownloadIds).toEqual([]);
    await hook.unmount();
  });

  test("uses each completed action observation immediately for the next fence", async () => {
    const calls: Array<{
      targetId: string;
      expectedTargetGeneration: string;
      expectedDocumentGeneration: string | null;
      expectedFrameId: string | null;
    }> = [];
    const firstTarget = target();
    const firstObservation = observation(BROWSER_SESSION_ID, firstTarget);
    let generation = 1;
    const client = fakeClient({
      getBrowserSession: async () => browserSession(),
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [firstTarget],
      }),
      observeBrowserTarget: async () => firstObservation,
      actInBrowser: async (_workspaceId, _browserSessionId, request) => {
        calls.push({
          targetId: request.targetId,
          expectedTargetGeneration: request.expectedTargetGeneration,
          expectedDocumentGeneration: request.expectedDocumentGeneration,
          expectedFrameId: request.expectedFrameId,
        });
        generation += 1;
        return receipt(
          observation(
            BROWSER_SESSION_ID,
            target(BROWSER_SESSION_ID, "target-1", `document-${generation}`),
          ),
          request.operationId,
        );
      },
    });
    const hook = await renderHook(
      () =>
        useBrowserSession({
          client,
          workspaceId: WORKSPACE_ID,
          browserSessionId: BROWSER_SESSION_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    await actRun(async () => {
      await hook.result.current.act({ type: "press", key: "Tab" });
      // React has not been given an intermediate act boundary. The hook must use
      // the first receipt directly, not a stale render closure.
      await hook.result.current.act({ type: "press", key: "Enter" });
      const displayedFrame: BrowserFrame = {
        frameId: "shown-frame",
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targetId: "shown-target",
        targetGeneration: "shown-target-generation",
        documentGeneration: "shown-document-generation",
        sequence: 42,
        mediaType: "image/png",
        width: 1,
        height: 1,
        deviceScaleFactor: 1,
        scrollX: 0,
        scrollY: 0,
        data: new Uint8Array([1]),
        capturedAt: NOW,
      };
      await hook.result.current.actFromFrame(
        { type: "pointer", action: "click", x: 0, y: 0 },
        displayedFrame,
      );
    });
    expect(calls).toEqual([
      {
        targetId: "target-1",
        expectedTargetGeneration: "target-1-generation",
        expectedDocumentGeneration: "document-1",
        expectedFrameId: "frame-document-1",
      },
      {
        targetId: "target-1",
        expectedTargetGeneration: "target-1-generation",
        expectedDocumentGeneration: "document-2",
        expectedFrameId: "frame-document-2",
      },
      {
        targetId: "shown-target",
        expectedTargetGeneration: "shown-target-generation",
        expectedDocumentGeneration: "shown-document-generation",
        expectedFrameId: "shown-frame",
      },
    ]);
    await hook.unmount();
  });

  test("lets the controller settle human input without a shorter UI deadline", async () => {
    const currentTarget = target();
    const currentObservation = observation(BROWSER_SESSION_ID, currentTarget);
    let settle!: (value: BrowserActionReceipt) => void;
    let requestOptions: unknown = "not-called";
    const client = fakeClient({
      getBrowserSession: async () => browserSession(),
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => currentObservation,
      actInBrowser: async (_workspaceId, _browserSessionId, request, options) => {
        requestOptions = options;
        return await new Promise<BrowserActionReceipt>((resolve) => {
          settle = resolve;
        });
      },
    });
    const hook = await renderHook(
      () =>
        useBrowserSession({
          client,
          workspaceId: WORKSPACE_ID,
          browserSessionId: BROWSER_SESSION_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    const pending = hook.result.current.act({ type: "clipboard", operation: "paste", text: "x" });
    await flush(5);
    expect(requestOptions).toBeUndefined();

    settle(receipt(currentObservation));
    await actRun(async () => await pending);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });

  test("reconciles a tab that disappears between inventory and selection", async () => {
    const stale = target(BROWSER_SESSION_ID, "stale-target");
    const live = target(BROWSER_SESSION_ID, "live-target");
    let inventoryCalls = 0;
    const selectionCalls: string[] = [];
    const client = fakeClient({
      getBrowserSession: async () => browserSession(),
      listBrowserTargets: async () => {
        inventoryCalls += 1;
        return {
          browserSessionId: BROWSER_SESSION_ID,
          controllerGeneration: "controller-1",
          targets: inventoryCalls === 1 ? [stale] : [live],
        };
      },
      observeBrowserTarget: async (_workspaceId, _browserSessionId, targetId) =>
        observation(BROWSER_SESSION_ID, targetId === live.id ? live : stale),
      selectBrowserTarget: async (_workspaceId, _browserSessionId, targetId) => {
        selectionCalls.push(targetId);
        if (targetId === stale.id) {
          throw new OpenGeniApiError(
            404,
            JSON.stringify({
              error: { code: "target_not_found", message: "browser target does not exist" },
            }),
          );
        }
        return observation(BROWSER_SESSION_ID, live);
      },
    });
    const hook = await renderHook(
      () =>
        useBrowserSession({
          client,
          workspaceId: WORKSPACE_ID,
          browserSessionId: BROWSER_SESSION_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    const selected = await actRun(async () => await hook.result.current.selectTarget(stale.id));
    expect(selected.id).toBe(live.id);
    expect(selectionCalls).toEqual([stale.id, live.id]);
    expect(inventoryCalls).toBe(2);
    expect(hook.result.current.selectedTarget?.id).toBe(live.id);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });
});

describe("BrowserSession frame stream", () => {
  test("keeps grants in protocols, accepts latest frames, and clears on target switch", async () => {
    const sockets: FakeBrowserSocket[] = [];
    const attachCalls: string[] = [];
    const client = fakeClient({
      attachBrowserSession: async (_workspaceId, _browserSessionId, request) => {
        attachCalls.push(request.targetId);
        return attachment(request.targetId);
      },
    });
    const factory: BrowserFrameWebSocketFactory = (url, protocols) => {
      const socket = new FakeBrowserSocket(url, protocols);
      sockets.push(socket);
      return socket as unknown as BrowserFrameWebSocket;
    };
    const hook = await renderHook(
      (props: { targetId: string }) =>
        useBrowserFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          browserSessionId: BROWSER_SESSION_ID,
          targetId: props.targetId,
          webSocketFactory: factory,
        }),
      { targetId: "target-1" },
    );
    await flush(10);

    expect(attachCalls).toEqual(["target-1"]);
    expect(sockets[0]?.url).not.toContain("super-secret");
    expect(sockets[0]?.protocols).toEqual(["opengeni.browser.v1", "opengeni.auth.super-secret"]);
    await dispatch(sockets[0]!, "open");
    await dispatch(sockets[0]!, "message", { data: frameMessage("target-1", 2).buffer });
    await dispatch(sockets[0]!, "message", { data: frameMessage("target-1", 1).buffer });
    await flush(5);
    expect(hook.result.current.frame?.sequence).toBe(2);

    await hook.rerender({ targetId: "target-2" });
    expect(hook.result.current.frame).toBeNull();
    expect(sockets[0]?.closed).toBe(true);
    await flush(10);
    expect(attachCalls).toEqual(["target-1", "target-2"]);
    await hook.unmount();
  });

  test("rejects a frame from a controller generation outside the attachment", async () => {
    let socket: FakeBrowserSocket | null = null;
    const client = fakeClient({
      attachBrowserSession: async (_workspaceId, _browserSessionId, request) =>
        attachment(request.targetId),
    });
    const hook = await renderHook(
      () =>
        useBrowserFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          browserSessionId: BROWSER_SESSION_ID,
          targetId: "target-1",
          webSocketFactory: (url, protocols) => {
            socket = new FakeBrowserSocket(url, protocols);
            return socket as unknown as BrowserFrameWebSocket;
          },
        }),
      undefined,
    );
    await flush(10);
    await dispatch(socket!, "open");
    await dispatch(socket!, "message", {
      data: frameMessage("target-1", 1, "controller-forged").buffer,
    });
    await flush(5);
    expect(hook.result.current.error?.message).toContain("stale controller");
    expect(socket!.closed).toBe(true);
    await hook.unmount();
  });

  test("authenticates a browser relay in-band and unwraps canonical browser frames", async () => {
    let socket: FakeBrowserSocket | null = null;
    const client = fakeClient({
      attachBrowserSession: async (_workspaceId, _browserSessionId, request) =>
        relayAttachment(request.targetId),
    });
    const hook = await renderHook(
      () =>
        useBrowserFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          browserSessionId: BROWSER_SESSION_ID,
          targetId: "target-1",
          webSocketFactory: (url, protocols) => {
            socket = new FakeBrowserSocket(url, protocols);
            return socket as unknown as BrowserFrameWebSocket;
          },
        }),
      undefined,
    );
    await flush(10);

    expect(socket!.url).toBe("wss://relay.example.test/stream?opaque-routing-key");
    expect(socket!.protocols).toEqual([]);
    await dispatch(socket!, "open");
    expect(socket!.sent).toHaveLength(1);
    const openDatagram = new Uint8Array(socket!.sent[0]!);
    expect(openDatagram[0]).toBe(1);
    expect(StreamOpen.decode(openDatagram.subarray(1))).toMatchObject({
      token: "ogs_test-relay-grant",
      role: 2,
      resumeFromSeq: "0",
      channel: {
        channelId: "browser-channel-1",
        workspaceId: WORKSPACE_ID,
        agentId: "agent-1",
        kind: 3,
        port: 20_001,
      },
    });

    // Data cannot be accepted until the relay has authenticated the viewer.
    await dispatch(socket!, "message", {
      data: relayMessage(
        3,
        StreamFrame.encode({
          channelId: "browser-channel-1",
          seq: "1",
          data: frameMessage("target-1", 1),
          producedAtMs: String(Date.now()),
        }).finish(),
      ),
    });
    expect(hook.result.current.frame).toBeNull();

    await dispatch(socket!, "message", {
      data: relayMessage(
        2,
        StreamOpenAck.encode({ accepted: true, error: undefined, resumeFromSeq: "0" }).finish(),
      ),
    });
    await dispatch(socket!, "message", {
      data: relayMessage(
        3,
        StreamFrame.encode({
          channelId: "browser-channel-1",
          seq: "2",
          data: frameMessage("target-1", 2),
          producedAtMs: String(Date.now()),
        }).finish(),
      ),
    });
    await flush(5);
    expect(hook.result.current.state).toBe("live");
    expect(hook.result.current.frame?.sequence).toBe(2);
    await hook.unmount();
  });

  test("cannot publish a delayed frame from a detached socket after target switch", async () => {
    const sockets: FakeBrowserSocket[] = [];
    let release!: (value: ArrayBuffer) => void;
    const delayed = new (class extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    })();
    const client = fakeClient({
      attachBrowserSession: async (_workspaceId, _browserSessionId, request) =>
        attachment(request.targetId),
    });
    const hook = await renderHook(
      (props: { targetId: string }) =>
        useBrowserFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          browserSessionId: BROWSER_SESSION_ID,
          targetId: props.targetId,
          webSocketFactory: (url, protocols) => {
            const socket = new FakeBrowserSocket(url, protocols);
            sockets.push(socket);
            return socket as unknown as BrowserFrameWebSocket;
          },
        }),
      { targetId: "target-1" },
    );
    await flush(10);
    await dispatch(sockets[0]!, "open");
    await dispatch(sockets[0]!, "message", { data: delayed });
    await hook.rerender({ targetId: "target-2" });
    await flush(10);
    release(frameMessage("target-1", 9).buffer as ArrayBuffer);
    await flush(20);
    expect(hook.result.current.frame).toBeNull();
    expect(sockets[0]?.closed).toBe(true);
    await hook.unmount();
  });
});

describe("BrowserViewer", () => {
  test("retires a stale Connected Machine browser and stops polling the permanent conflict", async () => {
    const stale = {
      ...browserSession(),
      placement: {
        kind: "connected_machine" as const,
        sandboxId: SANDBOX_GROUP_ID,
      },
    };
    const lost = lostConnectedBrowser();
    let catalogCalls = 0;
    let targetCalls = 0;
    const client = fakeClient({
      listBrowserSessions: async () => ({
        revision: ++catalogCalls,
        sessions: catalogCalls === 1 ? [stale] : [lost],
      }),
      getBrowserSession: async () => stale,
      listBrowserTargets: async () => {
        targetCalls += 1;
        throw new OpenGeniApiError(
          409,
          JSON.stringify({
            error: {
              status: 409,
              code: "conflict",
              message: "This browser belonged to a previous task placement and was retired.",
              retryable: false,
              outcomeUnknown: false,
              details: {
                interactionResource: "browser_session",
                interactionFailureCode: "source_placement_changed",
                interactionLifecycle: "lost",
              },
            },
          }),
        );
      },
    });

    const rendered = await renderComponent(
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(120);
    expect(catalogCalls).toBeGreaterThanOrEqual(2);
    expect(targetCalls).toBe(1);
    expect(rendered.container.textContent).toContain("No browser open");
    await flush(900);
    expect(targetCalls).toBe(1);
    await rendered.unmount();
  });

  test("restores the task's last selected BrowserSession", async () => {
    const current = browserSession();
    const peer = browserSession(PEER_BROWSER_SESSION_ID, PEER_SESSION_ID, "Peer browser");
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current, peer] }),
      getBrowserSession: async (_workspaceId, browserSessionId) =>
        browserSessionId === peer.id ? peer : current,
      listBrowserTargets: async (_workspaceId, browserSessionId) => ({
        browserSessionId,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const changes: Array<string | null> = [];
    const viewer = (enabled: boolean) => (
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        enabled={enabled}
        initialBrowserSessionId={peer.id}
        onBrowserSessionIdChange={(browserSessionId) => changes.push(browserSessionId)}
      />
    );
    const rendered = await renderComponent(viewer(true));
    await flush(40);

    expect(rendered.container.querySelector("summary")?.textContent).toContain("Peer browser");
    await rendered.rerender(viewer(false));
    await flush(10);
    await rendered.rerender(viewer(true));
    await flush(40);
    expect(rendered.container.querySelector("summary")?.textContent).toContain("Peer browser");
    expect(changes).toEqual([]);
    await rendered.unmount();
  });

  test("ignores standalone modifier keydowns before a browser shortcut", () => {
    const event = (key: string, overrides: Partial<Parameters<typeof browserKey>[0]> = {}) => ({
      altKey: false,
      ctrlKey: false,
      key,
      metaKey: false,
      shiftKey: false,
      ...overrides,
    });

    expect(browserKey(event("Meta", { metaKey: true }))).toBeNull();
    expect(browserKey(event("Control", { ctrlKey: true }))).toBeNull();
    expect(browserKey(event("Alt", { altKey: true }))).toBeNull();
    expect(browserKey(event("a", { metaKey: true }), "mac")).toBe("Mod+a");
    expect(browserKey(event("a", { ctrlKey: true }), "mac")).toBe("Control+a");
    expect(browserKey(event("a", { ctrlKey: true }), "other")).toBe("Mod+a");
    expect(browserKey(event("a", { metaKey: true }), "other")).toBe("Meta+a");
  });

  test("treats the browser address field as an omnibox", () => {
    expect(normalizeBrowserAddress("example.com")).toBe("https://example.com/");
    expect(normalizeBrowserAddress("localhost:3000/test")).toBe("http://localhost:3000/test");
    expect(normalizeBrowserAddress("opengeni browser platform")).toBe(
      "https://www.google.com/search?q=opengeni%20browser%20platform",
    );
  });

  test("renders a typed connected-machine startup failure instead of a generic spinner", async () => {
    const current = browserSession();
    const currentTarget = target();
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: current.id,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => observation(current.id, currentTarget),
      attachBrowserSession: async () => {
        throw new OpenGeniApiError(
          502,
          JSON.stringify({
            error: {
              status: 502,
              code: "upstream_unavailable",
              message: "The connected machine could not open the browser live view stream.",
              retryable: false,
              requestId: "outer-browser-request",
              details: {
                interactionLayer: "connected_machine",
                interactionSurface: "browser",
                controlFailureCode: "stream",
                controlRequestId: "inner-browser-request",
              },
            },
          }),
          { mutation: true },
        );
      },
    });
    const rendered = await renderComponent(
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(40);

    expect(rendered.container.textContent).toContain("Live view disconnected");
    expect(rendered.container.textContent).toContain(
      "The connected machine could not open the browser live view stream.",
    );
    expect(rendered.container.textContent).toContain("Try again");
    await rendered.unmount();
  });

  test("opens actionable runtime and page diagnostics without leaving the browser", async () => {
    const current = browserSession();
    const currentTarget = target();
    const download = browserDownload();
    const saves: unknown[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => ({
        ...observation(BROWSER_SESSION_ID, currentTarget),
        diagnostics: {
          consoleErrorCount: 1,
          failedRequestCount: 1,
          downloadCount: 1,
          pageErrorCount: 0,
        },
      }),
      attachBrowserSession: async () => attachment(currentTarget.id),
      listBrowserDiagnostics: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targetId: currentTarget.id,
        targetGeneration: currentTarget.targetGeneration,
        entries: [
          {
            sequence: 1,
            kind: "failed_request",
            level: "error",
            message: "Request failed with status 503",
            url: "https://opengeni.ai/api/health",
            method: "GET",
            status: 503,
            filename: null,
            occurredAt: NOW,
          },
        ],
        cursor: 1,
        truncated: false,
      }),
      listBrowserDownloads: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        downloads: [download],
      }),
      saveBrowserDownload: async (_workspaceId, browserSessionId, downloadId, request) => {
        saves.push({ browserSessionId, downloadId, request });
        return {
          download,
          destinationPath: request.destinationPath,
          fileId: "13131313-1313-4313-8313-131313131313",
          operationId: request.operationId,
          replayed: false,
        };
      },
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeBrowserSocket(url, protocols) as unknown as BrowserFrameWebSocket
        }
      />,
    );
    await flush(40);

    const debug = rendered.container.querySelector<HTMLButtonElement>(
      "button[aria-controls='browser-diagnostics-drawer']",
    );
    expect(debug).not.toBeNull();
    await actRun(() => debug!.click());
    await flush(10);

    const drawer = rendered.container.querySelector("[aria-label='Browser diagnostics']");
    expect(drawer?.textContent).toContain("chromium 151 · headless");
    expect(drawer?.textContent).toContain("opengeni.cdp.v1");
    expect(drawer?.textContent).toContain("Semantic page structure available");
    expect(drawer?.textContent).toContain("Request failed with status 503");
    expect(drawer?.textContent).toContain("GET · 503 · https://opengeni.ai/api/health");
    expect(drawer?.textContent).toContain("report.pdf");

    const destination = rendered.container.querySelector<HTMLInputElement>(
      "input[aria-label='Workspace path for report.pdf']",
    );
    expect(destination).not.toBeNull();
    await actRun(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(destination, "reports/final.pdf");
      destination!.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    const save = destination
      ?.closest("li")
      ?.querySelector<HTMLButtonElement>("button:not([disabled])");
    expect(save?.textContent?.trim()).toBe("Save");
    await actRun(() => save!.click());
    await flush(10);
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      browserSessionId: BROWSER_SESSION_ID,
      downloadId: download.id,
      request: { destinationPath: "reports/final.pdf", overwrite: false },
    });
    expect(drawer?.textContent).toContain("Saved");

    const close = rendered.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Close browser diagnostics']",
    );
    expect(close).not.toBeNull();
    await actRun(() => close!.click());
    expect(rendered.container.querySelector("[aria-label='Browser diagnostics']")).toBeNull();
    await rendered.unmount();
  });

  test("does not advertise or query downloads when the selected controller lacks them", async () => {
    const current = browserSession();
    current.capabilities = { ...current.capabilities, downloads: false };
    const currentTarget = target();
    let downloadQueries = 0;
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => observation(BROWSER_SESSION_ID, currentTarget),
      attachBrowserSession: async () => attachment(currentTarget.id),
      listBrowserDiagnostics: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targetId: currentTarget.id,
        targetGeneration: currentTarget.targetGeneration,
        entries: [],
        cursor: 0,
        truncated: false,
      }),
      listBrowserDownloads: async () => {
        downloadQueries += 1;
        throw new Error("unsupported");
      },
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeBrowserSocket(url, protocols) as unknown as BrowserFrameWebSocket
        }
      />,
    );
    await flush(30);
    const debug = rendered.container.querySelector<HTMLButtonElement>(
      "button[aria-controls='browser-diagnostics-drawer']",
    );
    await actRun(() => debug!.click());
    await flush(10);

    expect(rendered.container.querySelector("#browser-downloads-title")).toBeNull();
    expect(downloadQueries).toBe(0);
    await rendered.unmount();
  });

  test("surfaces and resolves an exact durable browser intervention", async () => {
    const current = browserSession();
    const currentTarget = target();
    let pending = intervention();
    const resolutions: unknown[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => observation(BROWSER_SESSION_ID, currentTarget),
      attachBrowserSession: async () => attachment(currentTarget.id),
      listInteractionInterventions: async () => ({
        interventions: pending.status === "open" ? [pending] : [],
      }),
      resolveInteractionIntervention: async (_workspaceId, interventionId, request) => {
        resolutions.push({ interventionId, ...request });
        pending = {
          ...pending,
          status: request.outcome,
          version: pending.version + 1,
          settledAt: NOW,
        };
        return {
          intervention: pending,
          operationId: request.operationId,
          replayed: false,
        };
      },
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeBrowserSocket(url, protocols) as unknown as BrowserFrameWebSocket
        }
      />,
    );
    await flush(40);

    expect(rendered.container.textContent).toContain("Sign in needed");
    expect(rendered.container.textContent).toContain("Sign in to continue checkout.");
    const done = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Done",
    );
    expect(done).toBeDefined();
    await actRun(() => done!.click());
    await flush(10);

    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      interventionId: pending.id,
      expectedVersion: 1,
      outcome: "completed",
    });
    expect(rendered.container.textContent).not.toContain("Sign in needed");
    await rendered.unmount();
  });

  test("wakes a selected suspended browser before touching its controller", async () => {
    const suspended: BrowserSession = {
      ...browserSession(),
      lifecycle: "suspended",
      controller: null,
    };
    const resumed = {
      ...browserSession(),
      controller: {
        ...browserSession().controller!,
        controllerGeneration: "controller-2",
      },
    };
    const sequence: string[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [suspended] }),
      resumeBrowserSession: async (_workspaceId, _browserSessionId, request) => {
        sequence.push("resume");
        return mutation(resumed, "resume", request.operationId);
      },
      getBrowserSession: async () => {
        sequence.push("get");
        return resumed;
      },
      listBrowserTargets: async () => {
        sequence.push("targets");
        return {
          browserSessionId: BROWSER_SESSION_ID,
          controllerGeneration: "controller-2",
          targets: [],
        };
      },
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeBrowserSocket(url, protocols) as unknown as BrowserFrameWebSocket
        }
      />,
    );
    await flush(40);

    expect(sequence[0]).toBe("resume");
    expect(sequence).toContain("targets");
    expect(sequence.indexOf("targets")).toBeGreaterThan(sequence.indexOf("resume"));
    await rendered.unmount();
  });

  test("retries an uncertain browser resume with the same operation id", async () => {
    const suspended: BrowserSession = {
      ...browserSession(),
      lifecycle: "suspended",
      controller: null,
    };
    const resumed = browserSession();
    const operationIds: string[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [suspended] }),
      resumeBrowserSession: async (_workspaceId, _browserSessionId, request) => {
        operationIds.push(request.operationId);
        if (operationIds.length === 1) throw new Error("connection lost after dispatch");
        return mutation(resumed, "resume", request.operationId);
      },
      getBrowserSession: async () => resumed,
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeBrowserSocket(url, protocols) as unknown as BrowserFrameWebSocket
        }
      />,
    );
    await flush(30);

    expect(rendered.container.textContent).toContain("Browser could not reopen");
    const retry = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Open browser",
    );
    expect(retry).toBeDefined();
    await actRun(() => retry!.click());
    await flush(30);

    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    await rendered.unmount();
  });

  test("shows peer browsers and routes semantic human input through the canonical action API", async () => {
    const current = browserSession();
    const peer = browserSession(PEER_BROWSER_SESSION_ID, PEER_SESSION_ID, "Peer browser");
    const currentTarget = target();
    const currentObservation = observation(BROWSER_SESSION_ID, currentTarget);
    const actions: unknown[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current, peer] }),
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => currentObservation,
      attachBrowserSession: async () => attachment(currentTarget.id),
      actInBrowser: async (_workspaceId, _browserSessionId, request) => {
        actions.push(request);
        const nextObservation =
          request.action.type === "navigate"
            ? observation(BROWSER_SESSION_ID, {
                ...currentTarget,
                url: request.action.url,
                documentGeneration: "document-2",
              })
            : currentObservation;
        return receipt(nextObservation, request.operationId);
      },
    });
    const sockets: FakeBrowserSocket[] = [];
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) => {
          const socket = new FakeBrowserSocket(url, protocols);
          sockets.push(socket);
          return socket as unknown as BrowserFrameWebSocket;
        }}
      />,
    );
    await flush(40);

    expect(rendered.container.textContent).toContain("Agent browser");
    expect(rendered.container.textContent).toContain("Peer browser");
    const continueButton = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Continue",
    );
    expect(continueButton).toBeDefined();
    await actRun(() => continueButton!.click());
    await flush(5);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      targetId: "target-1",
      expectedTargetGeneration: "target-1-generation",
      expectedDocumentGeneration: "document-1",
      expectedFrameId: "frame-document-1",
      action: { type: "click", locator: { kind: "ref", ref: "e1" } },
    });
    expect(sockets).toHaveLength(1);

    await dispatch(sockets[0]!, "open");
    await dispatch(sockets[0]!, "message", {
      data: frameMessage("target-1", 1, "controller-1", {
        frameId: "frame-document-1",
        documentGeneration: "document-1",
      }).buffer,
    });
    await flush(5);
    const canvas = rendered.container.querySelector(
      "canvas[aria-label='Interactive browser page']",
    );
    expect(canvas?.className).not.toContain("invisible");

    const address = rendered.container.querySelector<HTMLInputElement>(
      "input[aria-label='Address']",
    );
    const form = address?.closest("form");
    expect(address).not.toBeNull();
    expect(form).not.toBeNull();
    await actRun(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(address, "example.com");
      address!.dispatchEvent(new InputEvent("input", { bubbles: true }));
      address!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await actRun(() => form!.requestSubmit());
    await flush(5);
    expect(actions).toHaveLength(2);
    expect(canvas?.className).toContain("invisible");
    expect(rendered.container.textContent).toContain("Connecting");
    await rendered.unmount();
  });

  test("keeps unrelated workspace browsers discoverable without claiming one for this agent", async () => {
    const peer = browserSession(PEER_BROWSER_SESSION_ID, PEER_SESSION_ID, "Connected Mac browser");
    peer.placement = {
      kind: "connected_machine",
      sandboxId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    };
    let controllerReads = 0;
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [peer] }),
      getBrowserSession: async () => {
        controllerReads += 1;
        return peer;
      },
    });
    const rendered = await renderComponent(
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(30);

    expect(controllerReads).toBe(0);
    expect(rendered.container.textContent).toContain("No browser for this agent");
    expect(rendered.container.textContent).toContain("Workspace browsers");
    expect(rendered.container.textContent).toContain("Connected Mac browser");
    await rendered.unmount();
  });

  test("routes clipboard events and only committed IME text through causal browser actions", async () => {
    const current = browserSession();
    const currentTarget = target();
    const currentObservation = observation(BROWSER_SESSION_ID, currentTarget);
    const actions: BrowserActionReceipt["operationId"][] = [];
    const actionValues: unknown[] = [];
    const copied: string[] = [];
    const priorClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => copied.push(text) },
    });
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => currentObservation,
      attachBrowserSession: async () => attachment(currentTarget.id),
      actInBrowser: async (_workspaceId, _browserSessionId, request) => {
        actions.push(request.operationId);
        actionValues.push(request.action);
        return receipt(currentObservation, request.operationId);
      },
      readBrowserClipboard: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        revision: 1,
        text: "remote selection",
        source: "copy",
        sourceTargetId: currentTarget.id,
        updatedAt: NOW,
      }),
    });
    const socket = new FakeBrowserSocket("wss://browser.example.test/v1/frames", [
      "opengeni.browser.v1",
      "opengeni.auth.test",
    ]);
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={() => socket as unknown as BrowserFrameWebSocket}
      />,
    );
    try {
      await flush(30);
      await dispatch(socket, "open");
      await dispatch(socket, "message", {
        data: frameMessage("target-1", 1).buffer,
      });
      await flush(5);
      const keyboard = rendered.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Browser keyboard input']",
      );
      expect(keyboard).not.toBeNull();
      const canvas = rendered.container.querySelector<HTMLCanvasElement>(
        "canvas[aria-label='Interactive browser page']",
      );
      expect(canvas).not.toBeNull();
      const focusPointer = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 10,
        clientY: 10,
      });
      await actRun(() => {
        canvas!.dispatchEvent(focusPointer);
      });
      expect(focusPointer.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(keyboard);
      const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { getData: (kind: string) => (kind === "text/plain" ? "local paste" : "") },
      });
      await actRun(() => {
        keyboard!.dispatchEvent(paste);
        keyboard!.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true }));
      });
      await flush(20);

      const keyboardAfterClipboard = rendered.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Browser keyboard input']",
      );
      expect(keyboardAfterClipboard).not.toBeNull();
      await actRun(() => {
        keyboardAfterClipboard!.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true, data: "" }),
        );
        keyboardAfterClipboard!.value = "に";
        keyboardAfterClipboard!.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: "に", isComposing: true }),
        );
        keyboardAfterClipboard!.value = "日本";
        keyboardAfterClipboard!.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "日本" }),
        );
        keyboardAfterClipboard!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await flush(20);

      expect(actions).toHaveLength(3);
      expect(actionValues).toEqual([
        { type: "clipboard", operation: "paste", text: "local paste" },
        { type: "clipboard", operation: "copy" },
        { type: "type", text: "日本" },
      ]);
      expect(copied).toEqual(["remote selection"]);
    } finally {
      if (priorClipboard) Object.defineProperty(navigator, "clipboard", priorClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
      await rendered.unmount();
    }
  });

  test("turns a temporary browser into an explicit reusable profile version", async () => {
    let current: BrowserSession = {
      ...browserSession(),
      capabilities: { ...browserSession().capabilities, identityPublication: true },
    };
    let savedIdentity: BrowserIdentity | null = null;
    let savedRevision: BrowserRevision | null = null;
    const publishRequests: unknown[] = [];
    const currentTarget = target();
    const currentObservation = observation(BROWSER_SESSION_ID, currentTarget);
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      listBrowserIdentities: async () => ({
        revision: 1,
        identities: savedIdentity ? [savedIdentity] : [],
      }),
      createBrowserIdentity: async (_workspaceId, request) => {
        savedIdentity = { ...browserIdentity(), name: request.name };
        return { identity: savedIdentity, operationId: request.operationId, replayed: false };
      },
      publishBrowserRevision: async (_workspaceId, browserSessionId, request) => {
        publishRequests.push({ browserSessionId, ...request });
        const identity = savedIdentity!;
        const revision = browserRevision(identity, current);
        savedRevision = revision;
        savedIdentity = {
          ...identity,
          defaultRevisionId: revision.id,
          headGeneration: 1,
          revisionCount: 1,
          version: identity.version + 1,
        };
        current = {
          ...current,
          identityId: identity.id,
          baseRevisionId: revision.id,
        };
        return {
          identity: savedIdentity,
          revision,
          outcome: "saved_as_default",
          replayed: false,
        };
      },
      listBrowserRevisions: async () => ({
        identity: savedIdentity!,
        revisions: savedRevision ? [savedRevision] : [],
      }),
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => currentObservation,
      attachBrowserSession: async () => attachment(currentTarget.id),
    });
    const notifications: string[] = [];
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        onNotify={(notification) => notifications.push(notification.message)}
        webSocketFactory={(url, protocols) =>
          new FakeBrowserSocket(url, protocols) as unknown as BrowserFrameWebSocket
        }
      />,
    );
    await flush(30);

    const profileSummary = [...rendered.container.querySelectorAll("summary")].find((summary) =>
      summary.textContent?.includes("Temporary"),
    );
    expect(profileSummary).toBeDefined();
    await actRun(() => profileSummary!.click());
    const name = rendered.container.querySelector<HTMLInputElement>("input[placeholder='Work']");
    expect(name).not.toBeNull();
    await actRun(() => {
      name!.value = "Work";
      name!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(save).toBeDefined();
    await actRun(() => save!.click());
    await flush(30);

    expect(publishRequests).toHaveLength(1);
    expect(publishRequests[0]).toMatchObject({
      browserSessionId: BROWSER_SESSION_ID,
      identityId: BROWSER_IDENTITY_ID,
      expectedHeadGeneration: 0,
      advanceDefault: true,
    });
    expect(rendered.container.textContent).toMatch(/Work\s*·\s*v1/u);
    expect(notifications).toContain("Work version 1 saved for future browsers.");
    await rendered.unmount();
  });

  test("retries first-save publication into the existing empty identity", async () => {
    const current: BrowserSession = {
      ...browserSession(),
      capabilities: { ...browserSession().capabilities, identityPublication: true },
    };
    const emptyIdentity: BrowserIdentity = { ...browserIdentity(), name: "Google" };
    let createCalls = 0;
    const publishRequests: unknown[] = [];
    const currentTarget = target();
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [emptyIdentity] }),
      createBrowserIdentity: async () => {
        createCalls += 1;
        throw new Error("the empty identity should be reused");
      },
      publishBrowserRevision: async (_workspaceId, browserSessionId, request) => {
        publishRequests.push({ browserSessionId, ...request });
        const revision = browserRevision(emptyIdentity, current);
        return {
          identity: {
            ...emptyIdentity,
            defaultRevisionId: revision.id,
            headGeneration: 1,
            revisionCount: 1,
            version: emptyIdentity.version + 1,
          },
          revision,
          outcome: "saved_as_default",
          replayed: false,
        };
      },
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: BROWSER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => observation(BROWSER_SESSION_ID, currentTarget),
      attachBrowserSession: async () => attachment(currentTarget.id),
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeBrowserSocket(url, protocols) as unknown as BrowserFrameWebSocket
        }
      />,
    );
    await flush(30);

    const profileSummary = [...rendered.container.querySelectorAll("summary")].find((summary) =>
      summary.textContent?.includes("Temporary"),
    );
    await actRun(() => profileSummary!.click());
    const name = rendered.container.querySelector<HTMLInputElement>("input[placeholder='Work']")!;
    await actRun(() => {
      name.value = "google";
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save",
    );
    await actRun(() => save!.click());
    await flush(30);

    expect(createCalls).toBe(0);
    expect(publishRequests).toHaveLength(1);
    expect(publishRequests[0]).toMatchObject({
      identityId: emptyIdentity.id,
      expectedHeadGeneration: 0,
      advanceDefault: true,
    });
    await rendered.unmount();
  });

  test("starts a browser from a selected reusable profile", async () => {
    const identity: BrowserIdentity = {
      ...browserIdentity(),
      defaultRevisionId: BROWSER_REVISION_ID,
      headGeneration: 1,
      revisionCount: 1,
    };
    const created: BrowserSession = {
      ...browserSession(),
      name: "Work browser",
      identityId: identity.id,
      baseRevisionId: identity.defaultRevisionId,
      capabilities: { ...browserSession().capabilities, identityPublication: true },
    };
    const createRequests: unknown[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [identity] }),
      listBrowserRevisions: async () => ({
        identity,
        revisions: [browserRevision(identity, created)],
      }),
      createBrowserSession: async (_workspaceId, request) => {
        createRequests.push(request);
        return mutation(created);
      },
      getBrowserSession: async () => created,
      listBrowserTargets: async () => ({
        browserSessionId: created.id,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const rendered = await renderComponent(
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(30);

    const launchSummary = rendered.container.querySelector<HTMLElement>(
      "summary[aria-label='New browser']",
    );
    expect(launchSummary).not.toBeNull();
    await actRun(() => launchSummary!.click());
    const launchMenu = launchSummary!.closest("details");
    const work = [...(launchMenu?.querySelectorAll("button") ?? [])].find(
      (button) =>
        button.textContent?.includes("Work") && button.textContent?.includes("1 saved version"),
    );
    expect(work).toBeDefined();
    await actRun(() => work!.click());
    await flush(30);

    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "Work browser",
      identityId: BROWSER_IDENTITY_ID,
    });
    expect(createRequests[0]).not.toHaveProperty("baseRevisionId");
    expect(rendered.container.textContent).toMatch(/Work\s*·\s*v1/u);
    await rendered.unmount();
  });

  test("opens one exact saved profile version without changing the future default", async () => {
    const secondRevisionId = "aaaaaaaa-9999-4999-8999-999999999999";
    const createdSessionId = "aaaaaaaa-7777-4777-8777-777777777777";
    const identity: BrowserIdentity = {
      ...browserIdentity(),
      version: 3,
      defaultRevisionId: BROWSER_REVISION_ID,
      headGeneration: 2,
      revisionCount: 2,
    };
    const current: BrowserSession = {
      ...browserSession(),
      identityId: identity.id,
      baseRevisionId: secondRevisionId,
      capabilities: {
        ...browserSession().capabilities,
        identityPublication: true,
        liveFrames: false,
      },
    };
    const first = { ...browserRevision(identity, current), ordinal: 1 };
    const second = { ...first, id: secondRevisionId, ordinal: 2 };
    const createRequests: unknown[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [identity] }),
      listBrowserRevisions: async () => ({ identity, revisions: [first, second] }),
      createBrowserSession: async (_workspaceId, request) => {
        createRequests.push(request);
        return mutation({
          ...current,
          id: createdSessionId,
          baseRevisionId: request.baseRevisionId ?? identity.defaultRevisionId,
        });
      },
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: current.id,
        controllerGeneration: "controller-1",
        targets: [target()],
      }),
      observeBrowserTarget: async () => observation(current.id, target()),
    });
    const rendered = await renderComponent(
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(30);

    const profileSummary = [...rendered.container.querySelectorAll("summary")].find((summary) =>
      /Work\s*·\s*v2/u.test(summary.textContent ?? ""),
    );
    expect(profileSummary).toBeDefined();
    await actRun(() => profileSummary!.click());
    const openFirst = rendered.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Open Work version 1']",
    );
    expect(openFirst).not.toBeNull();
    await actRun(() => openFirst!.click());
    await flush(30);

    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "Work browser",
      identityId: identity.id,
      baseRevisionId: first.id,
      headless: false,
      initialUrl: "https://www.google.com/",
    });
    expect(identity.defaultRevisionId).toBe(BROWSER_REVISION_ID);
    await rendered.unmount();
  });

  test("selects a future default version and archives a profile without changing the live browser", async () => {
    const secondRevisionId = "aaaaaaaa-9999-4999-8999-999999999999";
    let identity: BrowserIdentity = {
      ...browserIdentity(),
      version: 3,
      defaultRevisionId: BROWSER_REVISION_ID,
      headGeneration: 1,
      revisionCount: 2,
    };
    const current: BrowserSession = {
      ...browserSession(),
      identityId: identity.id,
      baseRevisionId: secondRevisionId,
      capabilities: {
        ...browserSession().capabilities,
        identityPublication: true,
        liveFrames: false,
      },
    };
    const first = { ...browserRevision(identity, current), ordinal: 1 };
    const second = { ...first, id: secondRevisionId, ordinal: 2 };
    const updates: unknown[] = [];
    const currentTarget = target();
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [current] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [identity] }),
      listBrowserRevisions: async () => ({ identity, revisions: [first, second] }),
      listSiteAuthConnections: async () => ({
        revision: 1,
        connections: [siteAuthConnection(identity)],
      }),
      updateBrowserIdentity: async (_workspaceId, identityId, request) => {
        updates.push({ identityId, ...request });
        const defaultChanged =
          request.defaultRevisionId !== undefined &&
          request.defaultRevisionId !== identity.defaultRevisionId;
        identity = {
          ...identity,
          ...(request.status !== undefined ? { status: request.status } : {}),
          ...(request.defaultRevisionId !== undefined
            ? { defaultRevisionId: request.defaultRevisionId }
            : {}),
          headGeneration: identity.headGeneration + (defaultChanged ? 1 : 0),
          version: identity.version + 1,
        };
        return { identity, operationId: request.operationId, replayed: false };
      },
      getBrowserSession: async () => current,
      listBrowserTargets: async () => ({
        browserSessionId: current.id,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeBrowserTarget: async () => observation(current.id, currentTarget),
    });
    const notifications: string[] = [];
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        onNotify={(notification) => notifications.push(notification.message)}
      />,
    );
    await flush(30);

    const profileSummary = [...rendered.container.querySelectorAll("summary")].find((summary) =>
      /Work\s*·\s*v2/u.test(summary.textContent ?? ""),
    );
    expect(profileSummary).toBeDefined();
    await actRun(() => profileSummary!.click());
    expect(rendered.container.textContent).toContain("Portable browser data");
    expect(rendered.container.textContent).toContain("Google");
    expect(rendered.container.textContent).toContain("Sign-in needs attention");
    expect(rendered.container.textContent).toContain(
      "Saved browser data can be copied; a website may still expire or re-verify its own session.",
    );
    const chooseDefault = rendered.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Use Work version 2 by default']",
    );
    expect(chooseDefault).not.toBeNull();
    await actRun(() => chooseDefault!.click());
    await flush(20);

    expect(updates[0]).toMatchObject({
      identityId: identity.id,
      expectedVersion: 3,
      defaultRevisionId: secondRevisionId,
    });
    expect(current.baseRevisionId).toBe(secondRevisionId);
    expect(notifications).toContain("Work version 2 will open by default in future browsers.");

    const archive = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Hide from new browsers",
    );
    expect(archive).toBeDefined();
    await actRun(() => archive!.click());
    await flush(20);
    expect(updates[1]).toMatchObject({
      identityId: identity.id,
      expectedVersion: 4,
      status: "archived",
    });
    expect(rendered.container.textContent).toContain(
      "Hidden from new browsers. This already-open browser is unchanged.",
    );
    await rendered.unmount();
  });

  test("creates a managed browser inside an exact ComputerSession and opens that resource", async () => {
    const created: BrowserSession = {
      ...browserSession(),
      headless: false,
      linkedComputerSessionId: COMPUTER_SESSION_ID,
      capabilities: { ...browserSession().capabilities, linkedComputer: true },
    };
    const sequence: string[] = [];
    const createRequests: unknown[] = [];
    const opened: string[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [] }),
      createBrowserSession: async (_workspaceId, request) => {
        sequence.push("browser");
        createRequests.push(request);
        return mutation(created);
      },
      getBrowserSession: async () => created,
      listBrowserTargets: async () => ({
        browserSessionId: created.id,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        createLinkedComputer={async (name) => {
          sequence.push(`computer:${name}`);
          return {
            id: COMPUTER_SESSION_ID,
            placement: created.placement,
          };
        }}
        onOpenComputer={(computerSessionId) => opened.push(computerSessionId)}
      />,
    );
    await flush(30);

    const launchSummary = rendered.container.querySelector<HTMLElement>(
      "summary[aria-label='New browser']",
    );
    expect(launchSummary).not.toBeNull();
    await actRun(() => launchSummary!.click());
    const clean = [...(launchSummary!.closest("details")?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Fresh browser"),
    );
    expect(clean).toBeDefined();
    await actRun(() => clean!.click());
    await flush(30);

    expect(sequence).toEqual(["computer:Browser desktop", "browser"]);
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "Browser",
      headless: false,
      initialUrl: "https://www.google.com/",
      linkedComputerSessionId: COMPUTER_SESSION_ID,
      placement: created.placement,
    });
    const openComputer = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Desktop",
    );
    expect(openComputer).toBeDefined();
    await actRun(() => openComputer!.click());
    expect(opened).toEqual([COMPUTER_SESSION_ID]);
    await rendered.unmount();
  });

  test("keeps the fast semantic browser agent-only in human creation UI", async () => {
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [] }),
    });
    const rendered = await renderComponent(
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(30);

    const launchSummary = rendered.container.querySelector<HTMLElement>(
      "summary[aria-label='New browser']",
    );
    expect(launchSummary).not.toBeNull();
    await actRun(() => launchSummary!.click());
    expect(launchSummary!.closest("details")?.textContent).not.toContain("Fast semantic browser");
    await rendered.unmount();
  });

  test("human creation is headed even when the embed has no linked computer", async () => {
    const created: BrowserSession = { ...browserSession(), headless: false };
    const createRequests: unknown[] = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [] }),
      createBrowserSession: async (_workspaceId, request) => {
        createRequests.push(request);
        return mutation(created);
      },
      getBrowserSession: async () => created,
      listBrowserTargets: async () => ({
        browserSessionId: created.id,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const rendered = await renderComponent(
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(30);

    const launchSummary = rendered.container.querySelector<HTMLElement>(
      "summary[aria-label='New browser']",
    );
    expect(launchSummary).not.toBeNull();
    await actRun(() => launchSummary!.click());
    const clean = [...(launchSummary!.closest("details")?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Fresh browser"),
    );
    expect(clean).toBeDefined();
    await actRun(() => clean!.click());
    await flush(30);

    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "Browser",
      headless: false,
    });
    expect(createRequests[0]).not.toHaveProperty("linkedComputerSessionId");
    await rendered.unmount();
  });

  test("opens a browser when optional linked Computer creation is unavailable", async () => {
    const created: BrowserSession = { ...browserSession(), headless: false };
    const createRequests: unknown[] = [];
    const notifications: Array<{ kind: string; message: string }> = [];
    const client = fakeClient({
      listBrowserSessions: async () => ({ revision: 1, sessions: [] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [] }),
      createBrowserSession: async (_workspaceId, request) => {
        createRequests.push(request);
        return mutation(created);
      },
      getBrowserSession: async () => created,
      listBrowserTargets: async () => ({
        browserSessionId: created.id,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        createLinkedComputer={async () => {
          throw new Error("No display is available on this placement");
        }}
        onNotify={(notification) => notifications.push(notification)}
      />,
    );
    await flush(30);

    const launchSummary = rendered.container.querySelector<HTMLElement>(
      "summary[aria-label='New browser']",
    );
    expect(launchSummary).not.toBeNull();
    await actRun(() => launchSummary!.click());
    const clean = [...(launchSummary!.closest("details")?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("Fresh browser"),
    );
    expect(clean).toBeDefined();
    await actRun(() => clean!.click());
    await flush(30);

    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "Browser",
      headless: false,
    });
    expect(createRequests[0]).not.toHaveProperty("linkedComputerSessionId");
    expect(createRequests[0]).not.toHaveProperty("placement");
    expect(notifications).toEqual([
      {
        kind: "info",
        message: "Browser opened. Desktop view is unavailable on this placement.",
      },
    ]);
    await rendered.unmount();
  });

  test("starts the canonical BrowserSession against a connected Chrome profile", async () => {
    const device = attachedBrowserDevice();
    const created: BrowserSession = {
      ...browserSession(),
      name: "cloudgeni.ai",
      placement: { kind: "attached_device", deviceId: device.id },
      engine: "chrome",
      headless: false,
      linkedComputerSessionId: COMPUTER_SESSION_ID,
      capabilities: {
        ...browserSession().capabilities,
        downloads: false,
        uploads: false,
        privateCheckpoint: false,
        identityPublication: false,
        linkedComputer: true,
      },
    };
    const createRequests: unknown[] = [];
    const linkedComputerCreates: Array<{
      name: string;
      placement: InteractionPlacement | undefined;
    }> = [];
    const client = fakeClient({
      listAttachedBrowsers: async () => ({ revision: 4, bridges: [], devices: [device] }),
      listBrowserSessions: async () => ({ revision: 1, sessions: [] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [] }),
      createBrowserSession: async (_workspaceId, request) => {
        createRequests.push(request);
        return mutation(created);
      },
      getBrowserSession: async () => created,
      listBrowserTargets: async () => ({
        browserSessionId: created.id,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        createLinkedComputer={async (name, placement) => {
          linkedComputerCreates.push({ name, placement });
          return {
            id: COMPUTER_SESSION_ID,
            placement: created.placement,
          };
        }}
      />,
    );
    await flush(30);

    const launchSummary = rendered.container.querySelector<HTMLElement>(
      "summary[aria-label='New browser']",
    );
    expect(launchSummary).not.toBeNull();
    await actRun(() => launchSummary!.click());
    const launchMenu = launchSummary!.closest("details");
    const connectedChrome = [...(launchMenu?.querySelectorAll("button") ?? [])].find((button) =>
      button.textContent?.includes("cloudgeni.ai"),
    );
    expect(connectedChrome).toBeDefined();
    await actRun(() => connectedChrome!.click());
    await flush(30);

    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "cloudgeni.ai",
      headless: false,
      linkedComputerSessionId: COMPUTER_SESSION_ID,
      placement: { kind: "attached_device", deviceId: device.id },
    });
    expect(linkedComputerCreates).toEqual([
      {
        name: "cloudgeni.ai desktop",
        placement: { kind: "attached_device", deviceId: device.id },
      },
    ]);
    expect(rendered.container.textContent).toContain("Your browser");
    expect(rendered.container.textContent).toContain("live");
    await rendered.unmount();
  });

  test("offers attached-Chrome setup when the machine bridge has no connected profile", async () => {
    const client = fakeClient({
      listAttachedBrowsers: async () => ({
        revision: 4,
        bridges: [attachedBrowserBridge()],
        devices: [],
      }),
      listBrowserSessions: async () => ({ revision: 1, sessions: [] }),
      listBrowserIdentities: async () => ({ revision: 1, identities: [] }),
    });
    const rendered = await renderComponent(
      <BrowserViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        browserExtensionSetupUrl="/browser-extension-setup.html"
      />,
    );
    await flush(30);

    const launchSummary = rendered.container.querySelector<HTMLElement>(
      "summary[aria-label='New browser']",
    );
    expect(launchSummary).not.toBeNull();
    await actRun(() => launchSummary!.click());
    const setup = [...(launchSummary!.closest("details")?.querySelectorAll("a") ?? [])].find(
      (link) => link.textContent?.includes("Connect this Chrome profile"),
    );
    expect(setup?.getAttribute("href")).toBe("/browser-extension-setup.html");
    expect(setup?.textContent).toContain("Chrome extension missing");
    await rendered.unmount();
  });
});

async function dispatch(socket: FakeBrowserSocket, type: string, event: any = {}): Promise<void> {
  await act(async () => socket.emit(type, event));
}

function relayMessage(tag: number, body: Uint8Array): ArrayBuffer {
  const message = new Uint8Array(body.byteLength + 1);
  message[0] = tag;
  message.set(body, 1);
  return message.buffer;
}

function frameMessage(
  targetId: string,
  sequence: number,
  controllerGeneration = "controller-1",
  overrides: Partial<BrowserFrameMetadata> = {},
): Uint8Array {
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  const metadata: BrowserFrameMetadata = {
    frameId: `frame-${sequence}`,
    browserSessionId: BROWSER_SESSION_ID,
    controllerGeneration,
    targetId,
    targetGeneration: `${targetId}-generation`,
    documentGeneration: "document-1",
    sequence,
    mediaType: "image/png",
    width: 1,
    height: 1,
    deviceScaleFactor: 1,
    scrollX: 0,
    scrollY: 0,
    capturedAt: NOW,
    ...overrides,
  };
  const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
  const message = new Uint8Array(4 + encodedMetadata.byteLength + png.byteLength);
  new DataView(message.buffer).setUint32(0, encodedMetadata.byteLength, false);
  message.set(encodedMetadata, 4);
  message.set(png, 4 + encodedMetadata.byteLength);
  return message;
}
