import { describe, expect, test } from "bun:test";
import { StreamFrame, StreamOpen, StreamOpenAck } from "@opengeni/agent-proto";
import { OpenGeniApiError } from "@opengeni/sdk";
import type {
  ComputerActionReceipt,
  ComputerFrame,
  ComputerFrameMetadata,
  ComputerObservation,
  ComputerSession,
  ComputerSessionAttachment,
  ComputerSessionMutationResponse,
  ComputerTarget,
} from "@opengeni/sdk/interaction";
import { act } from "react";
import { computerKey, ComputerViewer } from "../src/components/computer-viewer";
import type {
  ComputerFrameWebSocket,
  ComputerFrameWebSocketFactory,
} from "../src/hooks/use-computer-frame-stream";
import { useComputerFrameStream } from "../src/hooks/use-computer-frame-stream";
import { useComputerSession } from "../src/hooks/use-computer-session";
import { useComputerSessions } from "../src/hooks/use-computer-sessions";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderComponent, renderHook } from "./render-hook";

registerDom();

const COMPUTER_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const PEER_COMPUTER_SESSION_ID = "55555555-5555-4555-8555-555555555555";
const PEER_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SANDBOX_GROUP_ID = "66666666-6666-4666-8666-666666666666";
const ATTACHED_DEVICE_ID = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-08-10T12:00:00.000Z";
const PNG_SHA256 = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";

function computerSession(
  id = COMPUTER_SESSION_ID,
  associationSessionId = SESSION_ID,
  name = "Agent computer",
): ComputerSession {
  return {
    id,
    accountId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    name,
    lifecycle: "active",
    placement: { kind: "sandbox_group", sandboxGroupId: SANDBOX_GROUP_ID },
    controller: {
      controllerId: "opengeni-interaction-controller",
      controllerGeneration: "controller-1",
      placementInstanceId: "placement-1",
    },
    platform: "linux",
    adapter: "opengeni.linux.atspi-x11.v1",
    seatId: "seat-1",
    displayId: ":99",
    capabilities: {
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
    },
    associations: [
      {
        sessionId: associationSessionId,
        turnId: null,
        attemptId: null,
        relationship: "using",
        actorSubjectId: "agent:test",
        lastUsedAt: NOW,
      },
    ],
    createdBySubjectId: "agent:test",
    createdAt: NOW,
    lastUsedAt: NOW,
    failureCode: null,
  };
}

function lostAttachedComputer(
  id = COMPUTER_SESSION_ID,
  associationSessionId = SESSION_ID,
): ComputerSession {
  return {
    ...computerSession(id, associationSessionId),
    lifecycle: "lost",
    failureCode: "controller_transition_expired",
    placement: { kind: "attached_device", deviceId: ATTACHED_DEVICE_ID },
    platform: "macos",
    adapter: "opengeni.ax.v1",
  };
}

function lostConnectedComputer(
  id = COMPUTER_SESSION_ID,
  associationSessionId = SESSION_ID,
): ComputerSession {
  return {
    ...computerSession(id, associationSessionId),
    lifecycle: "lost",
    failureCode: "source_placement_changed",
    placement: { kind: "connected_machine", sandboxId: ATTACHED_DEVICE_ID },
    platform: "macos",
    adapter: "opengeni.macos.v1",
  };
}

function startingComputerSession(
  id = COMPUTER_SESSION_ID,
  associationSessionId = SESSION_ID,
): ComputerSession {
  return {
    ...computerSession(id, associationSessionId),
    lifecycle: "starting",
    controller: null,
    platform: null,
    adapter: null,
    seatId: null,
    displayId: null,
    capabilities: null,
  };
}

function target(id = "window-1", kind: ComputerTarget["kind"] = "window"): ComputerTarget {
  return {
    id,
    computerSessionId: COMPUTER_SESSION_ID,
    controllerGeneration: "controller-1",
    targetGeneration: `${id}-generation`,
    kind,
    applicationId: kind === "screen" ? null : "org.opengeni.test",
    processId: kind === "screen" ? null : 4_201,
    title: kind === "screen" ? "Agent desktop" : "Test window",
    bounds: { x: 0, y: 0, width: 1_280, height: 720 },
    focused: kind === "window",
  };
}

