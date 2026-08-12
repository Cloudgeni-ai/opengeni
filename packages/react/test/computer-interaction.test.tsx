import { describe, expect, test } from "bun:test";
import { StreamFrame, StreamOpen, StreamOpenAck } from "@opengeni/agent-proto";
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
  operationId = crypto.randomUUID(),
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
      protocols: [
        "binary",
        "opengeni.computer.rfb.v1",
        "opengeni.auth.super-secret",
      ],
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
    let release: ((value: ArrayBuffer) => void) | null = null;
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
    release?.(frameMessage("window-1", 9).buffer as ArrayBuffer);
    await flush(20);
    expect(hook.result.current.frame).toBeNull();
    expect(sockets[0]?.closed).toBe(true);
    await hook.unmount();
  });
});

describe("ComputerViewer", () => {
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
        "textarea[aria-label='Computer keyboard input']",
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
      "textarea[aria-label='Computer keyboard input']",
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
