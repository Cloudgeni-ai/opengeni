import { describe, expect, test } from "bun:test";
import { StreamFrame, StreamOpen, StreamOpenAck } from "@opengeni/agent-proto";
import type {
  AttachedBrowserDevice,
  BrowserActionReceipt,
  BrowserFrame,
  BrowserFrameMetadata,
  BrowserIdentity,
  BrowserObservation,
  BrowserRevision,
  BrowserSession,
  BrowserSessionAttachment,
  BrowserSessionMutationResponse,
  BrowserTarget,
  InteractionIntervention,
} from "@opengeni/sdk/interaction";
import { act } from "react";
import { BrowserViewer } from "../src/components/browser-viewer";
import { useAttachedBrowsers } from "../src/hooks/use-attached-browsers";
import type {
  BrowserFrameWebSocket,
  BrowserFrameWebSocketFactory,
} from "../src/hooks/use-browser-frame-stream";
import { useBrowserFrameStream } from "../src/hooks/use-browser-frame-stream";
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
      clipboard: false,
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

function browserIdentity(): BrowserIdentity {
  return {
    id: BROWSER_IDENTITY_ID,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name: "Work",
    status: "active",
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
    const calls: unknown[] = [];
    const client = fakeClient({
      listAttachedBrowsers: async (_workspaceId, options) => {
        calls.push(options);
        return { revision: 7, devices: [device] };
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
});

describe("BrowserViewer", () => {
  test("opens actionable runtime and page diagnostics without leaving the browser", async () => {
    const current = browserSession();
    const currentTarget = target();
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
          downloadCount: 0,
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

    const close = rendered.container.querySelector<HTMLButtonElement>(
      "button[aria-label='Close browser diagnostics']",
    );
    expect(close).not.toBeNull();
    await actRun(() => close!.click());
    expect(rendered.container.querySelector("[aria-label='Browser diagnostics']")).toBeNull();
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
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
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
      <BrowserViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
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
      address!.value = "example.com";
      address!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await actRun(() => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush(5);
    expect(actions).toHaveLength(2);
    expect(canvas?.className).toContain("invisible");
    expect(rendered.container.textContent).toContain("Connecting");
    await rendered.unmount();
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
      (button) => button.textContent?.includes("Clean browser"),
    );
    expect(clean).toBeDefined();
    await actRun(() => clean!.click());
    await flush(30);

    expect(sequence).toEqual(["computer:Browser computer", "browser"]);
    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({
      sessionId: SESSION_ID,
      name: "Browser",
      headless: false,
      linkedComputerSessionId: COMPUTER_SESSION_ID,
      placement: created.placement,
    });
    const openComputer = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Computer",
    );
    expect(openComputer).toBeDefined();
    await actRun(() => openComputer!.click());
    expect(opened).toEqual([COMPUTER_SESSION_ID]);
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
      capabilities: {
        ...browserSession().capabilities,
        downloads: false,
        uploads: false,
        privateCheckpoint: false,
        identityPublication: false,
      },
    };
    const createRequests: unknown[] = [];
    const client = fakeClient({
      listAttachedBrowsers: async () => ({ revision: 4, devices: [device] }),
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
      placement: { kind: "attached_device", deviceId: device.id },
    });
    expect(rendered.container.textContent).toContain("Your browser");
    expect(rendered.container.textContent).toContain("live");
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