function observation(current = target()): ComputerObservation {
  return {
    protocolVersion: 1,
    observationId: `observation-${current.targetGeneration}`,
    computerSessionId: current.computerSessionId,
    target: current,
    frameId: `frame-${current.targetGeneration}`,
    semantic:
      current.kind === "screen"
        ? null
        : {
            kind: "snapshot",
            roots: [
              {
                ref: "e1",
                role: "button",
                name: "Run checks",
                states: [],
                actions: ["invoke"],
              },
            ],
            nodeCount: 1,
          },
    screenshot: null,
    focusedRef: current.kind === "screen" ? null : "e1",
    changedRegions: [],
    observedAt: NOW,
  };
}

function mutation(
  session = computerSession(),
  kind: "create" | "end" = "create",
  operationId: string = crypto.randomUUID(),
): ComputerSessionMutationResponse {
  return {
    session,
    operation: {
      operationId,
      resourceKind: "computer_session",
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

function receipt(current: ComputerObservation, operationId: string): ComputerActionReceipt {
  return {
    protocolVersion: 1,
    operationId,
    computerSessionId: current.computerSessionId,
    controllerGeneration: current.target.controllerGeneration,
    targetId: current.target.id,
    state: "completed",
    dispatchedAt: NOW,
    settledAt: NOW,
    observation: current,
    error: null,
  };
}

function attachment(targetId: string): ComputerSessionAttachment {
  return {
    computerSessionId: COMPUTER_SESSION_ID,
    controllerGeneration: "controller-1",
    targetId,
    stream: {
      kind: "direct_websocket",
      url: "wss://computer.example.test/v1/frames",
      protocols: ["opengeni.computer.v1", "opengeni.auth.super-secret"],
    },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

function relayAttachment(targetId: string): ComputerSessionAttachment {
  return {
    computerSessionId: COMPUTER_SESSION_ID,
    controllerGeneration: "controller-1",
    targetId,
    stream: {
      kind: "relay",
      url: "wss://relay.example.test/stream?opaque-routing-key",
      token: "ogs_test-relay-grant",
      channel: {
        channelId: "computer-channel-1",
        workspaceId: WORKSPACE_ID,
        agentId: "agent-1",
        kind: 4,
        port: 20_002,
      },
    },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

function rfbAttachment(targetId: string): ComputerSessionAttachment {
  return {
    computerSessionId: COMPUTER_SESSION_ID,
    controllerGeneration: "controller-1",
    targetId,
    stream: {
      kind: "direct_rfb",
      url: "wss://computer.example.test/v1/rfb",
      protocols: ["binary", "opengeni.computer.rfb.v1", "opengeni.auth.super-secret"],
    },
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
}

class FakeComputerSocket {
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

describe("ComputerSession React resources", () => {
  test("discovers current-agent and peer computers without hiding either", async () => {
    const current = computerSession();
    const peer = computerSession(PEER_COMPUTER_SESSION_ID, PEER_SESSION_ID, "Peer Mac");
    const created = computerSession(
      "88888888-8888-4888-8888-888888888888",
      SESSION_ID,
      "Second computer",
    );
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 3, sessions: [peer, current] }),
      createComputerSession: async () => mutation(created),
    });
    const hook = await renderHook(
      () =>
        useComputerSessions({
          client,
          workspaceId: WORKSPACE_ID,
          sessionId: SESSION_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    expect(hook.result.current.sessions.map((session) => session.id).sort()).toEqual(
      [COMPUTER_SESSION_ID, PEER_COMPUTER_SESSION_ID].sort(),
    );
    expect(hook.result.current.relevantSessions.map((session) => session.id)).toEqual([
      COMPUTER_SESSION_ID,
    ]);
    await actRun(async () => {
      await hook.result.current.create({ sessionId: SESSION_ID, name: "Second computer" });
    });
    expect(hook.result.current.sessions.some((session) => session.id === created.id)).toBe(true);
    await hook.unmount();
  });

  test("keeps target selection local and fences semantic and pixel actions exactly", async () => {
    const windowTarget = target();
    const screenTarget = target("screen-1", "screen");
    const requests: unknown[] = [];
    const client = fakeClient({
      getComputerSession: async () => ({
        ...computerSession(),
        platform: "macos",
        adapter: "opengeni.macos.ax-sck.v1",
      }),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [windowTarget, screenTarget],
      }),
      observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) =>
        observation(targetId === screenTarget.id ? screenTarget : windowTarget),
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        requests.push(request);
        const current = request.targetId === screenTarget.id ? screenTarget : windowTarget;
        return receipt(observation(current), request.operationId);
      },
    });
    const hook = await renderHook(
      () =>
        useComputerSession({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    await actRun(async () => {
      await hook.result.current.act({
        type: "semantic",
        locator: { kind: "ref", ref: "e1" },
        action: "invoke",
      });
    });
    expect(requests[0]).toMatchObject({
      targetId: "window-1",
      expectedTargetGeneration: "window-1-generation",
      expectedObservationId: "observation-window-1-generation",
      expectedFrameId: null,
    });

    await actRun(async () => {
      await hook.result.current.selectTarget(screenTarget.id);
    });
    expect(requests).toHaveLength(1);
    const frame: ComputerFrame = {
      frameId: "visible-frame",
      computerSessionId: COMPUTER_SESSION_ID,
      controllerGeneration: "controller-1",
      targetId: screenTarget.id,
      targetGeneration: "screen-frame-generation",
      sequence: 7,
      mediaType: "image/png",
      width: 1,
      height: 1,
      capturedAt: NOW,
      sha256: PNG_SHA256,
      data: new Uint8Array([1]),
    };
    await actRun(async () => {
      await hook.result.current.actFromFrame(
        {
          type: "pointer",
          frameId: frame.frameId,
          action: "click",
          x: 0,
          y: 0,
        },
        frame,
      );
    });
    expect(requests[1]).toMatchObject({
      targetId: "screen-1",
      expectedTargetGeneration: "screen-frame-generation",
      expectedObservationId: null,
      expectedFrameId: "visible-frame",
      action: { frameId: "visible-frame" },
    });
    await hook.unmount();
  });

  test("prefers a capturable macOS screen over a focused semantic-only application", async () => {
    const applicationTarget = { ...target("app-1", "app"), focused: true };
    const screenTarget = target("screen-1", "screen");
    const observed: string[] = [];
    const client = fakeClient({
      getComputerSession: async () => ({
        ...computerSession(),
        platform: "macos",
        adapter: "opengeni.macos.ax-sck.v1",
      }),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [applicationTarget, screenTarget],
      }),
      observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) => {
        observed.push(targetId);
        return observation(targetId === screenTarget.id ? screenTarget : applicationTarget);
      },
    });
    const hook = await renderHook(
      () =>
        useComputerSession({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          pollIntervalMs: 60_000,
        }),
      undefined,
    );
    await flush(20);

    expect(hook.result.current.selectedTarget?.id).toBe(screenTarget.id);
    expect(observed).toEqual([screenTarget.id]);
    await hook.unmount();
  });
});

describe("ComputerSession frame stream", () => {
  test("hands a direct RFB attachment to the viewer without opening a frame socket", async () => {
    let sockets = 0;
    const client = fakeClient({
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        rfbAttachment(request.targetId),
    });
    const hook = await renderHook(
      () =>
        useComputerFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          targetId: "screen-1",
          webSocketFactory: () => {
            sockets += 1;
            throw new Error("direct RFB must not use the frame WebSocket client");
          },
        }),
      undefined,
    );
    await flush(20);
    expect(hook.result.current.state).toBe("live");
    expect(hook.result.current.attachment?.stream.kind).toBe("direct_rfb");
    expect(sockets).toBe(0);
    await hook.unmount();
  });

  test("keeps grants out of URLs, authenticates frames, and clears on target switch", async () => {
    const sockets: FakeComputerSocket[] = [];
    const client = fakeClient({
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        attachment(request.targetId),
    });
    const factory: ComputerFrameWebSocketFactory = (url, protocols) => {
      const socket = new FakeComputerSocket(url, protocols);
      sockets.push(socket);
      return socket as unknown as ComputerFrameWebSocket;
    };
    const hook = await renderHook(
      (props: { targetId: string }) =>
        useComputerFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          targetId: props.targetId,
          webSocketFactory: factory,
        }),
      { targetId: "window-1" },
    );
    await flush(10);
    expect(sockets[0]?.url).not.toContain("super-secret");
    expect(sockets[0]?.protocols).toEqual(["opengeni.computer.v1", "opengeni.auth.super-secret"]);
    await dispatch(sockets[0]!, "open");
    await dispatch(sockets[0]!, "message", { data: frameMessage("window-1", 2).buffer });
    await dispatch(sockets[0]!, "message", { data: frameMessage("window-1", 1).buffer });
    await flush(10);
    expect(hook.result.current.frame?.sequence).toBe(2);

    await hook.rerender({ targetId: "screen-1" });
    expect(hook.result.current.frame).toBeNull();
    expect(sockets[0]?.closed).toBe(true);
    await hook.unmount();
  });

  test("uses the distinct Computer relay stream kind", async () => {
    let socket: FakeComputerSocket | null = null;
    const client = fakeClient({
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        relayAttachment(request.targetId),
    });
    const hook = await renderHook(
      () =>
        useComputerFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          targetId: "window-1",
          webSocketFactory: (url, protocols) => {
            socket = new FakeComputerSocket(url, protocols);
            return socket as unknown as ComputerFrameWebSocket;
          },
        }),
      undefined,
    );
    await flush(10);
    await dispatch(socket!, "open");
    const openDatagram = new Uint8Array(socket!.sent[0]!);
    expect(openDatagram[0]).toBe(1);
    expect(StreamOpen.decode(openDatagram.subarray(1))).toMatchObject({
      token: "ogs_test-relay-grant",
      channel: { channelId: "computer-channel-1", kind: 4 },
    });

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
          channelId: "computer-channel-1",
          seq: "1",
          data: frameMessage("window-1", 1),
          producedAtMs: String(Date.now()),
        }).finish(),
      ),
    });
    await flush(10);
    expect(hook.result.current.frame?.sequence).toBe(1);
    await hook.unmount();
  });

  test("cannot publish a delayed frame from a detached socket after target switch", async () => {
    const sockets: FakeComputerSocket[] = [];
    let release!: (value: ArrayBuffer) => void;
    const delayed = new (class extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
    })();
    const client = fakeClient({
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        attachment(request.targetId),
    });
    const hook = await renderHook(
      (props: { targetId: string }) =>
        useComputerFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          targetId: props.targetId,
          webSocketFactory: (url, protocols) => {
            const socket = new FakeComputerSocket(url, protocols);
            sockets.push(socket);
            return socket as unknown as ComputerFrameWebSocket;
          },
        }),
      { targetId: "window-1" },
    );
    await flush(10);
    await dispatch(sockets[0]!, "open");
    await dispatch(sockets[0]!, "message", { data: delayed });
    await hook.rerender({ targetId: "screen-1" });
    await flush(10);
    release(frameMessage("window-1", 9).buffer as ArrayBuffer);
    await flush(20);
    expect(hook.result.current.frame).toBeNull();
    expect(sockets[0]?.closed).toBe(true);
    await hook.unmount();
  });

  test("does not auto-reconnect after a placement-generation 409", async () => {
    let attachCalls = 0;
    const client = fakeClient({
      attachComputerSession: async () => {
        attachCalls += 1;
        throw new OpenGeniApiError(
          409,
          JSON.stringify({ message: "ComputerSession placement instance changed" }),
        );
      },
    });
    const hook = await renderHook(
      () =>
        useComputerFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          targetId: "window-1",
        }),
      undefined,
    );
    await flush(80);
    expect(attachCalls).toBe(1);
    expect(hook.result.current.state).toBe("error");
    expect(hook.result.current.error?.message).toMatch(/placement instance changed/i);
    await flush(400);
    expect(attachCalls).toBe(1);
    await hook.unmount();
  });
});

