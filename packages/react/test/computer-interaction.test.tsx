import { describe, expect, jest, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { StreamClose, StreamFrame, StreamOpen, StreamOpenAck } from "@opengeni/agent-proto";
import { OpenGeniApiError } from "@opengeni/sdk";
import type {
  ComputerActionReceipt,
  ComputerActionRequest,
  ComputerClipboard,
  ComputerFrame,
  ComputerFrameMetadata,
  ComputerObservation,
  ComputerSession,
  ComputerSessionAttachment,
  ComputerSessionMutationResponse,
  ComputerTarget,
} from "@opengeni/sdk/interaction";
import { act, useLayoutEffect } from "react";
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
      inputAllowed: true,
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

  test.each(["pending", "failed"])(
    "allows switching targets while the initial observation is %s",
    async (initialState) => {
      const windowTarget = target();
      const screenTarget = target("screen-1", "screen");
      const inputRequests: unknown[] = [];
      let settleInitial!: (value: ComputerObservation) => void;
      const initial = new Promise<ComputerObservation>((resolve) => {
        settleInitial = resolve;
      });
      const client = fakeClient({
        getComputerSession: async () => ({ ...computerSession(), platform: "macos" }),
        listComputerTargets: async () => ({
          computerSessionId: COMPUTER_SESSION_ID,
          controllerGeneration: "controller-1",
          targets: [windowTarget, screenTarget],
        }),
        observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) => {
          if (targetId === windowTarget.id) return observation(windowTarget);
          if (initialState === "failed") throw new Error("Observation timed out");
          return await initial;
        },
        actInComputer: async (_workspaceId, _computerSessionId, request) => {
          inputRequests.push(request);
          return { ...receipt(observation(screenTarget), request.operationId), observation: null };
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
      try {
        await flush(20);
        expect(hook.result.current.targets).toHaveLength(2);
        expect(hook.result.current.selectedTarget?.id).toBe(screenTarget.id);
        expect(hook.result.current.observation).toBeNull();
        await actRun(async () => {
          await hook.result.current.act({ type: "keyboard", action: "type", value: "hello" });
          await hook.result.current.act({ type: "clipboard", operation: "paste" });
        });
        expect(inputRequests).toHaveLength(2);
        for (const request of inputRequests) {
          expect(request).toMatchObject({
            targetId: screenTarget.id,
            expectedTargetGeneration: screenTarget.targetGeneration,
            expectedObservationId: null,
            expectedFrameId: null,
          });
        }
        await actRun(async () => {
          await hook.result.current.selectTarget(windowTarget.id);
        });
        expect(hook.result.current.selectedTarget?.id).toBe(windowTarget.id);
        expect(hook.result.current.observation?.target.id).toBe(windowTarget.id);
        await actRun(async () => {
          settleInitial(observation(screenTarget));
        });
        await flush(5);
        expect(hook.result.current.selectedTarget?.id).toBe(windowTarget.id);
        expect(hook.result.current.observation?.target.id).toBe(windowTarget.id);
        expect(hook.result.current.error).toBeNull();
      } finally {
        settleInitial(observation(screenTarget));
        await hook.unmount();
      }
    },
  );

  test("a disappeared window does not redirect observation or input to another target", async () => {
    const chosen = target("window-1");
    const unrelated = target("window-2");
    let targets = [chosen, unrelated];
    const observed: string[] = [];
    const requests: ComputerActionRequest[] = [];
    const client = fakeClient({
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets,
      }),
      observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) => {
        observed.push(targetId);
        return observation(targets.find((candidate) => candidate.id === targetId)!);
      },
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        requests.push(request);
        return receipt(observation(unrelated), request.operationId);
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
    try {
      await flush(20);
      expect(hook.result.current.selectedTarget?.id).toBe(chosen.id);
      targets = [unrelated];
      for (let i = 0; i < 2; i++) {
        await actRun(() => hook.result.current.refresh());
        expect(hook.result.current.selectedTarget).toBeNull();
        expect(hook.result.current.observation).toBeNull();
      }
      await expect(
        hook.result.current.act({ type: "keyboard", action: "type", value: "fixture" }),
      ).rejects.toThrow();
      expect(requests).toEqual([]);
      expect(observed).toEqual([chosen.id]);
      await actRun(() => hook.result.current.selectTarget(unrelated.id));
      expect(hook.result.current.selectedTarget?.id).toBe(unrelated.id);
      expect(observed).toEqual([chosen.id, unrelated.id]);
    } finally {
      await hook.unmount();
    }
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

    expect(hook.result.current.selectedTarget?.id).toBe(screenTarget.id);
    await actRun(async () => {
      await hook.result.current.selectTarget(windowTarget.id);
    });
    expect(requests).toHaveLength(0);
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
      targetGeneration: screenTarget.targetGeneration,
      sequence: 7,
      mediaType: "image/png",
      width: 1,
      height: 1,
      capturedAt: NOW,
      sha256: PNG_SHA256,
      data: new Uint8Array([1]),
    };
    for (const stale of [
      { targetGeneration: "earlier-generation" },
      { controllerGeneration: "controller-2" },
    ]) {
      await expect(
        hook.result.current.actFromFrame(
          { type: "pointer", frameId: frame.frameId, action: "click", x: 0, y: 0 },
          { ...frame, ...stale },
        ),
      ).rejects.toThrow("earlier target generation");
    }
    expect(requests).toHaveLength(1);
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
      expectedTargetGeneration: screenTarget.targetGeneration,
      expectedObservationId: null,
      expectedFrameId: "visible-frame",
      action: { frameId: "visible-frame" },
    });
    await hook.unmount();
  });

  test.each(["linux", "macos", "windows"] as const)(
    "opens the whole desktop on %s and retains an explicitly selected app view",
    async (platform) => {
      const applicationTarget = { ...target("app-1", "app"), focused: true };
      const windowTarget = target();
      const screenTarget = target("screen-1", "screen");
      const observed: string[] = [];
      const requests: ComputerActionRequest[] = [];
      let targets = [applicationTarget, windowTarget, screenTarget];
      const client = fakeClient({
        getComputerSession: async () => ({
          ...computerSession(),
          platform,
        }),
        listComputerTargets: async () => ({
          computerSessionId: COMPUTER_SESSION_ID,
          controllerGeneration: "controller-1",
          targets,
        }),
        observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) => {
          observed.push(targetId);
          return observation(targets.find((candidate) => candidate.id === targetId)!);
        },
        actInComputer: async (_workspaceId, _computerSessionId, request) => {
          requests.push(request);
          return receipt(observation(applicationTarget), request.operationId);
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

      try {
        expect(hook.result.current.selectedTarget?.id).toBe(screenTarget.id);
        expect(observed).toEqual([screenTarget.id]);
        await actRun(async () => {
          await hook.result.current.selectTarget(applicationTarget.id);
          await hook.result.current.refresh();
        });
        expect(hook.result.current.selectedTarget?.id).toBe(applicationTarget.id);
        expect(requests).toHaveLength(0);
        await actRun(async () => {
          await hook.result.current.act({
            type: "semantic",
            locator: { kind: "ref", ref: "e1" },
            action: "invoke",
          });
        });
        expect(requests[0]).toMatchObject({
          targetId: applicationTarget.id,
          expectedTargetGeneration: applicationTarget.targetGeneration,
          expectedObservationId: `observation-${applicationTarget.targetGeneration}`,
          action: { type: "semantic", action: "invoke" },
        });
        targets = [windowTarget, screenTarget];
        await actRun(() => hook.result.current.refresh());
        expect(hook.result.current.selectedTarget).toBeNull();
        expect(hook.result.current.observation).toBeNull();
        await actRun(() => hook.result.current.selectTarget(screenTarget.id));
        expect(hook.result.current.selectedTarget?.id).toBe(screenTarget.id);
        expect(requests).toHaveLength(1);
      } finally {
        await hook.unmount();
      }
    },
  );
});

