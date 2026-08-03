import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CodexRealtimeControllerSnapshot,
  EffectiveSessionControl,
  OpenGeniClient,
  SessionEvent,
} from "@opengeni/sdk";

import {
  CodexRealtimeControl,
  RealtimeModelPickerMenu,
  codexRealtimeAdmissionAllowed,
  type RealtimeModelOption,
  useSessionCodexRealtime,
} from "./codex-realtime-control";

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

  test("admits non-cancelled work states when control and Codex are ready", () => {
    for (const sessionStatus of ["idle", "queued", "running", "requires_action"] as const) {
      expect(
        codexRealtimeAdmissionAllowed({
          sessionStatus,
          controlState: "active",
          settlement: null,
          codexConnected: true,
          lifecycleActive: false,
        }),
      ).toBe(true);
    }
    for (const blocked of [
      { sessionStatus: "cancelled" as const },
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
        model: "gpt-live-1-boulder-alpha",
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
        <output data-status={realtime.snapshot.status} data-can-start={String(realtime.canStart)} />
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
      expect(output?.getAttribute("data-can-start")).toBe("false");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("renders the compact accessible voice action and switches from start to end", async () => {
    const calls: string[] = [];
    await act(async () => {
      root.render(
        <CodexRealtimeControl
          snapshot={idle}
          canStart={true}
          modelAvailable={true}
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
    const region = container.querySelector('[aria-label="Realtime voice"]');
    const start = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start voice with Codex Live"]',
    );
    expect(region).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Start voice");
    expect(
      container.querySelector('button[aria-label="Choose voice model and options"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Realtime diagnostics");
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
          modelAvailable={true}
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
      'button[aria-label="End voice conversation"]',
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Listening");
    expect(stop?.disabled).toBe(false);
    await act(async () => stop?.click());
    expect(calls).toEqual(["start", "stop"]);
  });

  test("uses the shared provider-to-model drill-down with recognizable provider marks", async () => {
    const models: RealtimeModelOption[] = [
      {
        id: "opengeni-gateway/openai/gpt-realtime-2.1",
        label: "GPT Realtime 2.1",
        provider: "OpenGeni",
        description: "Best overall voice intelligence",
        available: true,
        unavailableReason: null,
        recommended: true,
      },
      {
        id: "gpt-live-1-boulder-alpha",
        label: "Codex Live",
        provider: "Connected Codex",
        description: "Deep session integration",
        available: true,
        unavailableReason: null,
        recommended: false,
      },
      {
        id: "workspace-gateway/openai/gpt-realtime-mini",
        label: "GPT Realtime Mini",
        provider: "Your Gateway",
        description: "Faster, lighter live voice",
        available: true,
        unavailableReason: null,
        recommended: false,
      },
    ];

    function Harness() {
      const [provider, setProvider] = useState<RealtimeModelOption["provider"] | null>(null);
      return (
        <RealtimeModelPickerMenu
          models={models}
          selectedModel={models[1]!}
          provider={provider}
          direction={provider ? 1 : -1}
          disabled={false}
          onProviderChange={(next) => setProvider(next)}
          onSelect={() => undefined}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    expect(
      container.querySelector('[data-testid="billing-class-icon-opengeni_credits"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="billing-class-icon-codex_subscription"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="billing-class-icon-byok"]')).not.toBeNull();
    expect(container.textContent).not.toContain("GPT Realtime 2.1");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="realtime-model-provider-opengeni_credits"]',
        )
        ?.click(),
    );
    expect(container.textContent).toContain("GPT Realtime 2.1");
    expect(container.textContent).not.toContain("Codex Live");

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="model-picker-back"]')?.click(),
    );
    expect(container.textContent).toContain("Connected Codex");
    expect(container.textContent).not.toContain("GPT Realtime 2.1");
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
          modelAvailable={true}
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
    const resume = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume voice audio"]',
    );
    expect(resume?.disabled).toBe(false);
    await act(async () => resume?.click());
    expect(calls).toEqual(["audio"]);
    expect(container.querySelector('button[aria-label="Start voice with Codex Live"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Resume voice audio"]')).not.toBeNull();
  });

  test("keeps an unavailable provider quiet and explains why start is disabled", async () => {
    await act(async () => {
      root.render(
        <CodexRealtimeControl
          snapshot={idle}
          canStart={false}
          admissionBlocker="Connect Codex to use this voice model."
          modelAvailable={false}
          audioRef={createRef<HTMLAudioElement>()}
          onStart={async () => undefined}
          onStop={async () => undefined}
          onRetry={async () => undefined}
          onRetryAudibleOutput={async () => undefined}
        />,
      );
    });

    const start = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start voice with Codex Live"]',
    );
    expect(start?.dataset.phase).toBe("unavailable");
    expect(start?.disabled).toBe(true);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Voice model unavailable",
    );
  });
});