describe("ComputerViewer", () => {
  test("retires a stale Connected Machine Desktop, stops polling, and recreates once", async () => {
    const stale = {
      ...computerSession(),
      placement: {
        kind: "connected_machine" as const,
        sandboxId: ATTACHED_DEVICE_ID,
      },
      platform: "macos" as const,
      adapter: "opengeni.macos.v1",
    };
    const lost = lostConnectedComputer();
    const replacement = startingComputerSession(PEER_COMPUTER_SESSION_ID);
    let catalogCalls = 0;
    let targetCalls = 0;
    let createCalls = 0;
    const client = fakeClient({
      listComputerSessions: async () => ({
        revision: ++catalogCalls,
        sessions: catalogCalls === 1 ? [stale] : createCalls === 0 ? [lost] : [lost, replacement],
      }),
      getComputerSession: async (_workspaceId, computerSessionId) =>
        computerSessionId === replacement.id ? replacement : stale,
      listComputerTargets: async (_workspaceId, computerSessionId) => {
        if (computerSessionId === replacement.id) {
          return {
            computerSessionId,
            controllerGeneration: "controller-2",
            targets: [],
          };
        }
        targetCalls += 1;
        throw new OpenGeniApiError(
          409,
          JSON.stringify({
            error: {
              status: 409,
              code: "conflict",
              message: "This Desktop belonged to a previous task placement and was retired.",
              retryable: false,
              outcomeUnknown: false,
              details: {
                interactionResource: "computer_session",
                interactionFailureCode: "source_placement_changed",
                interactionLifecycle: "lost",
              },
            },
          }),
        );
      },
      createComputerSession: async () => {
        createCalls += 1;
        return mutation(replacement);
      },
    });

    const rendered = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(120);
    expect(catalogCalls).toBeGreaterThanOrEqual(2);
    expect(targetCalls).toBe(1);
    expect(createCalls).toBe(1);
    await flush(900);
    expect(targetCalls).toBe(1);
    expect(createCalls).toBe(1);
    await rendered.unmount();

    const remounted = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(120);
    expect(createCalls).toBe(1);
    await remounted.unmount();
  });

  test("restores the task's last selected Desktop session", async () => {
    const current = computerSession();
    const peer = computerSession(PEER_COMPUTER_SESSION_ID, PEER_SESSION_ID, "Peer Mac");
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [current, peer] }),
      getComputerSession: async (_workspaceId, computerSessionId) =>
        computerSessionId === peer.id ? peer : current,
      listComputerTargets: async (_workspaceId, computerSessionId) => ({
        computerSessionId,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const changes: Array<string | null> = [];
    const viewer = (enabled: boolean) => (
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        enabled={enabled}
        initialComputerSessionId={peer.id}
        onComputerSessionIdChange={(computerSessionId) => changes.push(computerSessionId)}
      />
    );
    const rendered = await renderComponent(viewer(true));
    await flush(40);

    expect(rendered.container.querySelector("summary")?.textContent).toContain("Peer Mac");
    await rendered.rerender(viewer(false));
    await flush(10);
    await rendered.rerender(viewer(true));
    await flush(40);
    expect(rendered.container.querySelector("summary")?.textContent).toContain("Peer Mac");
    expect(changes).toEqual([]);
    await rendered.unmount();
  });

  test("reuses the task desktop when a hidden surface is enabled", async () => {
    let createCalls = 0;
    const current = computerSession();
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [current] }),
      createComputerSession: async () => {
        createCalls += 1;
        return mutation(startingComputerSession());
      },
    });
    const viewer = (enabled: boolean) => (
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        enabled={enabled}
      />
    );

    const rendered = await renderComponent(viewer(false));
    await flush(10);
    await rendered.rerender(viewer(true));
    await flush(40);

    expect(createCalls).toBe(0);
    expect(rendered.container.textContent).toContain("Agent computer");
    await rendered.unmount();
  });

  test("never auto-creates a duplicate after this task's desktop was observed", async () => {
    let listCalls = 0;
    let createCalls = 0;
    const current = computerSession();
    const client = fakeClient({
      listComputerSessions: async () => ({
        revision: ++listCalls,
        sessions: listCalls === 1 ? [current] : [],
      }),
      createComputerSession: async () => {
        createCalls += 1;
        return mutation(startingComputerSession());
      },
    });
    const viewer = (enabled: boolean) => (
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        enabled={enabled}
      />
    );

    const rendered = await renderComponent(viewer(true));
    await flush(40);
    await rendered.rerender(viewer(false));
    await flush(10);
    await rendered.rerender(viewer(true));
    await flush(60);

    expect(listCalls).toBe(2);
    expect(createCalls).toBe(0);
    await rendered.unmount();
  });

  test("confirms an empty catalog before lazily creating a desktop", async () => {
    let listCalls = 0;
    let createCalls = 0;
    const current = computerSession();
    const client = fakeClient({
      listComputerSessions: async () => ({
        revision: ++listCalls,
        sessions: listCalls === 1 ? [] : [current],
      }),
      createComputerSession: async () => {
        createCalls += 1;
        return mutation(startingComputerSession());
      },
    });

    const rendered = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(80);

    expect(listCalls).toBe(2);
    expect(createCalls).toBe(0);
    expect(rendered.container.textContent).toContain("Agent computer");
    await rendered.unmount();
  });

  test("lazily creates this agent's computer on first visit even when peers exist", async () => {
    const peer = computerSession(PEER_COMPUTER_SESSION_ID, PEER_SESSION_ID, "Peer Mac");
    const starting = startingComputerSession();
    const createRequests: unknown[] = [];
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [peer] }),
      createComputerSession: async (_workspaceId, request) => {
        createRequests.push(request);
        return mutation(starting, "create", request.operationId);
      },
    });

    const rendered = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(60);

    expect(createRequests).toHaveLength(1);
    expect(createRequests[0]).toMatchObject({ sessionId: SESSION_ID, name: "Desktop" });
    expect(rendered.container.textContent).toContain("Opening desktop");
    expect(rendered.container.textContent).not.toContain("No computer for this agent");
    await rendered.unmount();
  });

  test("does not create a generic desktop after attached Chrome generation loss", async () => {
    let createCalls = 0;
    let endCalls = 0;
    const lost = lostAttachedComputer();
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [lost] }),
      createComputerSession: async () => {
        createCalls += 1;
        return mutation(startingComputerSession());
      },
      endComputerSession: async () => {
        endCalls += 1;
        return mutation({ ...lost, lifecycle: "ended", failureCode: null }, "end");
      },
    });

    const rendered = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(80);

    expect(createCalls).toBe(0);
    expect(endCalls).toBe(1);
    expect(rendered.container.textContent).toContain("Chrome reconnected");
    expect(rendered.container.textContent).toContain("Connected Chrome");
    expect(
      [...rendered.container.querySelectorAll("button")].some(
        (button) =>
          button.textContent?.includes("Try again") ||
          button.getAttribute("aria-label") === "Open a new desktop",
      ),
    ).toBe(false);
    await rendered.unmount();
  });

  test("does not loop automatic creation and offers retry after a real failure", async () => {
    let createCalls = 0;
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [] }),
      createComputerSession: async () => {
        createCalls += 1;
        throw new Error("No computer placement is available.");
      },
    });

    const rendered = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(80);

    expect(createCalls).toBe(1);
    expect(rendered.container.textContent).toContain("Desktop didn’t open");
    expect(rendered.container.textContent).toContain("No computer placement is available.");
    const retry = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Try again",
    );
    expect(retry).toBeDefined();
    await actRun(() => retry!.click());
    await flush(30);
    expect(createCalls).toBe(2);
    await rendered.unmount();
  });

  test("ignores standalone modifier keydowns before a computer shortcut", () => {
    const event = (
      key: string,
      modifiers: Partial<{
        altKey: boolean;
        ctrlKey: boolean;
        metaKey: boolean;
        shiftKey: boolean;
      }> = {},
    ) => ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, key, ...modifiers });
    expect(computerKey(event("Meta", { metaKey: true }))).toBeNull();
    expect(computerKey(event("Control", { ctrlKey: true }))).toBeNull();
    expect(computerKey(event("Alt", { altKey: true }))).toBeNull();
    expect(computerKey(event("a", { metaKey: true }))).toBe("Meta+a");
  });

  test("keeps semantic-only application targets out of the frame attachment path", async () => {
    const applicationTarget = { ...target("app-1", "app"), focused: true };
    let attachmentCalls = 0;
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      getComputerSession: async () => ({
        ...computerSession(),
        platform: "macos",
        adapter: "opengeni.macos.ax-sck.v1",
      }),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [applicationTarget],
      }),
      observeComputerTarget: async () => observation(applicationTarget),
      attachComputerSession: async (_workspaceId, _computerSessionId, request) => {
        attachmentCalls += 1;
        return attachment(request.targetId);
      },
    });
    const rendered = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(40);

    expect(attachmentCalls).toBe(0);
    await rendered.unmount();
  });

  test("renders a typed connected-machine startup failure with truthful retry copy", async () => {
    const current = computerSession();
    const currentTarget = target();
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [current] }),
      getComputerSession: async () => current,
      listComputerTargets: async () => ({
        computerSessionId: current.id,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeComputerTarget: async () => observation(currentTarget),
      attachComputerSession: async () => {
        throw new OpenGeniApiError(
          504,
          JSON.stringify({
            error: {
              status: 504,
              code: "upstream_unavailable",
              message:
                "The connected machine did not finish opening the computer live view in time.",
              retryable: true,
              outcomeUnknown: true,
              requestId: "outer-computer-request",
              details: {
                interactionLayer: "connected_machine",
                interactionSurface: "computer",
                controlFailureCode: "timeout",
                controlRequestId: "inner-computer-request",
              },
            },
          }),
          { mutation: true },
        );
      },
    });
    const rendered = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    await flush(40);

    expect(rendered.container.textContent).toContain("Live view disconnected");
    expect(rendered.container.textContent).toContain(
      "The connected machine did not finish opening the computer live view in time.",
    );
    expect(rendered.container.textContent).toContain("Reconnect");
    await rendered.unmount();
  });

  test("pins an exact ComputerSession requested by Browser navigation", async () => {
    const current = computerSession();
    const peer = computerSession(PEER_COMPUTER_SESSION_ID, PEER_SESSION_ID, "Peer Mac");
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [current, peer] }),
      getComputerSession: async (_workspaceId, computerSessionId) =>
        computerSessionId === peer.id ? peer : current,
      listComputerTargets: async (_workspaceId, computerSessionId) => ({
        computerSessionId,
        controllerGeneration: "controller-1",
        targets: [],
      }),
    });
    const rendered = await renderComponent(
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        requestedComputerSessionId={peer.id}
        requestedComputerRequestId={1}
      />,
    );
    await flush(40);
    expect(rendered.container.querySelector("summary")?.textContent).toContain("Peer Mac");
    await rendered.rerender(
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        requestedComputerSessionId={current.id}
        requestedComputerRequestId={2}
      />,
    );
    await flush(20);
    expect(rendered.container.querySelector("summary")?.textContent).toContain("Agent computer");
    await rendered.unmount();
  });

  test("shows peers and routes native controls through the canonical action API", async () => {
    const current = computerSession();
    const peer = computerSession(PEER_COMPUTER_SESSION_ID, PEER_SESSION_ID, "Peer Mac");
    const currentTarget = target();
    const actions: unknown[] = [];
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [current, peer] }),
      getComputerSession: async () => current,
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeComputerTarget: async () => observation(currentTarget),
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        attachment(request.targetId),
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        actions.push(request);
        return receipt(observation(currentTarget), request.operationId);
      },
    });
    const rendered = await renderComponent(
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeComputerSocket(url, protocols) as unknown as ComputerFrameWebSocket
        }
      />,
    );
    await flush(40);
    expect(rendered.container.textContent).toContain("Agent computer");
    expect(rendered.container.textContent).toContain("Peer Mac");
    const action = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Run checks",
    );
    expect(action).toBeDefined();
    await actRun(() => action!.click());
    await flush(5);
    expect(actions[0]).toMatchObject({
      targetId: "window-1",
      expectedObservationId: "observation-window-1-generation",
      action: { type: "semantic", locator: { kind: "ref", ref: "e1" }, action: "invoke" },
    });
    expect(rendered.container.textContent).toContain("semantic controls stay in the background");
    expect(
      rendered.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Desktop keyboard input']",
      )?.disabled,
    ).toBe(false);
    await rendered.unmount();
  });

  test("keeps semantic controls live but disables raw input for an unfocused background window", async () => {
    const backgroundWindow = { ...target(), focused: false };
    const actions: unknown[] = [];
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [backgroundWindow],
      }),
      observeComputerTarget: async () => observation(backgroundWindow),
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        attachment(request.targetId),
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        actions.push(request);
        return receipt(observation(backgroundWindow), request.operationId);
      },
    });
    const rendered = await renderComponent(
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeComputerSocket(url, protocols) as unknown as ComputerFrameWebSocket
        }
      />,
    );
    await flush(40);

    const keyboard = rendered.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Desktop keyboard input']",
    );
    expect(keyboard?.disabled).toBe(true);
    if (keyboard) {
      keyboard.value = "must-not-foreground";
      await actRun(() => keyboard.dispatchEvent(new InputEvent("input", { bubbles: true })));
    }
    expect(actions).toHaveLength(0);

    const semantic = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Run checks",
    );
    expect(semantic).toBeDefined();
    await actRun(() => semantic!.click());
    await flush(5);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      action: { type: "semantic", locator: { kind: "ref", ref: "e1" }, action: "invoke" },
    });
    await rendered.unmount();
  });

  test("verifies the native clipboard before issuing a paste keystroke", async () => {
    const currentTarget = target();
    const actions: Array<ComputerActionReceipt["state"] | string> = [];
    let clipboardText: string | null = null;
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeComputerTarget: async () => observation(currentTarget),
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        attachment(request.targetId),
      readComputerClipboard: async () => {
        actions.push("read");
        return {
          computerSessionId: COMPUTER_SESSION_ID,
          controllerGeneration: "controller-1",
          text: clipboardText,
          truncated: false,
          observedAt: NOW,
        };
      },
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        const action = request.action;
        if (action.type === "clipboard") {
          actions.push(action.operation);
          if (action.operation === "write" && action.text !== undefined) {
            clipboardText = action.text;
          }
        }
        return receipt(observation(currentTarget), request.operationId);
      },
    });
    const rendered = await renderComponent(
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) =>
          new FakeComputerSocket(url, protocols) as unknown as ComputerFrameWebSocket
        }
      />,
    );
    await flush(40);
    const keyboard = rendered.container.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Desktop keyboard input']",
    );
    expect(keyboard).not.toBeNull();
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: (type: string) => (type === "text/plain" ? "exact native paste" : "") },
    });
    await actRun(() => keyboard!.dispatchEvent(paste));
    await flush(20);

    expect(paste.defaultPrevented).toBe(true);
    expect(actions).toEqual(["write", "read", "paste"]);
    await rendered.unmount();
  });
});

async function dispatch(socket: FakeComputerSocket, type: string, event: any = {}): Promise<void> {
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
  overrides: Partial<ComputerFrameMetadata> = {},
): Uint8Array {
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  const metadata: ComputerFrameMetadata = {
    frameId: `frame-${sequence}`,
    computerSessionId: COMPUTER_SESSION_ID,
    controllerGeneration: "controller-1",
    targetId,
    targetGeneration: `${targetId}-generation`,
    sequence,
    mediaType: "image/png",
    width: 1,
    height: 1,
    capturedAt: NOW,
    sha256: PNG_SHA256,
    ...overrides,
  };
  const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
  const message = new Uint8Array(4 + encodedMetadata.byteLength + png.byteLength);
  new DataView(message.buffer).setUint32(0, encodedMetadata.byteLength, false);
  message.set(encodedMetadata, 4);
  message.set(png, 4 + encodedMetadata.byteLength);
  return message;
}