describe("ComputerSession receipt selection", () => {
  async function fixture(kind: "screen" | "window" = "screen", cloneTargetRecords = true) {
    const first = target(`${kind}-1`, kind);
    const second = target(`${kind}-2`, kind);
    let targets = [first, second];
    const requests: ComputerActionRequest[] = [];
    let finishFirst!: (value: ComputerActionReceipt) => void;
    let observationSequence = 0;
    const makeClient = (name: string) =>
      fakeClient({
        getComputerSession: async (_workspaceId, computerSessionId) =>
          computerSession(computerSessionId, SESSION_ID, name),
        listComputerTargets: async (_workspaceId, computerSessionId) => ({
          computerSessionId,
          controllerGeneration: targets[0]!.controllerGeneration,
          targets: cloneTargetRecords
            ? targets.map((candidate) => ({ ...candidate, computerSessionId }))
            : targets,
        }),
        observeComputerTarget: async (workspaceId, computerSessionId, targetId) => {
          const current = targets.find((candidate) => candidate.id === targetId)!;
          return {
            ...observation({ ...current, computerSessionId }),
            observationId: `${name}-${workspaceId}-${++observationSequence}`,
          };
        },
        actInComputer: async (_workspaceId, computerSessionId, request) => {
          requests.push(request);
          if (requests.length === 1) {
            return await new Promise<ComputerActionReceipt>((resolve) => {
              finishFirst = resolve;
            });
          }
          const current = targets.find((candidate) => candidate.id === request.targetId)!;
          return receipt(observation({ ...current, computerSessionId }), request.operationId);
        },
      });
    const options = {
      client: makeClient("first-source"),
      workspaceId: WORKSPACE_ID,
      computerSessionId: COMPUTER_SESSION_ID,
      enabled: true,
      pollIntervalMs: 60_000,
    };
    const hook = await renderHook((props: typeof options) => useComputerSession(props), options);
    await flush(20);
    const initialObservation = hook.result.current.observation!;
    const paintedFrame = (current: ComputerTarget, frameId: string): ComputerFrame => ({
      computerSessionId: current.computerSessionId,
      controllerGeneration: current.controllerGeneration,
      targetId: current.id,
      targetGeneration: current.targetGeneration,
      frameId,
      sequence: 1,
      mediaType: "image/png",
      width: 400,
      height: 300,
      capturedAt: NOW,
      sha256: PNG_SHA256,
      data: new Uint8Array([1]),
    });
    return {
      hook,
      options,
      first,
      second,
      requests,
      initialObservation,
      makeClient,
      paintedFrame,
      setTargets: (next: ComputerTarget[]) => {
        targets = next;
      },
      finishFirst: (value: ComputerActionReceipt) => finishFirst(value),
      start: async () => {
        const frame = paintedFrame(first, "painted-first");
        let pending!: Promise<ComputerActionReceipt>;
        await actRun(() => {
          pending = hook.result.current.actFromFrame(
            { type: "pointer", action: "click", frameId: frame.frameId, x: 40, y: 60 },
            frame,
          );
        });
        await flush();
        return { pending };
      },
    };
  }

  test.each(["completed", "failed", "outcome_unknown"] as const)(
    "keeps the newly selected screen after a non-null %s receipt for the previous screen",
    async (state) => {
      const current = await fixture();
      try {
        const { pending } = await current.start();
        await actRun(async () => {
          await current.hook.result.current.selectTarget(current.second.id);
        });
        const selectedObservation = current.hook.result.current.observation!;
        const result = {
          ...receipt(current.initialObservation, current.requests[0]!.operationId),
          state,
          error:
            state === "completed"
              ? null
              : {
                  code: "resource_unavailable" as const,
                  message: "Synthetic delivery failure",
                  retryable: false,
                },
        };
        await actRun(async () => {
          current.finishFirst(result);
          expect(await pending).toEqual(result);
        });
        expect(current.hook.result.current.selectedTarget?.id).toBe(current.second.id);
        expect(current.hook.result.current.observation).toEqual(selectedObservation);
        await actRun(async () => {
          await current.hook.result.current.act({
            type: "keyboard",
            action: "type",
            value: "sample",
          });
        });
        expect(current.requests).toHaveLength(2);
        expect(current.requests[1]).toMatchObject({
          targetId: current.second.id,
          expectedTargetGeneration: current.second.targetGeneration,
          expectedObservationId: selectedObservation.observationId,
        });
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test("keeps the new observation when a person switches away and back to the same window", async () => {
    const current = await fixture("window");
    try {
      const { pending } = await current.start();
      await actRun(async () => {
        await current.hook.result.current.selectTarget(current.second.id);
        await current.hook.result.current.selectTarget(current.first.id);
      });
      const selectedObservation = current.hook.result.current.observation!;
      expect(selectedObservation.observationId).not.toBe(current.initialObservation.observationId);
      await actRun(async () => {
        current.finishFirst(receipt(current.initialObservation, current.requests[0]!.operationId));
        await pending;
        await current.hook.result.current.act({
          type: "semantic",
          action: "invoke",
          locator: { kind: "ref", ref: "e1" },
        });
      });
      expect(current.requests[1]?.expectedObservationId).toBe(selectedObservation.observationId);
    } finally {
      await current.hook.unmount();
    }
  });

  test.each(["targetGeneration", "controllerGeneration"] as const)(
    "keeps the freshly discovered %s after an older receipt",
    async (generation) => {
      const current = await fixture();
      try {
        const { pending } = await current.start();
        const next = { ...current.first, [generation]: "generation-2" };
        current.setTargets([next, current.second]);
        await actRun(async () => {
          await current.hook.result.current.refresh();
        });
        const selectedObservation = current.hook.result.current.observation!;
        await actRun(async () => {
          current.finishFirst(
            receipt(current.initialObservation, current.requests[0]!.operationId),
          );
          await pending;
        });
        expect(current.hook.result.current.selectedTarget).toEqual(next);
        expect(current.hook.result.current.observation).toEqual(selectedObservation);
        await actRun(async () => {
          await current.hook.result.current.act({
            type: "keyboard",
            action: "press",
            value: "Enter",
          });
        });
        expect(current.requests[1]).toMatchObject({
          targetId: next.id,
          expectedTargetGeneration: next.targetGeneration,
          expectedObservationId: selectedObservation.observationId,
        });
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test.each(["client", "workspace", "computer", "disabled", "source round trip"] as const)(
    "does not project a receipt after the %s changes",
    async (boundary) => {
      const current = await fixture();
      try {
        const { pending } = await current.start();
        const staleAction = current.hook.result.current.act;
        const next = {
          ...current.options,
          ...(boundary === "client" || boundary === "source round trip"
            ? { client: current.makeClient("second-source") }
            : {}),
          ...(boundary === "workspace"
            ? { workspaceId: "12345678-1234-4123-8123-123456789abc" }
            : {}),
          ...(boundary === "computer" ? { computerSessionId: PEER_COMPUTER_SESSION_ID } : {}),
          ...(boundary === "disabled" ? { enabled: false } : {}),
        };
        await current.hook.rerender(next);
        await flush(20);
        if (boundary === "source round trip") {
          await current.hook.rerender(current.options);
          await flush(20);
        }
        const selectedObservation = current.hook.result.current.observation;
        const selected = current.hook.result.current.selectedTarget;
        const retainedAction = current.hook.result.current.act;
        await expect(
          staleAction({ type: "keyboard", action: "press", value: "Enter" }),
        ).rejects.toThrow("source is no longer selected");
        expect(current.requests).toHaveLength(1);
        await actRun(async () => {
          current.finishFirst(
            receipt(current.initialObservation, current.requests[0]!.operationId),
          );
          await pending;
        });
        expect(current.hook.result.current.selectedTarget).toEqual(selected);
        expect(current.hook.result.current.observation).toEqual(selectedObservation);
        expect(current.hook.result.current.mutating).toBe(false);
        if (boundary !== "disabled") {
          await actRun(async () => {
            await retainedAction({ type: "keyboard", action: "press", value: "Enter" });
          });
          expect(current.requests[1]?.expectedObservationId).toBe(
            selectedObservation?.observationId,
          );
        }
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test.each(["targetGeneration", "controllerGeneration"] as const)(
    "captures immutable %s when the client reuses target records",
    async (generation) => {
      const current = await fixture("screen", false);
      try {
        const { pending } = await current.start();
        current.first[generation] = "shared-record-generation-2";
        await actRun(async () => {
          await current.hook.result.current.refresh();
        });
        const selectedObservation = current.hook.result.current.observation!;
        await actRun(async () => {
          current.finishFirst(
            receipt(current.initialObservation, current.requests[0]!.operationId),
          );
          await pending;
        });
        expect(current.hook.result.current.selectedTarget?.[generation]).toBe(
          "shared-record-generation-2",
        );
        expect(current.hook.result.current.observation).toEqual(selectedObservation);
        await actRun(async () => {
          await current.hook.result.current.act({
            type: "keyboard",
            action: "press",
            value: "Enter",
          });
        });
        expect(current.requests[1]).toMatchObject({
          expectedTargetGeneration: current.first.targetGeneration,
          expectedObservationId: selectedObservation.observationId,
        });
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test("keeps the new source's control failure after the previous source completes", async () => {
    const current = await fixture();
    try {
      const { pending } = await current.start();
      const unavailable = new OpenGeniApiError(503, "Synthetic source unavailable");
      await current.hook.rerender({
        ...current.options,
        client: fakeClient({
          getComputerSession: async () => {
            throw unavailable;
          },
          listComputerTargets: async () => ({
            computerSessionId: COMPUTER_SESSION_ID,
            controllerGeneration: "controller-1",
            targets: [current.first, current.second],
          }),
        }),
      });
      await flush(20);
      expect(current.hook.result.current.controlError).toBe(unavailable);
      await actRun(async () => {
        current.finishFirst(receipt(current.initialObservation, current.requests[0]!.operationId));
        await pending;
      });
      expect(current.hook.result.current.controlError).toBe(unavailable);
      expect(current.hook.result.current.error).toBe(unavailable);
      expect(current.hook.result.current.mutating).toBe(false);
    } finally {
      await current.hook.unmount();
    }
  });

  test.each([false, true])(
    "projects an explicit focus receipt only without a newer human selection (%s)",
    async (reselected) => {
      const current = await fixture("window");
      try {
        let pending!: Promise<ComputerActionReceipt>;
        await actRun(() => {
          pending = current.hook.result.current.act({ type: "focus", targetId: current.second.id });
        });
        await flush();
        if (reselected) {
          await actRun(async () => {
            await current.hook.result.current.selectTarget(current.first.id);
          });
        }
        const selectedObservation = current.hook.result.current.observation!;
        await actRun(async () => {
          current.finishFirst(
            receipt(observation(current.second), current.requests[0]!.operationId),
          );
          await pending;
        });
        expect(current.hook.result.current.selectedTarget?.id).toBe(
          reselected ? current.first.id : current.second.id,
        );
        if (reselected)
          expect(current.hook.result.current.observation).toEqual(selectedObservation);
        await actRun(async () => {
          await current.hook.result.current.act({
            type: "keyboard",
            action: "press",
            value: "Enter",
          });
        });
        expect(current.requests[1]?.targetId).toBe(
          reselected ? current.first.id : current.second.id,
        );
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test("uses a fresh same-view receipt for immediate semantic and painted-frame actions before rendering", async () => {
    const current = await fixture("window");
    try {
      const { pending } = await current.start();
      const next = { ...current.first, targetGeneration: "next-window-generation" };
      current.setTargets([next, current.second]);
      const freshObservation = observation(next);
      const frame = current.paintedFrame(next, "painted-next");
      await actRun(async () => {
        current.finishFirst(receipt(freshObservation, current.requests[0]!.operationId));
        await pending;
        await current.hook.result.current.act({
          type: "semantic",
          action: "invoke",
          locator: { kind: "ref", ref: "e1" },
        });
        await current.hook.result.current.actFromFrame(
          { type: "pointer", action: "click", frameId: frame.frameId, x: 40, y: 60 },
          frame,
        );
      });
      expect(current.requests).toHaveLength(3);
      expect(current.requests[1]).toMatchObject({
        targetId: next.id,
        expectedTargetGeneration: next.targetGeneration,
        expectedObservationId: freshObservation.observationId,
      });
      expect(current.requests[2]).toMatchObject({
        targetId: next.id,
        expectedTargetGeneration: next.targetGeneration,
        expectedObservationId: null,
        expectedFrameId: frame.frameId,
      });
    } finally {
      await current.hook.unmount();
    }
  });
});

describe("ComputerSession source admission", () => {
  const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
  const semanticInput = {
    type: "semantic",
    locator: { kind: "ref", ref: "e1" },
    action: "invoke",
  } as const;

  test.each(["client", "workspace", "computer", "disabled"] as const)(
    "clears visible Desktop state and rejects current input at %s replacement layout",
    async (boundary) => {
      const currentTarget = target("window-1");
      const previousObservation = observation(currentTarget);
      const requests: ComputerActionRequest[] = [];
      const makeClient = (name: string) => {
        const changed = (workspaceId: string, computerSessionId: string) =>
          name === "new-source" ||
          workspaceId === otherWorkspaceId ||
          computerSessionId !== COMPUTER_SESSION_ID;
        return fakeClient({
          getComputerSession: async (workspaceId, computerSessionId) =>
            changed(workspaceId, computerSessionId)
              ? await new Promise<ComputerSession>(() => {})
              : computerSession(),
          listComputerTargets: async (workspaceId, computerSessionId) =>
            changed(workspaceId, computerSessionId)
              ? await new Promise<{
                  computerSessionId: string;
                  controllerGeneration: string;
                  targets: ComputerTarget[];
                }>(() => {})
              : {
                  computerSessionId,
                  controllerGeneration: "controller-1",
                  targets: [currentTarget],
                },
          observeComputerTarget: async () => previousObservation,
          actInComputer: async (_workspaceId, _computerSessionId, request) => {
            requests.push(request);
            return receipt(previousObservation, request.operationId);
          },
        });
      };
      const client = makeClient("old-source");
      const options = {
        client,
        workspaceId: WORKSPACE_ID,
        computerSessionId: COMPUTER_SESSION_ID,
        enabled: true,
        pollIntervalMs: 60_000,
        phase: "old",
      };
      let layoutSnapshot: unknown;
      let layoutActions!: Promise<(Error | null)[]>;
      let staleAction!: ReturnType<typeof useComputerSession>["act"];
      let staleResult!: Promise<Error | null>;
      let attempted = false;
      const painted: ComputerFrame = {
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targetId: currentTarget.id,
        targetGeneration: currentTarget.targetGeneration,
        frameId: previousObservation.frameId!,
        sequence: 1,
        mediaType: "image/png",
        width: 400,
        height: 300,
        capturedAt: NOW,
        sha256: PNG_SHA256,
        data: new Uint8Array([1]),
      };
      const rendered = await renderHook((props: typeof options) => {
        const result = useComputerSession(props);
        useLayoutEffect(() => {
          if (props.phase !== "new" || attempted) return;
          attempted = true;
          layoutSnapshot = {
            session: result.session,
            targets: result.targets,
            selectedTarget: result.selectedTarget,
            observation: result.observation,
            loading: result.loading,
            mutating: result.mutating,
            error: result.error,
            controlError: result.controlError,
          };
          layoutActions = Promise.all(
            [
              result.act(semanticInput),
              result.act({ type: "keyboard", action: "press", value: "Enter" }),
              result.act({ type: "focus", targetId: currentTarget.id }),
              result.actFromFrame(
                { type: "pointer", action: "click", frameId: painted.frameId, x: 40, y: 60 },
                painted,
              ),
            ].map((pending) =>
              pending.then(
                () => null,
                (error: Error) => error,
              ),
            ),
          );
          staleResult = staleAction(semanticInput).then(
            () => null,
            (error: Error) => error,
          );
        });
        return result;
      }, options);
      try {
        await flush(20);
        expect(rendered.result.current.observation).toEqual(previousObservation);
        staleAction = rendered.result.current.act;
        await rendered.rerenderThroughLayout({
          ...options,
          ...(boundary === "client" ? { client: makeClient("new-source") } : {}),
          ...(boundary === "workspace" ? { workspaceId: otherWorkspaceId } : {}),
          ...(boundary === "computer" ? { computerSessionId: PEER_COMPUTER_SESSION_ID } : {}),
          ...(boundary === "disabled" ? { enabled: false } : {}),
          phase: "new",
        });
        expect(layoutSnapshot).toEqual({
          session: null,
          targets: [],
          selectedTarget: null,
          observation: null,
          loading: boundary !== "disabled",
          mutating: false,
          error: null,
          controlError: null,
        });
        expect((await layoutActions).every((error) => error instanceof Error)).toBe(true);
        expect((await staleResult)?.message).toContain("source is no longer selected");
        expect(requests).toHaveLength(0);
      } finally {
        await rendered.unmount();
      }
    },
  );

  test.each(["client", "workspace"] as const)(
    "does not retain a previous %s observation when new discovery has identical target generations",
    async (boundary) => {
      const currentTarget = target("window-1");
      const initialObservation = {
        ...observation(currentTarget),
        observationId: "old-source-observation",
      };
      const freshObservation = {
        ...observation(currentTarget),
        observationId: "new-source-observation",
      };
      const requests: ComputerActionRequest[] = [];
      let resolveObservation!: (value: ComputerObservation) => void;
      const makeClient = (name: string) =>
        fakeClient({
          getComputerSession: async () => computerSession(),
          listComputerTargets: async () => ({
            computerSessionId: COMPUTER_SESSION_ID,
            controllerGeneration: "controller-1",
            targets: [{ ...currentTarget }],
          }),
          observeComputerTarget: async (workspaceId) => {
            if (name === "new-source" || workspaceId === otherWorkspaceId) {
              return await new Promise<ComputerObservation>((resolve) => {
                resolveObservation = resolve;
              });
            }
            return initialObservation;
          },
          actInComputer: async (_workspaceId, _computerSessionId, request) => {
            requests.push(request);
            return receipt(freshObservation, request.operationId);
          },
        });
      const options = {
        client: makeClient("old-source"),
        workspaceId: WORKSPACE_ID,
        computerSessionId: COMPUTER_SESSION_ID,
        pollIntervalMs: 60_000,
      };
      const rendered = await renderHook(useComputerSession, options);
      try {
        await flush(20);
        expect(rendered.result.current.observation).toEqual(initialObservation);
        await rendered.rerender({
          ...options,
          ...(boundary === "client" ? { client: makeClient("new-source") } : {}),
          ...(boundary === "workspace" ? { workspaceId: otherWorkspaceId } : {}),
        });
        await flush(20);
        expect(rendered.result.current.selectedTarget).toEqual(currentTarget);
        expect(rendered.result.current.observation).toBeNull();
        await expect(rendered.result.current.act(semanticInput)).rejects.toThrow(
          "not ready for input",
        );
        expect(requests).toHaveLength(0);
        await actRun(() => resolveObservation(freshObservation));
        await actRun(async () => {
          await rendered.result.current.act(semanticInput);
        });
        expect(requests[0]).toMatchObject({
          targetId: currentTarget.id,
          expectedTargetGeneration: currentTarget.targetGeneration,
          expectedObservationId: freshObservation.observationId,
        });
      } finally {
        await rendered.unmount();
      }
    },
  );

  test("retains exact observation authority during a same-source refresh with pending inspection", async () => {
    const first = target("window-1");
    const second = target("window-2");
    const requests: ComputerActionRequest[] = [];
    let observations = 0;
    let resolveRefresh!: (value: ComputerObservation) => void;
    const freshReceiptObservation = { ...observation(second), observationId: "action-observation" };
    const client = fakeClient({
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [{ ...first }, { ...second }],
      }),
      observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) => {
        observations++;
        if (observations === 3) {
          return await new Promise<ComputerObservation>((resolve) => {
            resolveRefresh = resolve;
          });
        }
        return {
          ...observation(targetId === first.id ? first : second),
          observationId: `selected-observation-${observations}`,
        };
      },
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        requests.push(request);
        return receipt(freshReceiptObservation, request.operationId);
      },
    });
    const rendered = await renderHook(useComputerSession, {
      client,
      workspaceId: WORKSPACE_ID,
      computerSessionId: COMPUTER_SESSION_ID,
      pollIntervalMs: 60_000,
    });
    try {
      await flush(20);
      await actRun(async () => {
        await rendered.result.current.selectTarget(second.id);
      });
      const selected = rendered.result.current.observation!;
      let refreshing!: Promise<void>;
      await actRun(() => {
        refreshing = rendered.result.current.refresh();
      });
      expect(rendered.result.current.selectedTarget?.id).toBe(second.id);
      expect(rendered.result.current.observation).toEqual(selected);
      await actRun(async () => {
        await rendered.result.current.act(semanticInput);
      });
      expect(requests[0]).toMatchObject({
        targetId: second.id,
        expectedTargetGeneration: second.targetGeneration,
        expectedObservationId: selected.observationId,
      });
      await actRun(async () => {
        resolveRefresh(observation(first));
        await refreshing;
      });
      expect(rendered.result.current.selectedTarget?.id).toBe(second.id);
      expect(rendered.result.current.observation).toEqual(freshReceiptObservation);
    } finally {
      await rendered.unmount();
    }
  });
});

describe("ComputerSession selection and refresh read ordering", () => {
  async function fixture() {
    const selectedTarget = target("window-a");
    const view = (sequence: number): ComputerObservation => ({
      ...observation(selectedTarget),
      observationId: "read-observation-" + sequence,
      frameId: "read-frame-" + sequence,
    });
    const choices: Array<{
      resolve: (value: ComputerObservation) => void;
      reject: (cause: unknown) => void;
    }> = [];
    const reads: Array<{ resolve: (value: ComputerObservation) => void }> = [];
    const actions: Array<{ resolve: (value: ComputerActionReceipt) => void }> = [];
    const requests: ComputerActionRequest[] = [];
    let sequence = 0;
    let holdSelection = false;
    let holdObservation = false;
    let holdAction = false;
    let nullAction = false;
    let actionError: Error | null = null;
    let inventoryReads = 0;
    let selectionCalls = 0;
    const choose = async (): Promise<ComputerObservation> => {
      selectionCalls++;
      if (!holdSelection) return view(sequence);
      holdSelection = false;
      return await new Promise<ComputerObservation>((resolve, reject) => {
        choices.push({ resolve, reject });
      });
    };
    const read = async (): Promise<ComputerObservation> => {
      if (!holdObservation) return view(sequence);
      return await new Promise<ComputerObservation>((resolve) => {
        reads.push({ resolve });
      });
    };
    const client = fakeClient({
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => {
        inventoryReads++;
        return {
          computerSessionId: COMPUTER_SESSION_ID,
          controllerGeneration: "controller-1",
          targets: [selectedTarget],
        };
      },
      observeComputerTarget: async (_workspace, _computer, _target, options) =>
        options?.signal ? await read() : await choose(),

      actInComputer: async (_workspace, _session, request) => {
        requests.push(request);
        if (holdAction)
          return await new Promise<ComputerActionReceipt>((resolve) => {
            actions.push({ resolve });
          });
        if (actionError) throw actionError;
        return {
          ...receipt(view(sequence), request.operationId),
          observation: nullAction ? null : view(sequence),
        };
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
    await flush();
    return {
      hook,
      selectedTarget,
      view,
      choices,
      reads,
      actions,
      requests,
      sequence: (value: number) => {
        sequence = value;
      },
      holdSelection: () => {
        holdSelection = true;
      },
      holdObservation: () => {
        holdObservation = true;
      },
      holdAction: () => {
        holdAction = true;
      },
      nullAction: () => {
        nullAction = true;
      },
      actionError: (value: Error) => {
        actionError = value;
      },
      inventoryReads: () => inventoryReads,
      selectionCalls: () => selectionCalls,
    };
  }
  const input = {
    type: "semantic",
    action: "invoke",
    locator: { kind: "ref", ref: "e1" },
  } as const;

  test.each(["observation", "error"] as const)(
    "an older selection %s cannot overwrite a newer same-view refresh or next input fence",
    async (delivery) => {
      const current = await fixture();
      try {
        current.holdSelection();
        let selected!: Promise<ComputerTarget>;
        await actRun(() => {
          selected = current.hook.result.current.selectTarget(current.selectedTarget.id);
        });
        const failure = new OpenGeniApiError(503, "Synthetic obsolete selection failure");
        const outcome = selected.catch((cause: unknown) => cause);
        current.sequence(2);
        await actRun(() => current.hook.result.current.refresh());
        expect(current.hook.result.current.observation?.observationId).toBe("read-observation-2");
        await actRun(async () => {
          if (delivery === "error") {
            current.choices[0]!.reject(failure);
            expect(await outcome).toBe(failure);
          } else {
            current.choices[0]!.resolve(current.view(1));
            await outcome;
          }
        });
        expect(current.hook.result.current.observation?.observationId).toBe("read-observation-2");
        expect(current.hook.result.current.error).toBeNull();
        expect(current.hook.result.current.controlError).toBeNull();
        await actRun(() => current.hook.result.current.act(input));
        expect(current.requests[0]?.expectedObservationId).toBe("read-observation-2");
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test("a newer selection keeps its observation after an older refresh read resolves", async () => {
    const current = await fixture();
    try {
      current.holdObservation();
      let refreshing!: Promise<void>;
      await actRun(() => {
        refreshing = current.hook.result.current.refresh();
      });
      await flush();
      expect(current.reads).toHaveLength(1);
      current.sequence(2);
      await actRun(() => current.hook.result.current.selectTarget(current.selectedTarget.id));
      await actRun(async () => {
        current.reads[0]!.resolve(current.view(1));
        await refreshing;
      });
      expect(current.hook.result.current.observation?.observationId).toBe("read-observation-2");
      await actRun(() => current.hook.result.current.act(input));
      expect(current.requests[0]?.expectedObservationId).toBe("read-observation-2");
    } finally {
      await current.hook.unmount();
    }
  });

  test.each(["null observation", "error"] as const)(
    "an admitted selection remains coherent after immediate input returns %s before rendering",
    async (delivery) => {
      const current = await fixture();
      try {
        current.holdSelection();
        let selected!: Promise<ComputerTarget>;
        await actRun(() => {
          selected = current.hook.result.current.selectTarget(current.selectedTarget.id);
        });
        const failure = new OpenGeniApiError(503, "Synthetic current action failure");
        current.sequence(2);
        if (delivery === "error") current.actionError(failure);
        else {
          current.nullAction();
          current.holdObservation();
        }
        await actRun(async () => {
          current.choices[0]!.resolve(current.view(2));
          await selected;
          const outcome = current.hook.result.current.act(input).catch((cause: unknown) => cause);
          if (delivery === "error") expect(await outcome).toBe(failure);
          else expect(((await outcome) as ComputerActionReceipt).state).toBe("completed");
        });
        expect(current.requests).toHaveLength(1);
        expect(current.requests[0]?.expectedObservationId).toBe("read-observation-2");
        expect(current.hook.result.current.observation?.observationId).toBe("read-observation-2");
        expect(current.hook.result.current.error).toBe(delivery === "error" ? failure : null);
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test.each(["completed", "outcome_unknown"] as const)(
    "a same-view refresh cannot discard a pending physical %s action outcome",
    async (state) => {
      const current = await fixture();
      try {
        current.holdAction();
        let pending!: Promise<ComputerActionReceipt>;
        await actRun(() => {
          pending = current.hook.result.current.act({
            type: "keyboard",
            action: "press",
            value: "Enter",
          });
        });
        current.sequence(2);
        await actRun(() => current.hook.result.current.refresh());
        expect(current.hook.result.current.observation?.observationId).toBe("read-observation-2");
        const result: ComputerActionReceipt = {
          ...receipt(current.view(3), current.requests[0]!.operationId),
          state,
          error:
            state === "outcome_unknown"
              ? {
                  code: "resource_unavailable",
                  message: "Synthetic uncertain delivery",
                  retryable: false,
                }
              : null,
        };
        await actRun(async () => {
          current.actions[0]!.resolve(result);
          expect(await pending).toEqual(result);
        });
        expect(current.hook.result.current.observation?.observationId).toBe("read-observation-3");
        expect(current.requests).toHaveLength(1);
      } finally {
        await current.hook.unmount();
      }
    },
  );
});

describe("ComputerSession selection invocation ordering", () => {
  async function fixture() {
    const firstTarget = target("window-a");
    const secondTarget = target("window-b");
    const view = (current: ComputerTarget, sequence: number): ComputerObservation => ({
      ...observation(current),
      observationId: "selection-observation-" + sequence,
      frameId: "selection-frame-" + sequence,
    });
    const choices: Array<{
      resolve: (value: ComputerObservation) => void;
      reject: (cause: unknown) => void;
    }> = [];
    const selected: string[] = [];
    const requests: ComputerActionRequest[] = [];
    let choosing = false;
    const client = fakeClient({
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [firstTarget, secondTarget],
      }),
      observeComputerTarget: async (_workspace, _computer, targetId) => {
        if (!choosing) return view(firstTarget, 0);
        selected.push(targetId);
        return await new Promise<ComputerObservation>((resolve, reject) => {
          choices.push({ resolve, reject });
        });
      },
      actInComputer: async (_workspace, _computer, request) => {
        requests.push(request);
        return receipt(view(firstTarget, 3), request.operationId);
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
    await flush();
    choosing = true;
    let first!: Promise<ComputerTarget>;
    let second!: Promise<ComputerTarget>;
    let third!: Promise<ComputerTarget>;
    await actRun(() => {
      first = hook.result.current.selectTarget(firstTarget.id);
    });
    await actRun(() => {
      second = hook.result.current.selectTarget(secondTarget.id);
    });
    await actRun(() => {
      third = hook.result.current.selectTarget(firstTarget.id);
    });
    return {
      hook,
      firstTarget,
      secondTarget,
      view,
      choices,
      selected,
      requests,
      first,
      second,
      third,
    };
  }

  const input = {
    type: "semantic",
    action: "invoke",
    locator: { kind: "ref", ref: "e1" },
  } as const;

  test("late A and B selections cannot replace a newer A observation or immediate semantic fence", async () => {
    const current = await fixture();
    try {
      expect(current.selected).toEqual([
        current.firstTarget.id,
        current.secondTarget.id,
        current.firstTarget.id,
      ]);
      await actRun(async () => {
        current.choices[2]!.resolve(current.view(current.firstTarget, 3));
        await current.third;
        await current.hook.result.current.act(input);
      });
      expect(current.requests[0]?.expectedObservationId).toBe("selection-observation-3");
      await actRun(async () => {
        current.choices[1]!.resolve(current.view(current.secondTarget, 2));
        expect(await current.second).toEqual(current.secondTarget);
      });
      expect(current.hook.result.current.selectedTarget?.id).toBe(current.firstTarget.id);
      await actRun(async () => {
        current.choices[0]!.resolve(current.view(current.firstTarget, 1));
        expect(await current.first).toEqual(current.firstTarget);
      });
      expect(current.hook.result.current.observation?.observationId).toBe(
        "selection-observation-3",
      );
      await actRun(() => current.hook.result.current.act(input));
      expect(current.requests[1]?.expectedObservationId).toBe("selection-observation-3");
    } finally {
      await current.hook.unmount();
    }
  });

  test.each([0, 1])(
    "an obsolete selection error %s cannot replace the current successful posture",
    async (index) => {
      const current = await fixture();
      const failure = new OpenGeniApiError(503, "Synthetic obsolete selection failure");
      const pending = [current.first, current.second];
      const failed = pending[index]!.catch((cause: unknown) => cause);
      try {
        await actRun(async () => {
          current.choices[2]!.resolve(current.view(current.firstTarget, 3));
          await current.third;
          current.choices[index]!.reject(failure);
          expect(await failed).toBe(failure);
          const other = 1 - index;
          current.choices[other]!.resolve(
            current.view(other === 0 ? current.firstTarget : current.secondTarget, 1),
          );
          await pending[other];
        });
        expect(current.hook.result.current.error).toBeNull();
        expect(current.hook.result.current.controlError).toBeNull();
        expect(current.hook.result.current.observation?.observationId).toBe(
          "selection-observation-3",
        );
        await actRun(() => current.hook.result.current.act(input));
        expect(current.requests[0]?.expectedObservationId).toBe("selection-observation-3");
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test("older observations cannot clear the newest selection failure", async () => {
    const current = await fixture();
    const failure = new OpenGeniApiError(503, "Synthetic current selection failure");
    const failed = current.third.catch((cause: unknown) => cause);
    try {
      await actRun(async () => {
        current.choices[2]!.reject(failure);
        expect(await failed).toBe(failure);
      });
      const currentControlError = current.hook.result.current.controlError;
      await actRun(async () => {
        current.choices[1]!.resolve(current.view(current.secondTarget, 2));
        await current.second;
        current.choices[0]!.resolve(current.view(current.firstTarget, 1));
        await current.first;
      });
      expect(current.hook.result.current.error).toBe(failure);
      expect(current.hook.result.current.controlError).toBe(currentControlError);
      expect(current.hook.result.current.observation).toBeNull();
    } finally {
      await current.hook.unmount();
    }
  });

  test("an older same-ID observation cannot enter while the latest selection is pending", async () => {
    const current = await fixture();
    try {
      await actRun(async () => {
        current.choices[0]!.resolve(current.view(current.firstTarget, 1));
        await current.first;
      });
      expect(current.hook.result.current.observation).toBeNull();
      expect(current.hook.result.current.loading).toBe(true);
      await expect(current.hook.result.current.act(input)).rejects.toThrow(/not ready/);
      expect(current.requests).toHaveLength(0);
      await actRun(async () => {
        current.choices[2]!.resolve(current.view(current.firstTarget, 3));
        await current.third;
        current.choices[1]!.resolve(current.view(current.secondTarget, 2));
        await current.second;
      });
      expect(current.hook.result.current.observation?.observationId).toBe(
        "selection-observation-3",
      );
    } finally {
      await current.hook.unmount();
    }
  });
});

describe("ComputerSession action result ordering", () => {
  async function fixture() {
    const windowTarget = target("window-1");
    const view = (sequence: number): ComputerObservation => ({
      ...observation({ ...windowTarget }),
      observationId: `ordered-observation-${sequence}`,
      frameId: `ordered-frame-${sequence}`,
    });
    const requests: ComputerActionRequest[] = [];
    const deliveries: Array<{
      resolve: (value: ComputerActionReceipt) => void;
      reject: (cause: unknown) => void;
    }> = [];
    let reads = 0;
    let holdRead = false;
    let readSignal: AbortSignal | undefined;
    let finishRead!: (value: ComputerObservation) => void;
    const client = fakeClient({
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [{ ...windowTarget }],
      }),
      observeComputerTarget: async (_workspace, _computer, _target, options) => {
        reads++;
        if (holdRead) {
          readSignal = options?.signal;
          return await new Promise<ComputerObservation>((resolve) => {
            finishRead = resolve;
          });
        }
        return view(0);
      },
      actInComputer: async (_workspace, _computer, request) => {
        requests.push(request);
        if (requests.length <= 2) {
          return await new Promise<ComputerActionReceipt>((resolve, reject) => {
            deliveries.push({ resolve, reject });
          });
        }
        return receipt(view(requests.length), request.operationId);
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
    await flush();
    let first!: Promise<ComputerActionReceipt>;
    let second!: Promise<ComputerActionReceipt>;
    await actRun(() => {
      first = hook.result.current.act({ type: "keyboard", action: "press", value: "ArrowRight" });
      second = hook.result.current.act({ type: "keyboard", action: "press", value: "ArrowRight" });
    });
    const result = (
      index: number,
      sequence: number,
      state: ComputerActionReceipt["state"] = "completed",
      withObservation = true,
    ): ComputerActionReceipt => ({
      ...receipt(view(sequence), requests[index]!.operationId),
      state,
      observation: withObservation ? view(sequence) : null,
      dispatchedAt: state === "prepared" ? null : NOW,
      settledAt: state === "prepared" || state === "dispatched" ? null : NOW,
      error:
        state === "failed" || state === "outcome_unknown"
          ? { code: "resource_unavailable", message: "Synthetic action failure", retryable: false }
          : null,
    });
    return {
      hook,
      requests,
      deliveries,
      first,
      second,
      result,
      reads: () => reads,
      holdRead: () => {
        holdRead = true;
      },
      readSignal: () => readSignal,
      finishRead: (sequence: number) => finishRead(view(sequence)),
    };
  }

  test.each(["completed", "failed", "outcome_unknown"] as const)(
    "a late first %s receipt cannot regress the second settled observation or semantic fence",
    async (state) => {
      const current = await fixture();
      try {
        await actRun(async () => {
          current.deliveries[1]!.resolve(current.result(1, 2));
          await current.second;
        });
        const old = current.result(0, 1, state);
        await actRun(async () => {
          current.deliveries[0]!.resolve(old);
          expect(await current.first).toEqual(old);
          await current.hook.result.current.act({
            type: "semantic",
            action: "invoke",
            locator: { kind: "ref", ref: "e1" },
          });
        });
        expect(current.requests).toHaveLength(3);
        expect(current.requests[2]?.expectedObservationId).toBe("ordered-observation-2");
        expect(current.hook.result.current.observation?.observationId).toBe(
          "ordered-observation-3",
        );
        expect(current.hook.result.current.controlError).toBeNull();
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test.each(["before", "after"] as const)(
    "an earlier transport failure delivered %s newer success cannot replace its cleared posture",
    async (delivery) => {
      const current = await fixture();
      const failure = new OpenGeniApiError(503, "Synthetic earlier delivery failure");
      const firstOutcome = current.first.catch((cause: unknown) => cause);
      try {
        await actRun(async () => {
          if (delivery === "before") {
            current.deliveries[0]!.reject(failure);
            expect(await firstOutcome).toBe(failure);
          }
          current.deliveries[1]!.resolve(current.result(1, 2));
          await current.second;
          if (delivery === "after") {
            current.deliveries[0]!.reject(failure);
            expect(await firstOutcome).toBe(failure);
          }
        });
        expect(current.hook.result.current.error).toBeNull();
        expect(current.hook.result.current.controlError).toBeNull();
        expect(current.hook.result.current.observation?.observationId).toBe(
          "ordered-observation-2",
        );
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test.each([false, true])(
    "a late first receipt cannot clear a newer unavailable-control error (observation %s)",
    async (withObservation) => {
      const current = await fixture();
      const failure = new OpenGeniApiError(503, "Synthetic current control unavailable");
      const secondOutcome = current.second.catch((cause: unknown) => cause);
      try {
        await actRun(async () => {
          current.deliveries[1]!.reject(failure);
          expect(await secondOutcome).toBe(failure);
          current.deliveries[0]!.resolve(current.result(0, 1, "completed", withObservation));
          await current.first;
        });
        expect(current.hook.result.current.error).toBe(failure);
        expect(current.hook.result.current.controlError).toBe(failure);
        expect(current.hook.result.current.observation?.observationId).toBe(
          "ordered-observation-0",
        );
        expect(current.reads()).toBe(1);
      } finally {
        await current.hook.unmount();
      }
    },
  );

  test("a first receipt supplies sequential semantic input while a later action is still pending", async () => {
    const current = await fixture();
    try {
      await actRun(async () => {
        current.deliveries[0]!.resolve(current.result(0, 1));
        await current.first;
        await current.hook.result.current.act({
          type: "semantic",
          action: "invoke",
          locator: { kind: "ref", ref: "e1" },
        });
        current.deliveries[1]!.resolve(current.result(1, 2));
        await current.second;
      });
      expect(current.requests[2]?.expectedObservationId).toBe("ordered-observation-1");
      expect(current.hook.result.current.observation?.observationId).toBe("ordered-observation-3");
    } finally {
      await current.hook.unmount();
    }
  });

  test("a refresh started by the first null receipt cannot regress a later action observation", async () => {
    const current = await fixture();
    try {
      current.holdRead();
      await actRun(async () => {
        current.deliveries[0]!.resolve(current.result(0, 1, "completed", false));
        await current.first;
      });
      await flush();
      expect(current.reads()).toBe(2);
      expect(current.readSignal()?.aborted).toBe(false);
      await actRun(async () => {
        current.deliveries[1]!.resolve(current.result(1, 2));
        await current.second;
      });
      expect(current.readSignal()?.aborted).toBe(true);
      await actRun(() => current.finishRead(1));
      await flush();
      expect(current.hook.result.current.observation?.observationId).toBe("ordered-observation-2");
      await actRun(() =>
        current.hook.result.current.act({
          type: "semantic",
          action: "invoke",
          locator: { kind: "ref", ref: "e1" },
        }),
      );
      expect(current.requests[2]?.expectedObservationId).toBe("ordered-observation-2");
    } finally {
      await current.hook.unmount();
    }
  });

  test.each(["prepared", "dispatched"] as const)(
    "an unfinished second %s receipt does not suppress or refresh over the first completion",
    async (state) => {
      const current = await fixture();
      try {
        await actRun(async () => {
          current.deliveries[1]!.resolve(current.result(1, 2, state, false));
          expect((await current.second).state).toBe(state);
          current.deliveries[0]!.resolve(current.result(0, 1));
          await current.first;
        });
        expect(current.hook.result.current.observation?.observationId).toBe(
          "ordered-observation-1",
        );
        expect(current.reads()).toBe(1);
      } finally {
        await current.hook.unmount();
      }
    },
  );
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

  test("accepts restarted frame sequences after attachment renewal", async () => {
    const sockets: FakeComputerSocket[] = [];
    let attaches = 0;
    const client = fakeClient({
      attachComputerSession: async () => ({
        ...attachment("window-1"),
        expiresAt: new Date(Date.now() + (++attaches === 1 ? 2_000 : 120_000)).toISOString(),
      }),
    });
    const hook = await renderHook(
      () =>
        useComputerFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          targetId: "window-1",
          webSocketFactory: (url, protocols) => {
            const socket = new FakeComputerSocket(url, protocols);
            sockets.push(socket);
            return socket as unknown as ComputerFrameWebSocket;
          },
        }),
      undefined,
    );
    try {
      await dispatch(sockets[0]!, "open");
      await dispatch(sockets[0]!, "message", { data: frameMessage("window-1", 100).buffer });
      await flush(10);
      expect(hook.result.current.frame?.sequence).toBe(100);
      await flush(1_100);
      expect(sockets).toHaveLength(2);
      await dispatch(sockets[1]!, "open");
      await dispatch(sockets[1]!, "message", { data: frameMessage("window-1", 2).buffer });
      await dispatch(sockets[1]!, "message", { data: frameMessage("window-1", 1).buffer });
      await dispatch(sockets[0]!, "message", { data: frameMessage("window-1", 101).buffer });
      await flush(10);
      expect(hook.result.current.state).toBe("live");
      expect(hook.result.current.frame?.sequence).toBe(2);
    } finally {
      await hook.unmount();
    }
  });

  test("exposes an error after sockets exhaust the bounded reconnect attempts", async () => {
    const sockets: FakeComputerSocket[] = [];
    const client = fakeClient({
      attachComputerSession: async () => ({
        ...relayAttachment("window-1"),
        expiresAt: new Date(Date.now() + 2_000).toISOString(),
      }),
    });
    const hook = await renderHook(
      () =>
        useComputerFrameStream({
          client,
          workspaceId: WORKSPACE_ID,
          computerSessionId: COMPUTER_SESSION_ID,
          targetId: "window-1",
          webSocketFactory: (url, protocols) => {
            const socket = new FakeComputerSocket(url, protocols);
            sockets.push(socket);
            return socket as unknown as ComputerFrameWebSocket;
          },
        }),
      undefined,
    );
    try {
      await flush(10);
      for (const [index, delay] of [300, 550, 10].entries()) {
        await dispatch(sockets[index]!, "open");
        await dispatch(sockets[index]!, "close");
        await flush(delay);
      }
      expect(sockets).toHaveLength(3);
      expect(hook.result.current.state).toBe("error");
      expect(hook.result.current.error?.message).toBe("Desktop view lost connection.");
      await flush(550);
      expect(sockets).toHaveLength(3);
    } finally {
      await hook.unmount();
    }
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
  test("dismisses both desktop menus after target discovery before dock shortcuts", async () => {
    const screenTarget = target("screen-1", "screen");
    const windowTarget = target();
    let discover!: () => void;
    const discovered = new Promise<void>((resolve) => {
      discover = resolve;
    });
    const requests: ComputerActionRequest[] = [];
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => {
        await discovered;
        return {
          computerSessionId: COMPUTER_SESSION_ID,
          controllerGeneration: "controller-1",
          targets: [screenTarget, windowTarget],
        };
      },
      observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) =>
        observation(targetId === screenTarget.id ? screenTarget : windowTarget),
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        attachment(request.targetId),
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        requests.push(request);
        return receipt(observation(screenTarget), request.operationId);
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
    let dockEscapes = 0;
    const dock = (event: Event) => {
      if ((event as KeyboardEvent).key === "Escape") dockEscapes += 1;
    };
    document.addEventListener("keydown", dock);
    try {
      await flush(40);
      expect(
        rendered.container.querySelector("summary[aria-label='Advanced desktop views']"),
      ).toBeNull();
      await actRun(discover);
      await flush(20);
      const menus = [...rendered.container.querySelectorAll<HTMLDetailsElement>("details")];
      expect(menus).toHaveLength(2);
      for (const menu of menus) {
        const trigger = menu.querySelector("summary")!;
        const inside = menu.querySelector("button")!;
        menu.open = true;
        inside.focus();
        inside.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
        expect(menu.open).toBe(true);
        const escape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        inside.dispatchEvent(escape);
        expect(menu.open).toBe(false);
        expect(document.activeElement === trigger).toBe(true);
        expect(escape.defaultPrevented).toBe(true);
        expect(dockEscapes).toBe(0);
        menu.open = true;
        const outside = new Event("pointerdown", {
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        document.body.dispatchEvent(outside);
        expect(menu.open).toBe(false);
        expect(outside.defaultPrevented).toBe(false);
      }
      menus[0]!
        .querySelector("summary")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(dockEscapes).toBe(1);
      expect(requests).toEqual([]);
    } finally {
      discover();
      document.removeEventListener("keydown", dock);
      await rendered.unmount();
    }
  });

  test("returns desktop menu focus after keyboard actions without stealing pointer focus", async () => {
    const fixture = await renderComputerInputFixture();
    try {
      const menu = fixture.rendered.container.querySelector<HTMLDetailsElement>("details")!;
      const trigger = menu.querySelector("summary")!;
      for (const label of ["Agent computer", "Follow agent"]) {
        menu.open = true;
        const action = [...menu.querySelectorAll("button")].find((button) =>
          button.textContent?.startsWith(label),
        )!;
        action.focus();
        await actRun(() => action.click());
        expect(menu.open).toBe(false);
        expect(document.activeElement === trigger).toBe(true);
      }
      menu.open = true;
      const choice = menu.querySelector("button")!;
      choice.focus();
      await actRun(() =>
        choice.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })),
      );
      expect(menu.open).toBe(false);
      expect(document.activeElement === trigger).toBe(false);
      expect(fixture.actions).toEqual([]);
    } finally {
      await fixture.rendered.unmount();
    }
  });

  test("keeps a single desktop uncluttered and puts app/window views under Advanced", async () => {
    const screenTarget = target("screen-1", "screen");
    const windowTarget = target();
    const appTarget = { ...target("app-1", "app"), title: "Example app" };
    const targets = [windowTarget, appTarget, screenTarget];
    const observed: string[] = [];
    const attachments: string[] = [];
    const requests: ComputerActionRequest[] = [];
    const client = fakeClient({
      getComputerInputPosture: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        inputAllowed: true,
      }),
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      getComputerSession: async () => ({ ...computerSession(), platform: "macos" }),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets,
      }),
      observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) => {
        observed.push(targetId);
        return observation(targets.find((candidate) => candidate.id === targetId)!);
      },
      attachComputerSession: async (_workspaceId, _computerSessionId, request) => {
        attachments.push(request.targetId);
        return attachment(request.targetId);
      },
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        requests.push(request);
        return receipt(observation(appTarget), request.operationId);
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
    try {
      await flush(40);
      expect(observed).toEqual([screenTarget.id]);
      expect(attachments).toEqual([screenTarget.id]);
      expect(rendered.container.querySelector("[aria-label='Desktop views']")).toBeNull();
      expect(rendered.container.querySelector("select[aria-label='Screen']")).toBeNull();
      expect(rendered.container.textContent).not.toContain("Controls 0");
      const advanced = rendered.container.querySelector<HTMLElement>(
        "summary[aria-label='Advanced desktop views']",
      )!;
      const menu = advanced.parentElement as HTMLDetailsElement;
      expect(menu.open).toBe(false);
      const views = [...menu.querySelectorAll<HTMLButtonElement>("button")];
      expect(views.map((button) => button.textContent)).toEqual([
        "Test windowWindow view",
        "Example appApp controls",
      ]);
      await actRun(() => {
        menu.open = true;
        views[0]!.click();
      });
      await flush(20);
      expect(menu.open).toBe(false);
      expect(observed.at(-1)).toBe(windowTarget.id);
      expect(attachments.at(-1)).toBe(windowTarget.id);
      expect(requests).toHaveLength(0);
      await actRun(() => {
        menu.open = true;
        views[1]!.click();
      });
      await flush(20);
      expect(menu.open).toBe(false);
      expect(observed.at(-1)).toBe(appTarget.id);
      expect(attachments).toEqual([screenTarget.id, windowTarget.id]);
      expect(rendered.container.textContent).toContain("App · controls work in the background");
      expect(rendered.container.textContent).not.toContain("Waiting for desktop");
      expect(
        rendered.container.querySelector<HTMLTextAreaElement>(
          "textarea[aria-label='Desktop keyboard input']",
        )?.disabled,
      ).toBe(true);
      const run = [...rendered.container.querySelectorAll<HTMLButtonElement>("aside button")].find(
        (button) => button.textContent?.includes("Run checks"),
      )!;
      await actRun(() => run.click());
      expect(requests[0]).toMatchObject({
        targetId: appTarget.id,
        expectedTargetGeneration: appTarget.targetGeneration,
        action: { type: "semantic", action: "invoke" },
      });
      await actRun(() =>
        [...rendered.container.querySelectorAll<HTMLButtonElement>("button")]
          .find((button) => button.textContent?.includes("Full desktop"))!
          .click(),
      );
      await flush(20);
      expect(observed.at(-1)).toBe(screenTarget.id);
      expect(rendered.container.querySelector("aside")).toBeNull();
      expect(requests).toHaveLength(1);
    } finally {
      await rendered.unmount();
    }
  });

  test("resets app controls when its view disappears and preserves a toggle on same-view refresh", async () => {
    const screenTarget = target("screen-1", "screen");
    const appTarget = { ...target("app-1", "app"), title: "Example app" };
    let targets = [screenTarget, appTarget];
    const requests: ComputerActionRequest[] = [];
    const attachments: string[] = [];
    const client = fakeClient({
      getComputerInputPosture: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        inputAllowed: true,
      }),
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets,
      }),
      observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) =>
        observation(targets.find((candidate) => candidate.id === targetId)!),
      attachComputerSession: async (_workspaceId, _computerSessionId, request) => {
        attachments.push(request.targetId);
        return attachment(request.targetId);
      },
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        requests.push(request);
        return receipt(observation(appTarget), request.operationId);
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
    const refresh = () =>
      rendered.container
        .querySelector<HTMLButtonElement>("button[aria-label='Refresh desktops']")!
        .click();
    const toggle = () =>
      [...rendered.container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Controls 1")!
        .click();
    try {
      await flush(40);
      await actRun(() => {
        const menu = rendered.container.querySelector(
          "summary[aria-label='Advanced desktop views']",
        )!.parentElement as HTMLDetailsElement;
        menu.open = true;
        menu.querySelector<HTMLButtonElement>("button")!.click();
      });
      await flush(20);
      expect(rendered.container.querySelector("aside")).not.toBeNull();
      await actRun(toggle);
      expect(rendered.container.querySelector("aside")).toBeNull();
      await actRun(refresh);
      await flush(20);
      expect(rendered.container.querySelector("aside")).toBeNull();
      expect(rendered.container.textContent).toContain("App · controls work in the background");
      await actRun(toggle);
      expect(rendered.container.querySelector("aside")).not.toBeNull();
      targets = [screenTarget];
      await actRun(refresh);
      await flush(20);
      expect(attachments.at(-1)).toBe(screenTarget.id);
      expect(rendered.container.querySelector("aside")).toBeNull();
      expect(rendered.container.textContent).not.toContain("Controls 0");
      expect(
        rendered.container.querySelector("summary[aria-label='Advanced desktop views']"),
      ).toBeNull();
      expect(requests).toHaveLength(0);
    } finally {
      await rendered.unmount();
    }
  });

  test("switches whole screens with the display target's existing frame and coordinate fence", async () => {
    const canvasMock = mockComputerCanvas();
    const screens = [
      { ...target("screen-1", "screen"), title: "Main display", focused: true },
      {
        ...target("screen-2", "screen"),
        title: "Second display",
        bounds: { x: -1_600, y: -300, width: 1_600, height: 900 },
      },
    ];
    const requests: ComputerActionRequest[] = [];
    const attachments: string[] = [];
    const sockets: FakeComputerSocket[] = [];
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [target(), ...screens],
      }),
      observeComputerTarget: async (_workspaceId, _computerSessionId, targetId) =>
        observation(screens.find((screen) => screen.id === targetId)!),
      attachComputerSession: async (_workspaceId, _computerSessionId, request) => {
        attachments.push(request.targetId);
        return attachment(request.targetId);
      },
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        requests.push(request);
        return { ...receipt(observation(screens[1]!), request.operationId), observation: null };
      },
    });
    const rendered = await renderComponent(
      <ComputerViewer
        client={client}
        workspaceId={WORKSPACE_ID}
        sessionId={SESSION_ID}
        webSocketFactory={(url, protocols) => {
          const socket = new FakeComputerSocket(url, protocols);
          sockets.push(socket);
          return socket as unknown as ComputerFrameWebSocket;
        }}
      />,
    );
    try {
      await flush(40);
      const picker = rendered.container.querySelector<HTMLSelectElement>(
        "select[aria-label='Screen']",
      )!;
      expect(picker.value).toBe(screens[0]!.id);
      expect(
        [...picker.options]
          .filter((option) => !option.disabled)
          .map((option) => option.textContent),
      ).toEqual(["Main display", "Second display"]);
      await actRun(() => {
        picker.value = screens[1]!.id;
        picker.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await flush(20);
      expect(picker.value).toBe(screens[1]!.id);
      expect(attachments).toEqual([screens[0]!.id, screens[1]!.id]);
      expect(requests).toHaveLength(0);
      await dispatch(sockets[1]!, "open");
      await dispatch(sockets[1]!, "message", {
        data: frameMessage(screens[1]!.id, 1, { width: 1_600, height: 900 }).buffer,
      });
      await canvasMock.finishDecode(0);
      const canvas = rendered.container.querySelector<HTMLCanvasElement>("canvas")!;
      canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 800, height: 450 }) as DOMRect;
      await actRun(() => {
        for (const type of ["pointerdown", "pointerup"]) {
          canvas.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: 200,
              clientY: 150,
            }),
          );
        }
      });
      await flush(350);
      expect(requests[0]).toMatchObject({
        targetId: screens[1]!.id,
        expectedTargetGeneration: "screen-2-generation",
        expectedFrameId: "frame-1",
        action: { type: "pointer", action: "click", x: 400, y: 300 },
      });
      await actRun(() =>
        rendered.container
          .querySelector<HTMLButtonElement>("button[aria-label='Refresh desktops']")!
          .click(),
      );
      await flush(20);
      expect(picker.value).toBe(screens[1]!.id);
      expect(requests).toHaveLength(1);
    } finally {
      await rendered.unmount();
      canvasMock.restore();
    }
  });

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

  for (const recovery of ["Reconnect", "Refresh desktops"]) {
    test(`recovers an ended desktop producer through ${recovery} after a visible frame`, async () => {
      const canvasMock = mockComputerCanvas();
      const current = computerSession();
      const currentTarget = target();
      const sockets: FakeComputerSocket[] = [];
      let attachmentCalls = 0;
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
          attachmentCalls += 1;
          return {
            ...relayAttachment(currentTarget.id),
            expiresAt: new Date(Date.now() + 2_000).toISOString(),
          };
        },
      });
      const rendered = await renderComponent(
        <ComputerViewer
          client={client}
          workspaceId={WORKSPACE_ID}
          sessionId={SESSION_ID}
          webSocketFactory={(url, protocols) => {
            const socket = new FakeComputerSocket(url, protocols);
            sockets.push(socket);
            return socket as unknown as ComputerFrameWebSocket;
          }}
        />,
      );
      try {
        await flush(40);
        const showFrame = async (socket: FakeComputerSocket) => {
          await dispatch(socket, "open");
          await dispatch(socket, "message", {
            data: relayMessage(
              2,
              StreamOpenAck.encode({
                accepted: true,
                error: undefined,
                resumeFromSeq: "0",
              }).finish(),
            ),
          });
          await dispatch(socket, "message", {
            data: relayMessage(
              3,
              StreamFrame.encode({
                channelId: "computer-channel-1",
                seq: "1",
                data: frameMessage(currentTarget.id, 1),
                producedAtMs: String(Date.now()),
              }).finish(),
            ),
          });
          await flush(10);
        };
        const canvas = rendered.container.querySelector("canvas")!;
        const keyboard = rendered.container.querySelector<HTMLTextAreaElement>(
          "textarea[aria-label='Desktop keyboard input']",
        )!;
        await showFrame(sockets[0]!);
        expect(canvas.classList.contains("invisible")).toBe(false);
        expect(keyboard.disabled).toBe(false);

        await dispatch(sockets[0]!, "message", {
          data: relayMessage(
            4,
            StreamClose.encode({
              channelId: "computer-channel-1",
              reason: 0,
              message: "producer ended",
            }).finish(),
          ),
        });
        await flush(10);
        expect(rendered.container.textContent).toContain("Live view disconnected");
        expect(canvas.classList.contains("invisible")).toBe(true);
        expect(keyboard.disabled).toBe(true);
        // The old grant renewal must not revive a terminal producer behind
        // the error panel without either recovery action below.
        await flush(1_100);
        expect(attachmentCalls).toBe(1);

        const retry = [...rendered.container.querySelectorAll("button")].find(
          (button) =>
            button.textContent?.trim() === recovery ||
            button.getAttribute("aria-label") === recovery,
        );
        expect(retry).toBeDefined();
        await actRun(() => retry!.click());
        await flush(40);
        expect(attachmentCalls).toBe(2);
        await showFrame(sockets[1]!);
        expect(canvas.classList.contains("invisible")).toBe(false);
        expect(keyboard.disabled).toBe(false);
        expect(rendered.container.textContent).not.toContain("Live view disconnected");
      } finally {
        await rendered.unmount();
        canvasMock.restore();
      }
    });
  }

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
    expect(rendered.container.textContent).toContain("app controls work in the background");
    expect(
      rendered.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Desktop keyboard input']",
      )?.disabled,
    ).toBe(false);
    await rendered.unmount();
  });

  test("keeps usable background controls visible after a large structural tree", async () => {
    const backgroundWindow = { ...target(), focused: false };
    const observed = observation(backgroundWindow);
    observed.semantic = {
      kind: "snapshot",
      nodeCount: 129,
      roots: [
        {
          ref: "root",
          role: "frame",
          name: "Test window",
          states: [],
          actions: ["invoke"],
          children: [
            ...Array.from({ length: 125 }, (_, index) => ({
              ref: `panel-${index}`,
              role: "panel",
              name: "Layout container",
              states: [],
              actions: ["invoke"],
            })),
            { ref: "run", role: "button", name: "Run checks", states: [], actions: ["invoke"] },
            { ref: "focus", role: "entry", name: "Focus only", states: [], actions: ["focus"] },
            {
              ref: "value",
              role: "entry",
              name: "Name",
              value: "first",
              states: [],
              actions: ["set_value"],
            },
          ],
        },
      ],
    };
    const actions: unknown[] = [];
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [computerSession()] }),
      getComputerSession: async () => computerSession(),
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [backgroundWindow],
      }),
      observeComputerTarget: async () => observed,
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        attachment(request.targetId),
      actInComputer: async (_workspaceId, _computerSessionId, request) => {
        actions.push(request);
        return receipt(observed, request.operationId);
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
    const controls = [...rendered.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Controls 2",
    );
    expect(controls).toBeDefined();
    await actRun(() => controls!.click());
    const panel = rendered.container.querySelector("aside")!;
    expect(panel.textContent).not.toContain("Layout container");
    expect(panel.textContent).not.toContain("Focus only");
    expect(panel.querySelector<HTMLInputElement>('input[aria-label="Set Name"]')?.value).toBe(
      "first",
    );
    const run = [...panel.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Run checks"),
    );
    expect(run?.disabled).toBe(false);
    await actRun(() => run!.click());
    await flush(5);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      expectedObservationId: observed.observationId,
      action: { type: "semantic", locator: { kind: "ref", ref: "run" }, action: "invoke" },
    });
    expect(
      rendered.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Desktop keyboard input']",
      )?.disabled,
    ).toBe(true);
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

  test("routes advertised background window clicks and typing without focusing the desktop", async () => {
    const canvasMock = mockComputerCanvas();
    const fixture = await renderComputerInputFixture(undefined, undefined, {
      currentTarget: { ...target(), title: "Background window", focused: false },
      backgroundInput: true,
    });
    try {
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      expect(fixture.keyboard.disabled).toBe(false);
      expect(fixture.rendered.container.textContent).not.toContain("Control directly");
      expect(fixture.rendered.container.textContent).toContain(
        "clicks and typing stay in the background",
      );
      await actRun(() => {
        fixture.canvas.dispatchEvent(
          new MouseEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            clientX: 20,
            clientY: 20,
            button: 0,
          }),
        );
        fixture.canvas.dispatchEvent(
          new MouseEvent("pointerup", {
            bubbles: true,
            clientX: 20,
            clientY: 20,
            button: 0,
          }),
        );
        fixture.keyboard.value = "background text";
        fixture.keyboard.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
      await flush(40);
      expect(fixture.actions.map((request) => request.action)).toEqual([
        { type: "pointer", frameId: "frame-1", action: "click", x: 0, y: 0 },
        { type: "keyboard", action: "type", value: "background text" },
      ]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
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

describe("ComputerViewer input reliability", () => {
  test.each([undefined, false, true])(
    "requires explicit attachment input scope for RFB (%p)",
    async (inputAllowed) => {
      const priorWebSocket = globalThis.WebSocket;
      globalThis.WebSocket = class extends EventTarget {
        static CONNECTING = 0;
        static CLOSED = 3;
        readyState = 0;
        binaryType = "arraybuffer";
        close() {
          this.readyState = 3;
        }
      } as unknown as typeof WebSocket;
      const currentSession = computerSession();
      const currentTarget = target();
      const client = fakeClient({
        listComputerSessions: async () => ({ revision: 1, sessions: [currentSession] }),
        getComputerSession: async () => currentSession,
        listComputerTargets: async () => ({
          computerSessionId: COMPUTER_SESSION_ID,
          controllerGeneration: "controller-1",
          targets: [currentTarget],
        }),
        observeComputerTarget: async () => observation(currentTarget),
        attachComputerSession: async (_workspaceId, _computerSessionId, request) => {
          const rfbGrantAttachment = rfbAttachment(request.targetId);
          if (rfbGrantAttachment.stream.kind === "direct_rfb") {
            if (inputAllowed === undefined)
              delete (rfbGrantAttachment.stream as Partial<typeof rfbGrantAttachment.stream>)
                .inputAllowed;
            else rfbGrantAttachment.stream.inputAllowed = inputAllowed;
          }
          return rfbGrantAttachment;
        },
      });
      const rendered = await renderComponent(
        <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
      );
      try {
        await flush(40);
        const desktop = rendered.container.querySelector("[data-opengeni-desktop]");
        expect(desktop).not.toBeNull();
        expect(desktop!.hasAttribute("data-in-control")).toBe(inputAllowed === true);
      } finally {
        await rendered.unmount();
        globalThis.WebSocket = priorWebSocket;
      }
    },
  );

  test.each(["same paint", "pending decode", "new paint"] as const)(
    "dispatches an immediate first click and one continuation against each actual %s",
    async (paint) => {
      const canvasMock = mockComputerCanvas(true);
      let finishFirst!: (receipt: ComputerActionReceipt) => void;
      const fixture = await renderComputerInputFixture(
        async (request) =>
          fixture.actions.length === 1
            ? await new Promise<ComputerActionReceipt>((resolve) => {
                finishFirst = resolve;
              })
            : { ...receipt(observation(), request.operationId), observation: null },
        undefined,
        { pointerClickContinuation: true },
      );
      try {
        await fixture.frame(1, { width: 400, height: 300 });
        await canvasMock.finishDecode(0);
        await computerGesture(fixture.canvas, [25, 25]);
        await flush();
        expect(fixture.actions.map(({ action }) => action)).toEqual([
          { type: "pointer", action: "click", clickCount: 1, frameId: "frame-1", x: 100, y: 75 },
        ]);
        if (paint !== "same paint") {
          await fixture.frame(2, { width: 400, height: 300 });
          if (paint === "new paint") await canvasMock.finishDecode(1);
        }
        await computerGesture(fixture.canvas, [25, 25]);
        await flush();
        expect(fixture.actions).toHaveLength(2);
        await actRun(() =>
          finishFirst({
            ...receipt(observation(), fixture.actions[0]!.operationId),
            observation: null,
          }),
        );
        await flush();
        const frameId = paint === "new paint" ? "frame-2" : "frame-1";
        expect(fixture.actions.map(({ action }) => action)).toEqual([
          { type: "pointer", action: "click", clickCount: 1, frameId: "frame-1", x: 100, y: 75 },
          {
            type: "pointer",
            action: "click",
            clickCount: 2,
            frameId,
            x: 100,
            y: 75,
            continuationOfOperationId: fixture.actions[0]!.operationId,
          },
        ]);
        expect(fixture.actions.map(({ expectedFrameId }) => expectedFrameId)).toEqual([
          "frame-1",
          frameId,
        ]);
        expect(
          fixture.actions.every(
            ({ expectedTargetGeneration }) => expectedTargetGeneration === "window-1-generation",
          ),
        ).toBe(true);
        if (paint === "pending decode") await canvasMock.finishDecode(1);
      } finally {
        await fixture.rendered.unmount();
        canvasMock.restore();
      }
    },
  );

  test.each(["drag", "key", "right click", "wheel"] as const)(
    "does not resend an immediate click before a following %s",
    async (next) => {
      const canvasMock = mockComputerCanvas();
      const fixture = await renderComputerInputFixture(undefined, undefined, {
        pointerClickContinuation: true,
      });
      try {
        await fixture.frame(1, { width: 400, height: 300 });
        await canvasMock.finishDecode(0);
        await computerGesture(fixture.canvas, [25, 25]);
        await flush();
        if (next === "drag") await computerGesture(fixture.canvas, [25, 25], [50, 50]);
        else
          await actRun(() => {
            if (next === "key")
              fixture.keyboard.dispatchEvent(
                new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
              );
            if (next === "right click")
              fixture.canvas.dispatchEvent(
                new MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: 25,
                  clientY: 25,
                }),
              );
            if (next === "wheel") fixture.canvas.dispatchEvent(computerWheel(100));
          });
        await flush(50);
        expect(fixture.actions).toHaveLength(2);
        expect(fixture.actions[0]!.action).toMatchObject({
          type: "pointer",
          action: "click",
          clickCount: 1,
        });
        expect(fixture.actions[1]!.action).toMatchObject(
          next === "drag"
            ? {
                type: "pointer",
                action: "drag",
                frameId: "frame-1",
                x: 100,
                y: 75,
                endX: 200,
                endY: 150,
              }
            : next === "key"
              ? { type: "keyboard", action: "press", value: "Enter" }
              : next === "right click"
                ? { type: "pointer", action: "click", button: "right" }
                : { type: "pointer", action: "scroll", deltaY: 100 },
        );
      } finally {
        await fixture.rendered.unmount();
        canvasMock.restore();
      }
    },
  );

  test.each([
    "failed",
    "outcome_unknown",
    "target switch",
    "generation change",
    "controller change",
  ] as const)(
    "clears first-click continuation before a later gesture after %s",
    async (boundary) => {
      const canvasMock = mockComputerCanvas();
      let finishFirst!: (receipt: ComputerActionReceipt) => void;
      const fixture = await renderComputerInputFixture(
        async (request) =>
          fixture.actions.length === 1
            ? await new Promise<ComputerActionReceipt>((resolve) => {
                finishFirst = resolve;
              })
            : { ...receipt(observation(), request.operationId), observation: null },
        undefined,
        { pointerClickContinuation: true },
      );
      try {
        await fixture.frame(1, { width: 400, height: 300 });
        await canvasMock.finishDecode(0);
        await computerGesture(fixture.canvas, [25, 25]);
        await flush();
        expect(fixture.actions).toHaveLength(1);
        if (boundary === "target switch") await fixture.switchTarget();
        await actRun(() =>
          finishFirst({
            ...receipt(observation(), fixture.actions[0]!.operationId),
            observation:
              boundary === "generation change"
                ? observation({ ...target(), targetGeneration: "generation-2" })
                : boundary === "controller change"
                  ? observation({ ...target(), controllerGeneration: "controller-2" })
                  : null,
            ...(boundary === "failed" || boundary === "outcome_unknown"
              ? {
                  state: boundary,
                  error: {
                    code: "resource_unavailable",
                    message: "Synthetic delivery failure",
                    retryable: false,
                  },
                }
              : {}),
          }),
        );
        await flush();
        expect(fixture.actions).toHaveLength(1);
        if (boundary === "failed" || boundary === "outcome_unknown") {
          await computerGesture(fixture.canvas, [25, 25]);
          await flush();
          expect(fixture.actions).toHaveLength(2);
          expect(fixture.actions[1]!.action).toMatchObject({ action: "click", clickCount: 1 });
        }
      } finally {
        await fixture.rendered.unmount();
        canvasMock.restore();
      }
    },
  );

  test("sends the real second click while the first receipt waits and fences later keys behind both", async () => {
    const canvasMock = mockComputerCanvas();
    const finishes: Array<(value: ComputerActionReceipt) => void> = [];
    const fixture = await renderComputerInputFixture(
      async (request) =>
        fixture.actions.length <= 2
          ? await new Promise<ComputerActionReceipt>((resolve) => finishes.push(resolve))
          : { ...receipt(observation(), request.operationId), observation: null },
      undefined,
      { pointerClickContinuation: true },
    );
    try {
      await fixture.frame(1, { width: 400, height: 300 });
      await canvasMock.finishDecode(0);
      await computerGesture(fixture.canvas, [25, 25]);
      await computerGesture(fixture.canvas, [25, 25]);
      await flush();
      expect(fixture.actions).toHaveLength(2);
      expect(fixture.actions[1]!.action).toMatchObject({
        clickCount: 2,
        continuationOfOperationId: fixture.actions[0]!.operationId,
      });
      await actRun(() =>
        fixture.rendered.container
          .querySelector<HTMLTextAreaElement>("textarea")!
          .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      await actRun(() =>
        finishes[1]!({
          ...receipt(observation(), fixture.actions[1]!.operationId),
          observation: null,
        }),
      );
      await flush();
      expect(fixture.actions).toHaveLength(2);
      await actRun(() =>
        finishes[0]!({
          ...receipt(observation(), fixture.actions[0]!.operationId),
          observation: null,
        }),
      );
      await flush();
      expect(fixture.actions).toHaveLength(3);
      expect(fixture.actions[2]!.action).toEqual({
        type: "keyboard",
        action: "press",
        value: "Enter",
      });
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test.each(["transport rejection", "failed receipt", "unknown receipt"] as const)(
    "a late first %s cannot cancel a key queued after the second click completes",
    async (result) => {
      const canvasMock = mockComputerCanvas();
      const pending: Array<{
        resolve: (value: ComputerActionReceipt) => void;
        reject: (cause: Error) => void;
      }> = [];
      const fixture = await renderComputerInputFixture(
        async (request) =>
          fixture.actions.length <= 2
            ? await new Promise<ComputerActionReceipt>((resolve, reject) => {
                pending.push({ resolve, reject });
              })
            : { ...receipt(observation(), request.operationId), observation: null },
        undefined,
        { pointerClickContinuation: true },
      );
      try {
        await fixture.frame(1, { width: 400, height: 300 });
        await canvasMock.finishDecode(0);
        await computerGesture(fixture.canvas, [25, 25]);
        await computerGesture(fixture.canvas, [25, 25]);
        await flush();
        expect(fixture.actions).toHaveLength(2);
        await actRun(() => {
          fixture.keyboard.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
          pending[1]!.resolve({
            ...receipt(observation(), fixture.actions[1]!.operationId),
            observation: null,
          });
        });
        await flush();
        expect(fixture.actions).toHaveLength(2);
        await actRun(() => {
          if (result === "transport rejection")
            pending[0]!.reject(new Error("Earlier transport failed"));
          else
            pending[0]!.resolve({
              ...receipt(observation(), fixture.actions[0]!.operationId),
              observation: null,
              state: result === "failed receipt" ? "failed" : "outcome_unknown",
              error: {
                code: "driver_failed",
                message: "Earlier delivery failed",
                retryable: false,
              },
            });
        });
        await flush();
        expect(fixture.actions).toHaveLength(3);
        expect(fixture.actions[2]!.action).toEqual({
          type: "keyboard",
          action: "press",
          value: "Enter",
        });
        expect(fixture.notifications).toEqual([]);
      } finally {
        await fixture.rendered.unmount();
        canvasMock.restore();
      }
    },
  );

  test("an older failure preserves the latest failed click and only notifies that latest failure", async () => {
    const canvasMock = mockComputerCanvas();
    const pending: Array<(value: ComputerActionReceipt) => void> = [];
    const fixture = await renderComputerInputFixture(
      async () => await new Promise<ComputerActionReceipt>((resolve) => pending.push(resolve)),
      undefined,
      { pointerClickContinuation: true },
    );
    try {
      await fixture.frame(1, { width: 400, height: 300 });
      await canvasMock.finishDecode(0);
      await computerGesture(fixture.canvas, [25, 25]);
      await computerGesture(fixture.canvas, [25, 25]);
      await flush();
      await actRun(() => {
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
        pending[1]!({
          ...receipt(observation(), fixture.actions[1]!.operationId),
          observation: null,
          state: "failed",
          error: { code: "driver_failed", message: "Latest click failed", retryable: false },
        });
      });
      await flush();
      await actRun(() =>
        pending[0]!({
          ...receipt(observation(), fixture.actions[0]!.operationId),
          observation: null,
          state: "failed",
          error: { code: "driver_failed", message: "Earlier click failed", retryable: false },
        }),
      );
      await flush();
      expect(fixture.actions).toHaveLength(2);
      expect(fixture.notifications).toEqual(["Latest click failed"]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test.each(["prepared", "dispatched"] as const)(
    "a current %s receipt does not report completed input or advance queued keys",
    async (state) => {
      const canvasMock = mockComputerCanvas();
      const fixture = await renderComputerInputFixture(async (request) => ({
        ...receipt(observation(), request.operationId),
        observation: null,
        state,
      }));
      try {
        await fixture.frame(1, { width: 400, height: 300 });
        await canvasMock.finishDecode(0);
        await actRun(() => {
          fixture.canvas.dispatchEvent(
            new MouseEvent("pointerdown", { bubbles: true, clientX: 25, clientY: 25, button: 0 }),
          );
          fixture.canvas.dispatchEvent(
            new MouseEvent("pointerup", { bubbles: true, clientX: 25, clientY: 25, button: 0 }),
          );
          fixture.keyboard.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
        });
        await flush();
        expect(fixture.actions).toHaveLength(1);
        expect(fixture.notifications).toEqual(["Desktop input did not complete."]);
      } finally {
        await fixture.rendered.unmount();
        canvasMock.restore();
      }
    },
  );

  test("starts a new click after painted dimensions change without substituting frame metadata", async () => {
    const canvasMock = mockComputerCanvas();
    const fixture = await renderComputerInputFixture(undefined, undefined, {
      pointerClickContinuation: true,
    });
    try {
      await fixture.frame(1, { width: 400, height: 300 });
      await canvasMock.finishDecode(0);
      await computerGesture(fixture.canvas, [25, 25]);
      await fixture.frame(2, { width: 800, height: 600 });
      await canvasMock.finishDecode(1);
      await computerGesture(fixture.canvas, [25, 25]);
      await flush();
      expect(fixture.actions.map(({ action }) => action)).toEqual([
        { type: "pointer", action: "click", clickCount: 1, frameId: "frame-1", x: 100, y: 75 },
        { type: "pointer", action: "click", clickCount: 1, frameId: "frame-2", x: 200, y: 150 },
      ]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test.each([
    { change: "resize", rect: { left: 0, top: 0, width: 200, height: 100 }, x: 100, y: 150 },
    { change: "relocation", rect: { left: 25, top: 10, width: 100, height: 100 }, x: 100, y: 120 },
  ])(
    "starts a new click when canvas $change maps the same client point elsewhere",
    async ({ rect, x, y }) => {
      const canvasMock = mockComputerCanvas();
      const fixture = await renderComputerInputFixture(undefined, undefined, {
        pointerClickContinuation: true,
      });
      try {
        await fixture.frame(1, { width: 400, height: 300 });
        await canvasMock.finishDecode(0);
        const canvas = fixture.canvas;
        await computerGesture(canvas, [50, 50]);
        canvas.getBoundingClientRect = () => rect as DOMRect;
        await computerGesture(canvas, [50, 50]);
        await flush();
        expect(fixture.actions.map(({ action }) => action)).toEqual([
          { type: "pointer", action: "click", clickCount: 1, frameId: "frame-1", x: 200, y: 150 },
          { type: "pointer", action: "click", clickCount: 1, frameId: "frame-1", x, y },
        ]);
      } finally {
        await fixture.rendered.unmount();
        canvasMock.restore();
      }
    },
  );

  test("keeps an RFB desktop view-only when native input is unavailable", async () => {
    const priorWebSocket = globalThis.WebSocket;
    // noVNC owns its socket; keep this component check on a disconnected fixture.
    globalThis.WebSocket = class extends EventTarget {
      static CONNECTING = 0;
      static CLOSED = 3;
      readyState = 0;
      binaryType = "arraybuffer";
      close() {
        this.readyState = 3;
      }
    } as unknown as typeof WebSocket;
    const currentSession = computerSession();
    currentSession.capabilities!.keyboardInput = false;
    const currentTarget = target();
    const client = fakeClient({
      listComputerSessions: async () => ({ revision: 1, sessions: [currentSession] }),
      getComputerSession: async () => currentSession,
      listComputerTargets: async () => ({
        computerSessionId: COMPUTER_SESSION_ID,
        controllerGeneration: "controller-1",
        targets: [currentTarget],
      }),
      observeComputerTarget: async () => observation(currentTarget),
      attachComputerSession: async (_workspaceId, _computerSessionId, request) =>
        rfbAttachment(request.targetId),
    });
    const rendered = await renderComponent(
      <ComputerViewer client={client} workspaceId={WORKSPACE_ID} sessionId={SESSION_ID} />,
    );
    try {
      await flush(40);
      const desktop = rendered.container.querySelector("[data-opengeni-desktop]");
      expect(desktop).not.toBeNull();
      expect(desktop!.getAttribute("data-in-control")).toBeNull();
    } finally {
      await rendered.unmount();
      globalThis.WebSocket = priorWebSocket;
    }
  });

  test.each([
    {
      pointerInput: false,
      keyboardInput: true,
      expectedHint: "Keyboard only · mouse unavailable",
    },
    {
      pointerInput: true,
      keyboardInput: false,
      expectedHint: "Mouse only · keyboard unavailable",
    },
    {
      pointerInput: false,
      keyboardInput: false,
      expectedHint: "View only · mouse and keyboard unavailable",
    },
  ])("honors mouse and keyboard availability independently (%p)", async (testCase) => {
    const { expectedHint, ...capabilities } = testCase;
    const canvasMock = mockComputerCanvas();
    const fixture = await renderComputerInputFixture();
    try {
      const currentSession = computerSession();
      Object.assign(currentSession.capabilities!, capabilities);
      fixture.client.getComputerSession = async () => currentSession;
      fixture.client.listComputerSessions = async () => ({
        revision: 2,
        sessions: [currentSession],
      });
      await actRun(() =>
        fixture.rendered.container
          .querySelector<HTMLButtonElement>("button[aria-label='Refresh desktops']")!
          .click(),
      );
      await flush(40);
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      expect(fixture.canvas.className).not.toContain("invisible");
      expect(fixture.keyboard.disabled).toBe(!capabilities.keyboardInput);
      await actRun(() => {
        for (const type of ["pointerdown", "pointerup", "contextmenu"]) {
          fixture.canvas.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              clientX: 20,
              clientY: 20,
              button: 0,
            }),
          );
        }
        fixture.canvas.dispatchEvent(computerWheel(100));
        fixture.keyboard.value = "permitted text";
        fixture.keyboard.dispatchEvent(new InputEvent("input", { bubbles: true }));
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
      await flush(350);
      expect(fixture.actions.some(({ action }) => action.type === "pointer")).toBe(
        capabilities.pointerInput,
      );
      expect(fixture.actions.some(({ action }) => action.type === "keyboard")).toBe(
        capabilities.keyboardInput,
      );
      expect(fixture.rendered.container.textContent).toContain(expectedHint);
      expect(fixture.rendered.container.textContent).not.toContain("Bring to front");
      if (!capabilities.pointerInput && !capabilities.keyboardInput) {
        expect(fixture.actions).toEqual([]);
      }
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test("fits captured windows to the dock while preserving pixels and input coordinates", async () => {
    const canvasMock = mockComputerCanvas();
    const resizeMock = mockComputerViewportResize();
    const fixture = await renderComputerInputFixture();
    const canvas = fixture.rendered.container.querySelector<HTMLCanvasElement>("canvas")!;
    const viewport = canvas.parentElement!;
    let available = { width: 1_000, height: 900 };
    let measurements = 0;
    Object.defineProperties(viewport, {
      clientWidth: {
        get: () => {
          measurements += 1;
          return available.width;
        },
      },
      clientHeight: { get: () => available.height },
    });
    canvas.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: Number.parseFloat(canvas.style.width),
        height: Number.parseFloat(canvas.style.height),
      }) as DOMRect;
    try {
      await fixture.frame(1, { width: 400, height: 300 });
      await canvasMock.finishDecode(0);
      expect([canvas.width, canvas.height]).toEqual([400, 300]);
      expect([canvas.style.width, canvas.style.height]).toEqual(["1000px", "750px"]);
      const observer = resizeMock.observers.find(({ observed }) => observed.has(viewport))!;
      expect(observer.observed).toEqual(new Set([viewport]));

      await actRun(() => {
        for (const type of ["pointerdown", "pointerup"]) {
          canvas.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button: 0,
              clientX: 760,
              clientY: 207.5,
            }),
          );
        }
      });
      await flush(350);
      expect(fixture.actions.map(({ action }) => action)).toEqual([
        { type: "pointer", frameId: "frame-1", action: "click", x: 300, y: 75 },
      ]);

      measurements = 0;
      await fixture.frame(2, { width: 400, height: 300 });
      await canvasMock.finishDecode(1);
      expect(measurements).toBe(0);
      expect(resizeMock.observers.filter(({ observed }) => observed.has(viewport))).toHaveLength(1);

      available = { width: 240, height: 500 };
      observer.emit();
      expect([canvas.style.width, canvas.style.height]).toEqual(["240px", "180px"]);
      expect([canvas.width, canvas.height]).toEqual([400, 300]);

      available = { width: 0, height: 0 };
      observer.emit();
      expect([canvas.style.width, canvas.style.height]).toEqual(["240px", "180px"]);
      await fixture.frame(3, { width: 300, height: 600 });
      await canvasMock.finishDecode(2);
      expect([canvas.width, canvas.height]).toEqual([300, 600]);
      expect([canvas.style.width, canvas.style.height]).toEqual(["240px", "180px"]);

      available = { width: 1_000, height: 900 };
      observer.emit();
      expect([canvas.style.width, canvas.style.height]).toEqual(["450px", "900px"]);
      await fixture.frame(4, { width: 1_200, height: 600 });
      await canvasMock.finishDecode(3);
      expect([canvas.style.width, canvas.style.height]).toEqual(["1000px", "500px"]);
      expect([canvas.width, canvas.height]).toEqual([1_200, 600]);

      await fixture.rendered.unmount();
      expect(observer.disconnected).toBe(true);
      expect(observer.observed.size).toBe(0);
    } finally {
      await fixture.rendered.unmount();
      resizeMock.restore();
      canvasMock.restore();
    }
  });

  test("sends only committed desktop composition text", async () => {
    const fixture = await renderComputerInputFixture();
    try {
      await actRun(() => fixture.keyboard.focus());
      await actRun(() =>
        fixture.keyboard.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
      );
      for (const text of ["n", "ni"]) {
        await actRun(() => {
          fixture.keyboard.value = text;
          fixture.keyboard.dispatchEvent(
            new InputEvent("input", { bubbles: true, data: text, isComposing: true }),
          );
          fixture.keyboard.dispatchEvent(
            new KeyboardEvent("keydown", {
              bubbles: true,
              key: "ArrowDown",
              isComposing: true,
            }),
          );
        });
        await flush(25);
      }
      expect(fixture.actions).toEqual([]);
      await actRun(() => {
        fixture.keyboard.value = "你";
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true }),
        );
        fixture.keyboard.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "你" }),
        );
        fixture.keyboard.dispatchEvent(new InputEvent("input", { bubbles: true, data: "你" }));
      });
      await flush(25);
      expect(fixture.actions.map((request) => request.action)).toEqual([
        { type: "keyboard", action: "type", value: "你" },
      ]);
    } finally {
      await fixture.rendered.unmount();
    }
  });

  test("keeps native composing keys and uncommitted desktop input local", async () => {
    const fixture = await renderComputerInputFixture();
    try {
      await actRun(() => fixture.keyboard.focus());
      await actRun(() => {
        fixture.keyboard.value = "uncommitted";
        fixture.keyboard.dispatchEvent(
          new InputEvent("input", { bubbles: true, isComposing: true }),
        );
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true }),
        );
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 229 }),
        );
        fixture.keyboard.value = "";
        fixture.keyboard.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "" }),
        );
      });
      await flush(25);
      expect(fixture.actions).toEqual([]);
    } finally {
      await fixture.rendered.unmount();
    }
  });

  test("dismisses the desktop menu without swallowing a canvas click or subsequent typing", async () => {
    const canvasMock = mockComputerCanvas();
    const fixture = await renderComputerInputFixture();
    try {
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      const menu = fixture.rendered.container.querySelector<HTMLDetailsElement>("details")!;
      menu.open = true;
      menu.querySelector("summary")!.focus();
      const pointer = new MouseEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 25,
        clientY: 25,
      });
      await actRun(() => {
        fixture.canvas.dispatchEvent(pointer);
        fixture.canvas.dispatchEvent(
          new MouseEvent("pointerup", {
            bubbles: true,
            button: 0,
            clientX: 25,
            clientY: 25,
          }),
        );
      });
      expect(pointer.defaultPrevented).toBe(true);
      expect(menu.open).toBe(false);
      expect(document.activeElement).toBe(fixture.keyboard);
      await actRun(() => {
        fixture.keyboard.value = "immediate text";
        fixture.keyboard.dispatchEvent(new InputEvent("input", { bubbles: true }));
      });
      await flush(30);
      expect(fixture.actions.map((request) => request.action)).toEqual([
        { type: "pointer", frameId: "frame-1", action: "click", x: 0, y: 0 },
        { type: "keyboard", action: "type", value: "immediate text" },
      ]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test("uses the painted frame for pointer input and discards decoding after a target switch", async () => {
    const canvasMock = mockComputerCanvas(true);
    const fixture = await renderComputerInputFixture();
    try {
      await fixture.frame(1);
      expect(fixture.canvas.className).toContain("invisible");
      await canvasMock.finishDecode(0);
      await fixture.frame(2);
      await actRun(() => {
        fixture.canvas.dispatchEvent(
          new MouseEvent("pointerdown", {
            bubbles: true,
            button: 0,
            clientX: 25,
            clientY: 25,
          }),
        );
        fixture.canvas.dispatchEvent(
          new MouseEvent("pointerup", {
            bubbles: true,
            button: 0,
            clientX: 25,
            clientY: 25,
          }),
        );
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      });
      await flush();
      expect(fixture.actions[0]).toMatchObject({
        expectedFrameId: "frame-1",
        action: { type: "pointer", frameId: "frame-1", action: "click", x: 0, y: 0 },
      });
      await fixture.switchTarget();
      await canvasMock.finishDecode(1);
      expect(canvasMock.painted).toEqual([0]);
      expect(fixture.canvas.className).toContain("invisible");
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  for (const boundary of ["target switch", "failed receipt"] as const) {
    test(`discards queued keyboard input after a ${boundary}`, async () => {
      let finishFirst!: (receipt: ComputerActionReceipt) => void;
      const fixture = await renderComputerInputFixture(
        async () =>
          await new Promise<ComputerActionReceipt>((resolve) => {
            finishFirst = resolve;
          }),
      );
      try {
        await actRun(() => {
          fixture.keyboard.focus();
          fixture.keyboard.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
          );
          fixture.keyboard.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }),
          );
        });
        await flush();
        expect(fixture.actions).toHaveLength(1);
        if (boundary === "target switch") await fixture.switchTarget();
        await actRun(() =>
          finishFirst({
            ...receipt(observation(), fixture.actions[0]!.operationId),
            observation: null,
            ...(boundary === "failed receipt"
              ? {
                  state: "failed" as const,
                  error: {
                    code: "resource_unavailable",
                    message: "input failed",
                    retryable: false,
                  },
                }
              : {}),
          }),
        );
        await flush();
        expect(fixture.actions).toHaveLength(1);
      } finally {
        await fixture.rendered.unmount();
      }
    });
  }

  test("keeps control unavailable across live frames and reconnects the same desktop", async () => {
    const canvasMock = mockComputerCanvas();
    let controlUnavailable = true;
    const fixture = await renderComputerInputFixture(
      async (request) => {
        if (controlUnavailable) throw new OpenGeniApiError(503, "Desktop control unavailable");
        return receipt(observation(), request.operationId);
      },
      undefined,
      {
        currentTarget: { ...target(), title: "Background window", focused: false },
        backgroundInput: true,
      },
    );
    const refreshed: string[] = [];
    const getSession = fixture.client.getComputerSession;
    const listTargets = fixture.client.listComputerTargets;
    fixture.client.getComputerSession = async (workspaceId, computerSessionId, options) => {
      refreshed.push(`session:${workspaceId}:${computerSessionId}`);
      return await getSession(workspaceId, computerSessionId, options);
    };
    fixture.client.listComputerTargets = async (workspaceId, computerSessionId, options) => {
      refreshed.push(`targets:${workspaceId}:${computerSessionId}`);
      return await listTargets(workspaceId, computerSessionId, options);
    };
    try {
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      await actRun(() => {
        fixture.keyboard.focus();
        fixture.keyboard.value = "a";
        fixture.keyboard.dispatchEvent(new InputEvent("input", { bubbles: true, data: "a" }));
      });
      await flush(50);
      await fixture.frame(2);
      await canvasMock.finishDecode(1);
      expect(fixture.actions).toHaveLength(1);
      expect(fixture.keyboard.disabled).toBe(true);
      expect(fixture.rendered.container.textContent).toContain("Desktop controls unavailable");
      expect(fixture.rendered.container.textContent).toContain("Reconnect to use desktop input");
      expect(fixture.rendered.container.textContent).not.toContain("App controls remain available");
      await actRun(() =>
        [...fixture.rendered.container.querySelectorAll("button")]
          .find((button) => button.textContent?.startsWith("Controls "))!
          .click(),
      );
      expect(
        [...fixture.rendered.container.querySelectorAll("button")].find((button) =>
          button.textContent?.endsWith("Run checks"),
        )?.disabled,
      ).toBe(true);
      controlUnavailable = false;
      await actRun(() =>
        [...fixture.rendered.container.querySelectorAll("button")]
          .find((button) => button.textContent === "Reconnect")!
          .click(),
      );
      await flush(40);
      expect(refreshed).toEqual([
        `session:${WORKSPACE_ID}:${COMPUTER_SESSION_ID}`,
        `targets:${WORKSPACE_ID}:${COMPUTER_SESSION_ID}`,
      ]);
      expect(fixture.actions).toHaveLength(1);
      const socket = fixture.sockets.at(-1)!;
      await dispatch(socket, "open");
      await dispatch(socket, "message", { data: frameMessage("window-1", 1).buffer });
      await canvasMock.finishDecode(2);
      expect(fixture.keyboard.disabled).toBe(false);
      expect(fixture.rendered.container.textContent).not.toContain("Desktop controls unavailable");
      await actRun(() => {
        fixture.keyboard.focus();
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      });
      await flush();
      expect(fixture.actions.map((request) => request.action)).toEqual([
        { type: "keyboard", action: "type", value: "a" },
        { type: "keyboard", action: "press", value: "Enter" },
      ]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test.each(["discovery", "clipboard"] as const)(
    "keeps controls unavailable after a %s service failure while capture continues",
    async (source) => {
      const canvasMock = mockComputerCanvas();
      const fixture = await renderComputerInputFixture(
        async (request) => receipt(observation(), request.operationId),
        async () => {
          throw new OpenGeniApiError(503, "Desktop control unavailable");
        },
      );
      try {
        await fixture.frame(1);
        await canvasMock.finishDecode(0);
        if (source === "discovery") {
          fixture.client.listComputerTargets = async () => {
            throw new OpenGeniApiError(503, "Desktop control unavailable");
          };
          await actRun(() =>
            fixture.rendered.container
              .querySelector<HTMLButtonElement>("button[aria-label='Refresh desktops']")!
              .click(),
          );
        } else {
          await actRun(() => {
            fixture.keyboard.focus();
            fixture.keyboard.dispatchEvent(new Event("copy", { bubbles: true, cancelable: true }));
          });
        }
        await flush();
        await fixture.frame(2);
        await canvasMock.finishDecode(1);
        expect(fixture.keyboard.disabled).toBe(true);
        expect(fixture.rendered.container.textContent).toContain("Desktop controls unavailable");
        expect(fixture.rendered.container.textContent).not.toContain(
          "App controls remain available",
        );
        expect(canvasMock.painted).toEqual([0, 1]);
      } finally {
        await fixture.rendered.unmount();
        canvasMock.restore();
      }
    },
  );

  test("keeps background semantic actions usable when app inspection fails", async () => {
    const canvasMock = mockComputerCanvas();
    const backgroundTarget = { ...target(), focused: false };
    const fixture = await renderComputerInputFixture(async (request) =>
      receipt(observation(backgroundTarget), request.operationId),
    );
    fixture.client.listComputerTargets = async () => ({
      computerSessionId: COMPUTER_SESSION_ID,
      controllerGeneration: "controller-1",
      targets: [backgroundTarget],
    });
    fixture.client.observeComputerTarget = async () => {
      throw new OpenGeniApiError(500, "App inspection unavailable");
    };
    try {
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      await actRun(() =>
        fixture.rendered.container
          .querySelector<HTMLButtonElement>("button[aria-label='Refresh desktops']")!
          .click(),
      );
      await flush();
      expect(fixture.keyboard.disabled).toBe(true);
      expect(fixture.rendered.container.textContent).toContain(
        "Background view · use app controls",
      );
      await actRun(() =>
        [...fixture.rendered.container.querySelectorAll("button")]
          .find((button) => button.textContent?.startsWith("Controls "))!
          .click(),
      );
      const control = [...fixture.rendered.container.querySelectorAll("button")].find((button) =>
        button.textContent?.endsWith("Run checks"),
      )!;
      expect(control.disabled).toBe(false);
      await actRun(() => control.click());
      await flush();
      expect(fixture.actions.map((request) => request.action)).toEqual([
        { type: "semantic", locator: { kind: "ref", ref: "e1" }, action: "invoke" },
      ]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test.each([500, 503])(
    "keeps live input available after a %s app inspection failure",
    async (status) => {
      const canvasMock = mockComputerCanvas();
      const fixture = await renderComputerInputFixture();
      fixture.client.observeComputerTarget = async () => {
        throw new OpenGeniApiError(status, "App inspection unavailable");
      };
      try {
        await fixture.frame(1);
        await canvasMock.finishDecode(0);
        await actRun(() =>
          fixture.rendered.container
            .querySelector<HTMLButtonElement>("button[aria-label='Refresh desktops']")!
            .click(),
        );
        await flush();
        await fixture.frame(2);
        await canvasMock.finishDecode(1);
        expect(fixture.canvas.className).not.toContain("invisible");
        expect(fixture.keyboard.disabled).toBe(false);
        expect(fixture.rendered.container.textContent).not.toContain(
          "Desktop controls unavailable",
        );
        await actRun(() => {
          fixture.keyboard.focus();
          fixture.keyboard.dispatchEvent(
            new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
          );
        });
        await flush();
        expect(fixture.actions).toHaveLength(1);
        expect(fixture.actions[0]!.targetId).toBe("window-1");
      } finally {
        await fixture.rendered.unmount();
        canvasMock.restore();
      }
    },
  );

  test.each([
    ["stale target", new OpenGeniApiError(409, "Target changed")],
    [
      "OS refusal",
      new OpenGeniApiError(
        500,
        JSON.stringify({
          error: {
            status: 500,
            code: "control_failure",
            message: "App action unavailable",
            retryable: false,
            outcomeUnknown: false,
            details: {
              interactionLayer: "connected_machine",
              interactionSurface: "computer",
              controlFailureCode: "os",
            },
          },
        }),
      ),
    ],
    [
      "uncertain gateway mutation",
      new OpenGeniApiError(504, "Gateway unavailable", { mutation: true }),
    ],
    [
      "uncertain transport mutation",
      new OpenGeniApiError(0, "Transport unavailable", { outcomeUnknown: true }),
    ],
  ] as const)("does not label a %s as a control outage or replay it", async (_name, error) => {
    const canvasMock = mockComputerCanvas();
    let fail = true;
    const fixture = await renderComputerInputFixture(async (request) => {
      if (fail) throw error;
      return receipt(observation(), request.operationId);
    });
    try {
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      await actRun(() => {
        fixture.keyboard.focus();
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      });
      await flush();
      await fixture.frame(2);
      await canvasMock.finishDecode(1);
      expect(fixture.actions).toHaveLength(1);
      expect(fixture.keyboard.disabled).toBe(false);
      expect(fixture.canvas.className).not.toContain("invisible");
      expect(fixture.rendered.container.textContent).not.toContain("Desktop controls unavailable");
      fail = false;
      await actRun(() => {
        fixture.keyboard.focus();
        fixture.keyboard.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Tab" }));
      });
      await flush();
      expect(fixture.actions.map((request) => request.action)).toEqual([
        { type: "keyboard", action: "press", value: "Enter" },
        { type: "keyboard", action: "press", value: "Tab" },
      ]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test("hides a frame after the selected target generation changes", async () => {
    const canvasMock = mockComputerCanvas();
    const fixture = await renderComputerInputFixture(async (request) =>
      receipt(observation({ ...target(), targetGeneration: "generation-2" }), request.operationId),
    );
    try {
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      await actRun(() => {
        fixture.keyboard.focus();
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      });
      await flush();
      expect(fixture.canvas.className).toContain("invisible");
      expect(canvasMock.painted).toEqual([0]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test("does not paste a delayed clipboard read into a newly selected target", async () => {
    let finishRead!: (clipboard: ComputerClipboard) => void;
    const fixture = await renderComputerInputFixture(
      undefined,
      async () =>
        await new Promise<ComputerClipboard>((resolve) => {
          finishRead = resolve;
        }),
    );
    try {
      const paste = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(paste, "clipboardData", {
        value: { getData: () => "old target text" },
      });
      await actRun(() => fixture.keyboard.dispatchEvent(paste));
      await flush();
      expect(fixture.actions.map((request) => request.action.type)).toEqual(["clipboard"]);
      expect(finishRead).toBeDefined();
      await fixture.switchTarget();
      await actRun(() =>
        finishRead({
          computerSessionId: COMPUTER_SESSION_ID,
          controllerGeneration: "controller-1",
          text: "old target text",
          truncated: false,
          observedAt: NOW,
        }),
      );
      await flush();
      expect(fixture.actions.map((request) => request.action)).toEqual([
        { type: "clipboard", operation: "write", text: "old target text" },
      ]);
    } finally {
      await fixture.rendered.unmount();
    }
  });

  test("preserves scroll deltas across frames and sends scroll before a key", async () => {
    const canvasMock = mockComputerCanvas();
    const fixture = await renderComputerInputFixture();
    try {
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      await actRun(() => fixture.canvas.dispatchEvent(computerWheel(10)));
      await fixture.frame(2);
      await canvasMock.finishDecode(1);
      await actRun(() => {
        fixture.canvas.dispatchEvent(computerWheel(15));
        fixture.keyboard.focus();
        fixture.keyboard.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      });
      await flush(60);
      expect(fixture.actions.map((request) => request.action)).toEqual([
        {
          type: "pointer",
          frameId: "frame-2",
          action: "scroll",
          x: 0,
          y: 0,
          deltaX: 0,
          deltaY: 25,
        },
        { type: "keyboard", action: "press", value: "Enter" },
      ]);
    } finally {
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });

  test("dispatches a continuous wheel gesture within 45 ms", async () => {
    const canvasMock = mockComputerCanvas();
    const fixture = await renderComputerInputFixture();
    try {
      await fixture.frame(1);
      await canvasMock.finishDecode(0);
      const canvas = fixture.canvas;
      jest.useFakeTimers();
      let dispatchedBy60Ms = 0;
      for (let index = 0; index < 10; index += 1) {
        await actRun(() => {
          if (index > 0) jest.advanceTimersByTime(20);
          canvas.dispatchEvent(computerWheel(10));
        });
        if (index === 3) dispatchedBy60Ms = fixture.actions.length;
      }
      expect(dispatchedBy60Ms > 0).toBe(true);
      await actRun(() => jest.advanceTimersByTime(45));
      expect(
        fixture.actions.reduce(
          (sum, request) =>
            sum + (request.action.type === "pointer" ? (request.action.deltaY ?? 0) : 0),
          0,
        ),
      ).toBe(100);
    } finally {
      jest.useRealTimers();
      await fixture.rendered.unmount();
      canvasMock.restore();
    }
  });
});

function mockComputerViewportResize() {
  const priorObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  const observers: ControlledResizeObserver[] = [];
  class ControlledResizeObserver implements ResizeObserver {
    readonly observed = new Set<Element>();
    disconnected = false;

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(element: Element): void {
      this.observed.add(element);
    }
    unobserve(element: Element): void {
      this.observed.delete(element);
    }
    disconnect(): void {
      this.disconnected = true;
      this.observed.clear();
    }
    emit(): void {
      this.callback([], this);
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ControlledResizeObserver,
  });
  return {
    observers,
    restore: () => {
      if (priorObserver) Object.defineProperty(globalThis, "ResizeObserver", priorObserver);
      else Reflect.deleteProperty(globalThis, "ResizeObserver");
    },
  };
}

function mockComputerCanvas(deferred = false) {
  const priorBitmap = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
  const priorContext = HTMLCanvasElement.prototype.getContext;
  const painted: number[] = [];
  const decodes: { bitmap: ImageBitmap; resolve: (bitmap: ImageBitmap) => void }[] = [];
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: () => {
      const bitmap = { index: decodes.length, close() {} } as unknown as ImageBitmap;
      return new Promise<ImageBitmap>((resolve) => {
        decodes.push({ bitmap, resolve });
        if (!deferred) resolve(bitmap);
      });
    },
  });
  HTMLCanvasElement.prototype.getContext = (() => ({
    drawImage: (bitmap: { index: number }) => painted.push(bitmap.index),
  })) as unknown as typeof priorContext;
  return {
    painted,
    finishDecode: async (index: number) => {
      for (let tick = 0; tick < 100 && !decodes[index]; tick += 1) await flush(1);
      expect(decodes[index]).toBeDefined();
      await actRun(() => decodes[index]!.resolve(decodes[index]!.bitmap));
      await flush();
    },
    restore: () => {
      HTMLCanvasElement.prototype.getContext = priorContext;
      if (priorBitmap) Object.defineProperty(globalThis, "createImageBitmap", priorBitmap);
      else Reflect.deleteProperty(globalThis, "createImageBitmap");
    },
  };
}

function computerWheel(deltaY: number): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY });
  Object.defineProperties(event, { clientX: { value: 20 }, clientY: { value: 20 } });
  return event;
}

async function computerGesture(canvas: HTMLCanvasElement, from: [number, number], to = from) {
  await actRun(() => {
    for (const [type, point] of [
      ["pointerdown", from],
      ["pointerup", to],
    ] as const) {
      canvas.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: point[0],
          clientY: point[1],
        }),
      );
    }
  });
}

async function renderComputerInputFixture(
  actInComputer?: (request: ComputerActionRequest) => Promise<ComputerActionReceipt>,
  readComputerClipboard?: () => Promise<ComputerClipboard>,
  options: {
    currentTarget?: ComputerTarget;
    backgroundInput?: boolean;
    pointerClickContinuation?: boolean;
  } = {},
) {
  const currentTarget = options.currentTarget ?? target();
  const currentSession = computerSession();
  if (options.backgroundInput !== undefined) {
    currentSession.capabilities!.backgroundInput = options.backgroundInput;
  }
  if (options.pointerClickContinuation !== undefined) {
    currentSession.capabilities!.pointerClickContinuation = options.pointerClickContinuation;
  }
  const secondTarget = { ...target("window-2"), title: "Second desktop", focused: false };
  const actions: ComputerActionRequest[] = [];
  const sockets: FakeComputerSocket[] = [];
  const notifications: string[] = [];
  const client = fakeClient({
    listComputerSessions: async () => ({ revision: 1, sessions: [currentSession] }),
    getComputerSession: async () => currentSession,
    listComputerTargets: async () => ({
      computerSessionId: COMPUTER_SESSION_ID,
      controllerGeneration: "controller-1",
      targets: [currentTarget, secondTarget],
    }),
    observeComputerTarget: async (_workspaceId, _sessionId, targetId) =>
      observation(targetId === secondTarget.id ? secondTarget : currentTarget),
    attachComputerSession: async (_workspaceId, _sessionId, request) =>
      attachment(request.targetId),
    ...(readComputerClipboard ? { readComputerClipboard } : {}),
    actInComputer: async (_workspaceId, _sessionId, request) => {
      actions.push(request);
      return actInComputer
        ? await actInComputer(request)
        : {
            ...receipt(observation(currentTarget), request.operationId),
            observation: null,
          };
    },
  });
  const rendered = await renderComponent(
    <ComputerViewer
      client={client}
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      webSocketFactory={(url, protocols) => {
        const socket = new FakeComputerSocket(url, protocols);
        sockets.push(socket);
        return socket as unknown as ComputerFrameWebSocket;
      }}
      onNotify={(notification) => notifications.push(notification.message)}
    />,
  );
  await flush(40);
  await dispatch(sockets[0]!, "open");
  return {
    client,
    rendered,
    actions,
    sockets,
    notifications,
    get canvas() {
      const canvas = rendered.container.querySelector<HTMLCanvasElement>("canvas")!;
      canvas.getBoundingClientRect = () =>
        ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
      return canvas;
    },
    get keyboard() {
      return rendered.container.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Desktop keyboard input']",
      )!;
    },
    frame: async (sequence: number, overrides: Partial<ComputerFrameMetadata> = {}) => {
      await dispatch(sockets[0]!, "message", {
        data: frameMessage("window-1", sequence, overrides).buffer,
      });
      await flush();
    },
    switchTarget: async () => {
      await actRun(() =>
        [...rendered.container.querySelectorAll("button")]
          .find((button) => button.textContent?.startsWith("Second desktop"))!
          .click(),
      );
      await flush();
    },
  };
}

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
  const png =
    (overrides.width ?? 1) !== 1 || (overrides.height ?? 1) !== 1
      ? solidPng(overrides.width ?? 1, overrides.height ?? 1)
      : Uint8Array.from(
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
    sha256: new Bun.CryptoHasher("sha256").update(png).digest("hex"),
    ...overrides,
  };
  const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
  const message = new Uint8Array(4 + encodedMetadata.byteLength + png.byteLength);
  new DataView(message.buffer).setUint32(0, encodedMetadata.byteLength, false);
  message.set(encodedMetadata, 4);
  message.set(png, 4 + encodedMetadata.byteLength);
  return message;
}

function solidPng(width: number, height: number): Uint8Array {
  const chunk = (name: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const result = Buffer.alloc(body.length + 8);
    result.writeUInt32BE(data.length, 0);
    result.set(body, 4);
    result.writeUInt32BE(Bun.hash.crc32(body), body.length + 4);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(height * (width * 3 + 1));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", new Uint8Array()),
  ]);
}
