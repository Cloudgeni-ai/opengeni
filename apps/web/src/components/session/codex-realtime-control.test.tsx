import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CodexRealtimeControllerSnapshot,
  EffectiveSessionControl,
  OpenGeniClient,
  SessionEvent,
} from "@opengeni/sdk";

import {
  CodexRealtimeControl,
  codexRealtimeAdmissionAllowed,
  realtimeSessionSurfacePolicy,
  useSessionCodexRealtime,
} from "./codex-realtime-control";
import { sessionCodexRealtimeSynchronousLock } from "./codex-realtime-policy";

GlobalRegistrator.register({ url: "https://app.example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const idle: CodexRealtimeControllerSnapshot = {
  status: "idle",
  realtimeId: null,
  mode: null,
  bridge: null,
  microphone: "inactive",
  audibleOutput: "inactive",
  connectionGeneration: 0,
  reconnectAttempt: 0,
  diagnostic: null,
  error: null,
};

const activeMode: NonNullable<CodexRealtimeControllerSnapshot["mode"]> = {
  id: "33333333-3333-4333-8333-333333333333",
  sessionId: "22222222-2222-4222-8222-222222222222",
  operationId: "44444444-4444-4444-8444-444444444444",
  browserInstanceId: "55555555-5555-4555-8555-555555555555",
  model: "gpt-live-1-boulder-alpha",
  state: "active",
  version: 1,
  connectionEpoch: 1,
  leaseExpiresAt: "2026-07-29T07:00:30.000Z",
  lastHeartbeatAt: "2026-07-29T07:00:00.000Z",
  startedAt: "2026-07-29T07:00:00.000Z",
  endedAt: null,
  endReason: null,
};

const effectiveControl: EffectiveSessionControl = {
  state: "active",
  controlVersion: 0,
  controlEtag: "active-0",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

describe("ordinary session Codex realtime control", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  test("admits only an exactly idle, controllable, settled, Codex-connected session", () => {
    expect(
      codexRealtimeAdmissionAllowed({
        sessionStatus: "idle",
        controlState: "active",
        settlement: null,
        codexConnected: true,
        lifecycleActive: false,
      }),
    ).toBe(true);
    for (const blocked of [
      { sessionStatus: "running" as const },
      { controlState: "paused" as const },
      { settlement: { state: "stopping" as const } },
      { codexConnected: false },
      { lifecycleActive: true },
    ]) {
      expect(
        codexRealtimeAdmissionAllowed({
          sessionStatus: "idle",
          controlState: "active",
          settlement: null,
          codexConnected: true,
          lifecycleActive: false,
          ...blocked,
        }),
      ).toBe(false);
    }
  });

  test("keeps the ordinary draft mounted while queue, composer, steer, and config are fenced", () => {
    for (const status of ["starting", "active", "stopping", "recovering", "lost_owner"] as const) {
      expect(realtimeSessionSurfacePolicy({ ...idle, status }, false)).toEqual({
        ordinaryControlsLocked: true,
        queueReadOnly: true,
        composerDisabled: true,
        configDisabled: true,
      });
    }
    expect(realtimeSessionSurfacePolicy(idle, true).ordinaryControlsLocked).toBe(true);
    expect(realtimeSessionSurfacePolicy(idle, false).ordinaryControlsLocked).toBe(false);
  });

  test("locks synchronously from durable lifecycle or this browser's owner proof", () => {
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const started = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId,
      sessionId,
      sequence: 10,
      type: "session.realtime.started",
      payload: {
        realtimeId: "33333333-3333-4333-8333-333333333333",
        operationId: "44444444-4444-4444-8444-444444444444",
        version: 1,
        connectionEpoch: 1,
        leaseExpiresAt: "2026-07-29T07:00:30.000Z",
      },
      occurredAt: "2026-07-29T07:00:00.000Z",
    } satisfies SessionEvent;

    expect(sessionCodexRealtimeSynchronousLock([], workspaceId, sessionId)).toBe(false);
    sessionStorage.setItem(`opengeni:codex-realtime-owner:${workspaceId}:${sessionId}`, "proof");
    expect(sessionCodexRealtimeSynchronousLock([], workspaceId, sessionId)).toBe(true);
    sessionStorage.clear();
    expect(sessionCodexRealtimeSynchronousLock([started], workspaceId, sessionId)).toBe(true);
    expect(
      sessionCodexRealtimeSynchronousLock(
        [
          {
            ...started,
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            sequence: 11,
            type: "session.realtime.ended",
            payload: {
              ...started.payload,
              version: 2,
              reason: "user_stop",
            },
          },
          started,
        ],
        workspaceId,
        sessionId,
      ),
    ).toBe(false);
  });

  test("catches up a durable active lifecycle that predates the lazy controller load", async () => {
    const started: SessionEvent = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "22222222-2222-4222-8222-222222222222",
      sequence: 10,
      type: "session.realtime.started",
      payload: {
        realtimeId: "33333333-3333-4333-8333-333333333333",
        operationId: "44444444-4444-4444-8444-444444444444",
        version: 1,
        connectionEpoch: 1,
        leaseExpiresAt: "2026-07-29T07:00:30.000Z",
      },
      occurredAt: "2026-07-29T07:00:00.000Z",
    };
    const client = {
      beginSessionRealtime: async () => {
        throw new Error("must not begin without local owner proof");
      },
    } as unknown as OpenGeniClient;
    const events = [started];

    function Harness() {
      const realtime = useSessionCodexRealtime({
        client,
        workspaceId: started.workspaceId,
        sessionId: started.sessionId,
        sessionStatus: "idle",
        effectiveControl,
        events,
        eventsReady: true,
        codexConnected: true,
      });
      return (
        <output
          data-status={realtime.snapshot.status}
          data-locked={String(realtime.policy.ordinaryControlsLocked)}
          data-can-start={String(realtime.canStart)}
        />
      );
    }

    const consoleError = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await act(async () => root.render(<Harness />));
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
        if (container.querySelector("output")?.getAttribute("data-status") === "lost_owner") {
          break;
        }
      }
      const output = container.querySelector("output");
      expect(output?.getAttribute("data-status")).toBe("lost_owner");
      expect(output?.getAttribute("data-locked")).toBe("true");
      expect(output?.getAttribute("data-can-start")).toBe("false");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("renders accessible status and start/stop controls without exposing owner proof", async () => {
    const calls: string[] = [];
    await act(async () => {
      root.render(
        <CodexRealtimeControl
          snapshot={idle}
          canStart={true}
          codexConnected={true}
          showDiagnostics={true}
          audioRef={createRef<HTMLAudioElement>()}
          onStart={async () => {
            calls.push("start");
          }}
          onStop={async () => {
            calls.push("stop");
          }}
          onRetry={async () => {
            calls.push("retry");
          }}
          onRetryAudibleOutput={async () => {
            calls.push("audio");
          }}
        />,
      );
    });
    const region = container.querySelector('[aria-label="Codex realtime"]');
    const start = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start Codex realtime"]',
    );
    expect(region).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Ready");
    expect(container.textContent).toContain("Realtime debug");
    expect(container.textContent).toContain("client delegation");
    expect(start?.disabled).toBe(false);
    await act(async () => start?.click());
    expect(calls).toEqual(["start"]);
    expect(container.textContent).not.toContain("opengeni-realtime-owner");

    await act(async () => {
      root.render(
        <CodexRealtimeControl
          snapshot={{
            ...idle,
            status: "active",
            realtimeId: "redacted-realtime-id",
            mode: activeMode,
          }}
          canStart={false}
          codexConnected={true}
          showDiagnostics={true}
          audioRef={createRef<HTMLAudioElement>()}
          onStart={async () => {
            calls.push("start");
          }}
          onStop={async () => {
            calls.push("stop");
          }}
          onRetry={async () => {
            calls.push("retry");
          }}
          onRetryAudibleOutput={async () => {
            calls.push("audio");
          }}
        />,
      );
    });
    const stop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Stop Codex realtime"]',
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Live");
    expect(container.textContent).toContain("provider started");
    expect(stop?.disabled).toBe(false);
    await act(async () => stop?.click());
    expect(calls).toEqual(["start", "stop"]);
  });

  test("exposes an autoplay-blocked retry without starting another realtime call", async () => {
    const calls: string[] = [];
    await act(async () => {
      root.render(
        <CodexRealtimeControl
          snapshot={{
            ...idle,
            status: "active",
            realtimeId: activeMode.id,
            mode: activeMode,
            audibleOutput: "blocked",
            connectionGeneration: 7,
            diagnostic: {
              kind: "autoplay_blocked",
              message: "Browser blocked audible realtime output",
              recoverable: true,
              connectionGeneration: 7,
              attempt: 0,
            },
          }}
          canStart={false}
          codexConnected={true}
          audioRef={createRef<HTMLAudioElement>()}
          onStart={async () => {
            calls.push("start");
          }}
          onStop={async () => {
            calls.push("stop");
          }}
          onRetry={async () => {
            calls.push("retry");
          }}
          onRetryAudibleOutput={async () => {
            calls.push("audio");
          }}
        />,
      );
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Audio output blocked",
    );
    const resume = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Resume audio",
    );
    expect(resume?.textContent).toContain("Resume audio");
    await act(async () => resume?.click());
    expect(calls).toEqual(["audio"]);
    expect(container.querySelector('button[aria-label="Start Codex realtime"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Stop Codex realtime"]')).not.toBeNull();
  });
});
