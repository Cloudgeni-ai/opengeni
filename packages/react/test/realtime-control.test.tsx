import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EffectiveSessionControl, OpenGeniClient, SessionEvent } from "@opengeni/sdk";
import type { SessionRealtimeControllerSnapshot } from "@opengeni/sdk/realtime";

import {
  NewSessionRealtimeControl,
  RealtimeVoiceControl,
  RealtimeModelPickerMenu,
  SessionRealtimeControl,
  codexRealtimeAdmissionAllowed,
  prestartSessionRealtime,
  realtimeConversationLanguage,
  type RealtimeModelOption,
  type SessionRealtimeControllerFactory,
  useRealtimeLanguagePreference,
  useRealtimeModelSelection,
  useSessionRealtime,
} from "../src/realtime/realtime-control";
import type { SessionRealtimeController } from "@opengeni/sdk/realtime";
import { createOpenGeniText, OpenGeniMessagesProvider } from "../src/messages/runtime";

const englishText = createOpenGeniText();

GlobalRegistrator.register({ url: "https://app.example.test" });
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

afterAll(() => {
  GlobalRegistrator.unregister();
});

const idle: SessionRealtimeControllerSnapshot = {
  status: "idle",
  realtimeId: null,
  mode: null,
  bridge: null,
  microphone: "inactive",
  inputMuted: false,
  audibleOutput: "inactive",
  outputMuted: false,
  connectionGeneration: 0,
  reconnectAttempt: 0,
  diagnostic: null,
  error: null,
};

const activeMode: NonNullable<SessionRealtimeControllerSnapshot["mode"]> = {
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

  test("keeps the shipped control independent of Vite runtime globals", async () => {
    const source = await Bun.file(
      new URL("../src/realtime/realtime-control.tsx", import.meta.url),
    ).text();
    expect(source).not.toContain("import.meta.env");
  });

  test("skips the internal catalog when the parent owns new-session selection", async () => {
    let catalogRequests = 0;
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => {
        catalogRequests += 1;
        return { models: [] };
      },
    } as unknown as OpenGeniClient;
    const selectedModel: RealtimeModelOption = {
      id: "gpt-live-1-boulder-alpha",
      label: "Codex Live",
      provider: "Connected Codex",
      description: "Deep session integration",
      available: true,
      unavailableReason: null,
      recommended: true,
    };

    await act(async () =>
      root.render(
        <NewSessionRealtimeControl
          client={client}
          workspaceId="11111111-1111-4111-8111-111111111111"
          codexConnected={true}
          models={[selectedModel]}
          selectedModel={selectedModel}
          onSelectModel={() => undefined}
          onStart={async () => true}
        />,
      ),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

    expect(catalogRequests).toBe(0);
  });

  test("admits non-cancelled work states when control and Codex are ready", () => {
    for (const sessionStatus of ["idle", "queued", "running", "requires_action"] as const) {
      expect(
        codexRealtimeAdmissionAllowed(englishText, {
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
        codexRealtimeAdmissionAllowed(englishText, {
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
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
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
      const realtime = useSessionRealtime({
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

  test("re-enables voice when the durable foreign-owner lease is already expired", async () => {
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
        leaseExpiresAt: "2020-07-29T07:00:30.000Z",
      },
      occurredAt: "2020-07-29T07:00:00.000Z",
    };
    const client = {
      beginSessionRealtime: async () => {
        throw new Error("start was not requested");
      },
    } as unknown as OpenGeniClient;
    const events = [started];

    function Harness() {
      const realtime = useSessionRealtime({
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

    await act(async () => root.render(<Harness />));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      if (container.querySelector("output")?.getAttribute("data-can-start") === "true") break;
    }
    const output = container.querySelector("output");
    expect(output?.getAttribute("data-status")).toBe("idle");
    expect(output?.getAttribute("data-can-start")).toBe("true");
  });

  test("keeps one controller while exposing the latest host model-context callback", async () => {
    let factoryCalls = 0;
    let capturedContext: (() => string | undefined) | undefined;
    const factory: SessionRealtimeControllerFactory = (options) => {
      factoryCalls += 1;
      capturedContext = options.getModelContext;
      return {
        snapshot: () => idle,
        subscribe(listener) {
          listener(idle);
          return () => undefined;
        },
        start: async () => undefined,
        observeLifecycle: async () => undefined,
        heartbeat: async () => undefined,
        flush: async () => undefined,
        ingestProviderEvent: async () => undefined,
        retry: async () => undefined,
        retryAudibleOutput: async () => true,
        setInputMuted: () => undefined,
        setOutputMuted: () => undefined,
        stop: async () => undefined,
        close: () => undefined,
      };
    };
    const client = {} as OpenGeniClient;

    function Harness({ context }: { context: string }) {
      useSessionRealtime({
        client,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        sessionId: "22222222-2222-4222-8222-222222222222",
        sessionStatus: "idle",
        effectiveControl,
        events: [],
        eventsReady: true,
        codexConnected: true,
        getModelContext: () => context,
        controllerFactory: factory,
      });
      return null;
    }

    await act(async () => root.render(<Harness context="first" />));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (factoryCalls > 0) break;
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    }
    expect(factoryCalls).toBe(1);
    expect(capturedContext?.()).toBe("first");

    await act(async () => root.render(<Harness context="second" />));
    expect(factoryCalls).toBe(1);
    expect(capturedContext?.()).toBe("second");
  });

  test("adopts a call the host started before the view mounted and flushes on turn outcomes", async () => {
    const calls: string[] = [];
    let current: SessionRealtimeControllerSnapshot = idle;
    const listeners = new Set<(snapshot: SessionRealtimeControllerSnapshot) => void>();
    const factory: SessionRealtimeControllerFactory = (options) => {
      calls.push(`create:${options.model}`);
      return {
        snapshot: () => current,
        subscribe(listener) {
          listeners.add(listener);
          listener(current);
          return () => listeners.delete(listener);
        },
        start: async () => {
          calls.push("start");
          current = { ...idle, status: "starting" };
          for (const listener of listeners) listener(current);
        },
        observeLifecycle: async () => undefined,
        heartbeat: async () => undefined,
        flush: async () => {
          calls.push("flush");
        },
        ingestProviderEvent: async () => undefined,
        retry: async () => undefined,
        retryAudibleOutput: async () => true,
        setInputMuted: () => undefined,
        setOutputMuted: () => undefined,
        stop: async () => {
          calls.push("stop");
        },
        close: () => {
          calls.push("close");
        },
      };
    };
    const client = { getWorkspaceRealtimeModelCatalog: undefined } as unknown as OpenGeniClient;
    const workspaceId = "11111111-1111-4111-8111-111111111111";
    const sessionId = "66666666-6666-4666-8666-666666666666";
    prestartSessionRealtime({
      client,
      workspaceId,
      sessionId,
      model: "gpt-live-1-boulder-alpha",
      controllerFactory: factory,
    });
    let consumed = 0;
    const turnCompleted = {
      id: "77777777-7777-4777-8777-777777777777",
      workspaceId,
      sessionId,
      sequence: 5,
      type: "turn.completed",
      payload: {},
      occurredAt: "2026-07-29T07:00:05.000Z",
    } as SessionEvent;
    const render = (events: SessionEvent[]) =>
      root.render(
        <SessionRealtimeControl
          client={client}
          workspaceId={workspaceId}
          sessionId={sessionId}
          sessionStatus="idle"
          effectiveControl={effectiveControl}
          events={events}
          eventsReady={true}
          codexConnected={true}
          controllerFactory={factory}
          realtimeAutostartModel="gpt-live-1-boulder-alpha"
          onRealtimeAutostartConsumed={() => {
            consumed += 1;
          }}
        />,
      );

    await act(async () => render([]));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      if (consumed > 0) break;
    }
    // One controller, started once by the host; the view's autostart is consumed.
    expect(calls).toEqual(["create:gpt-live-1-boulder-alpha", "start"]);
    expect(consumed).toBe(1);

    await act(async () => render([turnCompleted]));
    await act(async () => render([turnCompleted]));
    expect(calls).toEqual(["create:gpt-live-1-boulder-alpha", "start", "flush"]);

    await act(async () => root.render(<></>));
    expect(calls.at(-1)).toBe("close");
  });

  test("ends an abandoned pre-started call instead of leaving it for a later view", async () => {
    const calls: string[] = [];
    const factory: SessionRealtimeControllerFactory = (options) => {
      calls.push(`create:${options.model}`);
      return {
        snapshot: () => idle,
        subscribe(listener) {
          listener(idle);
          return () => undefined;
        },
        start: async () => {
          calls.push("start");
        },
        observeLifecycle: async () => undefined,
        heartbeat: async () => undefined,
        flush: async () => undefined,
        ingestProviderEvent: async () => undefined,
        retry: async () => undefined,
        retryAudibleOutput: async () => true,
        setInputMuted: () => undefined,
        setOutputMuted: () => undefined,
        stop: async () => {
          calls.push("stop");
        },
        close: () => {
          calls.push("close");
        },
      };
    };
    const input = {
      client: {} as OpenGeniClient,
      workspaceId: "11111111-1111-4111-8111-111111111111",
      sessionId: "88888888-8888-4888-8888-888888888888",
      model: "gpt-live-1-boulder-alpha" as const,
      controllerFactory: factory,
    };
    const abandon = prestartSessionRealtime(input);
    // A retried handoff for the same model keeps the call that is starting.
    const abandonRetry = prestartSessionRealtime(input);
    abandonRetry();
    abandon();
    for (let attempt = 0; attempt < 20 && calls.at(-1) !== "close"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(calls).toEqual(["create:gpt-live-1-boulder-alpha", "start", "stop", "close"]);
  });

  test("renders the compact accessible voice action and switches from start to end", async () => {
    const calls: string[] = [];
    await act(async () => {
      root.render(
        <RealtimeVoiceControl
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
          onSetInputMuted={(muted) => calls.push(`input:${String(muted)}`)}
          onSetOutputMuted={(muted) => calls.push(`output:${String(muted)}`)}
        />,
      );
    });
    const region = container.querySelector('[role="group"][aria-label="Realtime voice"]');
    const start = container.querySelector<HTMLButtonElement>('button[aria-label="Start voice"]');
    expect(region).not.toBeNull();
    expect(region?.classList.contains("og-realtime-control")).toBe(true);
    expect(region?.getAttribute("data-model-menu")).toBe("split");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Start voice");
    // Idle primary control is a ghost icon (no border/surface box).
    expect(start?.className).not.toMatch(/(?:^|\s)border(?:\s|$)/);
    expect(start?.className).not.toContain("bg-og-accent");
    expect(start?.className).not.toContain("bg-og-primary");
    expect(start?.className).toContain("text-og-fg-muted");
    const voiceOptions = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Choose voice model and options"]',
    );
    expect(voiceOptions).not.toBeNull();
    // Public default: 44px mobile target, compact 24px desktop split trigger.
    expect(voiceOptions?.classList.contains("w-11")).toBe(true);
    expect(voiceOptions?.classList.contains("sm:w-6")).toBe(true);
    expect(voiceOptions?.classList.contains("hidden")).toBe(false);
    expect(voiceOptions?.classList.contains("inline-flex")).toBe(true);
    expect(voiceOptions?.classList.contains("og-realtime-model-trigger")).toBe(true);
    expect(container.textContent).not.toContain("Realtime diagnostics");
    expect(start?.disabled).toBe(false);
    await act(async () => start?.click());
    expect(calls).toEqual(["start"]);
    expect(container.textContent).not.toContain("opengeni-realtime-owner");

    await act(async () => {
      root.render(
        <RealtimeVoiceControl
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
          onSetInputMuted={(muted) => calls.push(`input:${String(muted)}`)}
          onSetOutputMuted={(muted) => calls.push(`output:${String(muted)}`)}
        />,
      );
    });
    const stop = container.querySelector<HTMLButtonElement>(
      'button[aria-label="End voice conversation"]',
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Listening");
    expect(stop?.className).toContain("bg-og-primary");
    const muteCluster = container.querySelector('[data-testid="realtime-mute-controls"]');
    expect(muteCluster).not.toBeNull();
    expect(muteCluster?.className).not.toContain("max-sm:hidden");
    const muteMicrophone = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Mute microphone"]',
    );
    const muteAudio = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Mute voice audio"]',
    );
    expect(muteMicrophone?.getAttribute("aria-pressed")).toBe("false");
    expect(muteAudio?.getAttribute("aria-pressed")).toBe("false");
    await act(async () => {
      muteMicrophone?.click();
      muteAudio?.click();
    });
    expect(stop?.disabled).toBe(false);
    await act(async () => stop?.click());
    expect(calls).toEqual(["start", "input:true", "output:true", "stop"]);
  });

  test("notifies the host when voice becomes active so dictate can soft-hide", async () => {
    const activeUpdates: boolean[] = [];
    let current = {
      ...idle,
      status: "active" as const,
      realtimeId: activeMode.id,
      mode: activeMode,
    };
    const listeners = new Set<(snapshot: typeof current) => void>();
    const factory: SessionRealtimeControllerFactory = () => {
      const controller: SessionRealtimeController = {
        snapshot: () => current,
        subscribe(listener) {
          listeners.add(listener);
          listener(current);
          return () => listeners.delete(listener);
        },
        start: async () => undefined,
        observeLifecycle: async () => undefined,
        heartbeat: async () => undefined,
        flush: async () => undefined,
        ingestProviderEvent: async () => undefined,
        retry: async () => undefined,
        retryAudibleOutput: async () => true,
        setInputMuted(muted) {
          current = { ...current, inputMuted: muted };
          for (const listener of listeners) listener(current);
        },
        setOutputMuted(muted) {
          current = { ...current, outputMuted: muted };
          for (const listener of listeners) listener(current);
        },
        stop: async () => undefined,
        close() {
          listeners.clear();
        },
      };
      return controller;
    };

    await act(async () => {
      root.render(
        <SessionRealtimeControl
          client={
            {
              getWorkspaceRealtimeModelCatalog: undefined,
            } as unknown as OpenGeniClient
          }
          workspaceId="11111111-1111-4111-8111-111111111111"
          sessionId="22222222-2222-4222-8222-222222222222"
          sessionStatus="idle"
          effectiveControl={effectiveControl}
          events={[]}
          eventsReady={true}
          codexConnected={true}
          controllerFactory={factory}
          modelMenu="split-desktop"
          onVoiceActiveChange={(active) => {
            activeUpdates.push(active);
          }}
        />,
      );
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      if (activeUpdates.includes(true)) break;
    }
    expect(activeUpdates.includes(true)).toBe(true);
    expect(container.querySelector('[role="group"]')?.getAttribute("data-model-menu")).toBe(
      "split-desktop",
    );
    expect(container.querySelector('[data-testid="realtime-mute-controls"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="realtime-mute-controls"]')?.className,
    ).not.toContain("max-sm:hidden");
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
      {
        id: "workspace-elevenlabs/eleven_realtime_v1_max",
        label: "Eleven Realtime v1 max",
        provider: "Your ElevenLabs",
        description: "Reasons before replying",
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
    // Each provider has its own row id, even when two share a billing class.
    expect(
      [...container.querySelectorAll<HTMLElement>('[data-testid^="realtime-model-provider-"]')].map(
        (row) => row.dataset.testid,
      ),
    ).toEqual([
      "realtime-model-provider-opengeni",
      "realtime-model-provider-codex",
      "realtime-model-provider-gateway",
      "realtime-model-provider-elevenlabs",
    ]);

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="realtime-model-provider-opengeni"]')
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

  test("sets the conversation language for models that need one, defaulting to the app language", async () => {
    localStorage.removeItem("opengeni:realtime-language");
    const eleven: RealtimeModelOption = {
      id: "workspace-elevenlabs/eleven_realtime_v1_max",
      label: "Eleven Realtime v1 max",
      provider: "Your ElevenLabs",
      description: "Reasons before replying; best at handing off work",
      available: true,
      unavailableReason: null,
      recommended: false,
      languages: ["en", "no", "sv"],
    };
    const gateway: RealtimeModelOption = {
      id: "workspace-gateway/openai/gpt-realtime-mini",
      label: "GPT Realtime Mini",
      provider: "Your Gateway",
      description: "Faster, lighter live voice",
      available: true,
      unavailableReason: null,
      recommended: false,
    };
    // Models that detect the spoken language themselves are sent none.
    expect(realtimeConversationLanguage(gateway, "sv", "nb-NO")).toBeUndefined();
    expect(realtimeConversationLanguage(eleven, null, "nb-NO")).toBe("nb-NO");
    expect(realtimeConversationLanguage(eleven, "sv", "nb-NO")).toBe("sv");

    function Harness(props: { provider: RealtimeModelOption["provider"] }) {
      return (
        <OpenGeniMessagesProvider locale="nb-NO">
          <RealtimeModelPickerMenu
            models={[eleven, gateway]}
            selectedModel={props.provider === eleven.provider ? eleven : gateway}
            provider={props.provider}
            direction={1}
            disabled={false}
            onProviderChange={() => undefined}
            onSelect={() => undefined}
          />
        </OpenGeniMessagesProvider>
      );
    }
    const languageRow = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="realtime-language-row"]');

    await act(async () => root.render(<Harness provider="Your Gateway" />));
    expect(languageRow()).toBeNull();

    await act(async () => root.render(<Harness provider="Your ElevenLabs" />));
    expect(languageRow()?.textContent).toContain("Automatic");
    await act(async () => languageRow()?.click());
    expect(
      container.querySelector('[data-testid="realtime-language-choice-automatic"]')?.textContent,
    ).toContain("norsk bokmål");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="realtime-language-choice-sv"]')
        ?.click(),
    );
    expect(localStorage.getItem("opengeni:realtime-language")).toBe("sv");

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="model-picker-back"]')?.click(),
    );
    expect(languageRow()?.textContent).toContain("svensk");

    await act(async () => languageRow()?.click());
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="realtime-language-choice-automatic"]')
        ?.click(),
    );
    expect(localStorage.getItem("opengeni:realtime-language")).toBeNull();

    // Without a pick of their own, people talk in the workspace's language.
    const elevenWithWorkspaceLanguage = { ...eleven, workspaceVoiceSettings: { language: "no" } };
    await act(async () =>
      root.render(
        <OpenGeniMessagesProvider locale="en-US">
          <RealtimeModelPickerMenu
            models={[elevenWithWorkspaceLanguage, gateway]}
            selectedModel={elevenWithWorkspaceLanguage}
            provider="Your ElevenLabs"
            direction={1}
            disabled={false}
            onProviderChange={() => undefined}
            onSelect={() => undefined}
          />
        </OpenGeniMessagesProvider>,
      ),
    );
    expect(languageRow()?.textContent).toContain("Automatic · Norwegian");
    await act(async () => languageRow()?.click());
    expect(
      container.querySelector('[data-testid="realtime-language-choice-automatic"]')?.textContent,
    ).toContain("Set for this workspace, Norwegian");
  });

  test("sends the host's voice settings with the language the person picked on top", async () => {
    localStorage.removeItem("opengeni:realtime-language");
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => ({
        models: [
          {
            id: "workspace-elevenlabs/eleven_realtime_v1_max",
            label: "Eleven Realtime v1 max",
            provider: "Your ElevenLabs",
            description: "Reasons before replying; best at handing off work",
            available: true,
            unavailableReason: null,
            recommended: true,
            languages: ["en", "no", "sv"],
            customVoice: true,
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
        ],
      }),
    } as unknown as OpenGeniClient;
    const hostSettings = { voice: "library-voice-id", language: "no" };
    let selection: ReturnType<typeof useRealtimeModelSelection> | null = null;
    let setLanguage: ((language: string | null) => void) | null = null;
    function Harness() {
      setLanguage = useRealtimeLanguagePreference().setLanguage;
      selection = useRealtimeModelSelection({
        client,
        workspaceId: "11111111-1111-4111-8111-111111111112",
        codexConnected: false,
      });
      return <output>{selection.models.length}</output>;
    }
    await act(async () =>
      root.render(
        <OpenGeniMessagesProvider locale="nb-NO">
          <Harness />
        </OpenGeniMessagesProvider>,
      ),
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      if (container.textContent === "2") break;
    }
    const eleven = "workspace-elevenlabs/eleven_realtime_v1_max" as const;
    const gateway = "workspace-gateway/openai/gpt-realtime-mini" as const;
    // The person's own language is the fallback under the host's and workspace's.
    expect(selection!.languageFor(eleven)).toBe("nb-NO");
    expect(selection!.languageFor(gateway)).toBeUndefined();
    expect(selection!.voiceSettingsFor(eleven, hostSettings)).toEqual(hostSettings);

    // The language the person picks in the voice menu wins over the host's.
    await act(async () => setLanguage!("sv"));
    expect(selection!.voiceSettingsFor(eleven, hostSettings)).toEqual({
      voice: "library-voice-id",
      language: "sv",
    });
    expect(selection!.languageFor(eleven)).toBe("nb-NO");
    // A model that detects the language itself keeps the host's settings as they are.
    expect(selection!.voiceSettingsFor(gateway, hostSettings)).toEqual(hostSettings);
    await act(async () => setLanguage!(null));
  });

  test("loads and selects a connected SuperGrok realtime model", async () => {
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => ({
        models: [
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
            id: "supergrok/grok-voice-think-fast-2.0",
            label: "Grok Voice",
            provider: "Connected SuperGrok",
            description: "Fast native Grok speech-to-speech",
            available: true,
            unavailableReason: null,
            recommended: true,
          },
        ],
      }),
    } as unknown as OpenGeniClient;

    function Harness() {
      const selection = useRealtimeModelSelection({
        client,
        workspaceId: "11111111-1111-4111-8111-111111111111",
        codexConnected: true,
      });
      return (
        <div>
          <output data-testid="selected-realtime-model">{selection.selectedModel.id}</output>
          {selection.models.map((model) => (
            <button key={model.id} type="button" onClick={() => selection.selectModel(model.id)}>
              {model.provider}: {model.label}
            </button>
          ))}
        </div>
      );
    }

    await act(async () => root.render(<Harness />));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      if (container.textContent?.includes("Connected SuperGrok")) break;
    }

    const grok = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Connected SuperGrok"),
    );
    expect(grok).not.toBeUndefined();
    await act(async () => grok?.click());
    expect(container.querySelector('[data-testid="selected-realtime-model"]')?.textContent).toBe(
      "supergrok/grok-voice-think-fast-2.0",
    );
    expect(
      localStorage.getItem("opengeni:realtime-model:11111111-1111-4111-8111-111111111111"),
    ).toBe("supergrok/grok-voice-think-fast-2.0");
  });

  test("defaults to the first available voice model, else the one the user can act on, never an unrelated Connect Codex", async () => {
    const codex = {
      id: "gpt-live-1-boulder-alpha" as const,
      label: "Codex Live",
      provider: "Connected Codex" as const,
      description: "Deep session integration",
      available: false,
      unavailableReason: "Connect Codex to use this voice model",
      recommended: false,
    };
    const gptLive = (available: boolean) => ({
      id: "opengeni-azure/gpt-live-1" as const,
      label: "GPT Live 1",
      provider: "OpenGeni" as const,
      description: "Realtime voice with session delegation",
      available,
      unavailableReason: available
        ? null
        : "Promotional credits don't cover live voice. Add credits to use it.",
      unavailableCode: available ? null : "insufficient_credits",
      recommended: true,
    });
    const cases = [
      { workspaceId: "88888888-8888-4888-8888-888888888881", models: [codex, gptLive(true)] },
      { workspaceId: "88888888-8888-4888-8888-888888888882", models: [codex, gptLive(false)] },
    ];
    for (const { workspaceId, models } of cases) {
      const client = {
        getWorkspaceRealtimeModelCatalog: async () => ({ models }),
      } as unknown as OpenGeniClient;
      function Selection() {
        const selection = useRealtimeModelSelection({ client, workspaceId, codexConnected: false });
        return (
          <output>
            {selection.selectedModel.id}|{String(selection.selectedModel.available)}|
            {selection.models.length}
          </output>
        );
      }
      await act(async () => root.render(<Selection key={workspaceId} />));
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      const [id, available, count] = (container.querySelector("output")?.textContent ?? "").split(
        "|",
      );
      expect(id).toBe("opengeni-azure/gpt-live-1");
      expect(available).toBe(String(models[1]!.available));
      // Unavailable models stay listed with their reason.
      expect(count).toBe("2");
    }
  });

  test("deduplicates catalog loads and reuses the settled catalog across remounts", async () => {
    const workspaceId = "66666666-6666-4666-8666-666666666666";
    let requests = 0;
    const now = spyOn(Date, "now").mockReturnValue(1_000_000);
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => {
        requests += 1;
        return {
          models: [
            {
              id: "supergrok/grok-voice-think-fast-2.0" as const,
              label: "Grok Voice",
              provider: "Connected SuperGrok" as const,
              description: "Fast native Grok speech-to-speech",
              available: true,
              unavailableReason: null,
              recommended: true,
            },
          ],
        };
      },
    } as unknown as OpenGeniClient;

    function Selection() {
      const selection = useRealtimeModelSelection({ client, workspaceId, codexConnected: false });
      return <output>{selection.selectedModel.label}</output>;
    }

    try {
      for (let episode = 0; episode < 25; episode += 1) {
        await act(async () => root.render(<Selection key={episode} />));
        await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
        expect(container.querySelector("output")?.textContent).toBe("Grok Voice");
      }
      expect(requests).toBe(1);

      now.mockReturnValue(1_060_001);
      await act(async () => root.render(<Selection key="expired" />));
      await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
      expect(requests).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  test("shares an in-flight catalog load between concurrent controls", async () => {
    const workspaceId = "77777777-7777-4777-8777-777777777777";
    let requests = 0;
    let resolveCatalog!: (value: {
      models: Array<{
        id: "gpt-live-1-boulder-alpha";
        label: string;
        provider: "Connected Codex";
        description: string;
        available: boolean;
        unavailableReason: null;
        recommended: boolean;
      }>;
    }) => void;
    const response = new Promise<Parameters<typeof resolveCatalog>[0]>((resolve) => {
      resolveCatalog = resolve;
    });
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => {
        requests += 1;
        return await response;
      },
    } as unknown as OpenGeniClient;

    function Selection() {
      const selection = useRealtimeModelSelection({ client, workspaceId, codexConnected: true });
      return <output>{selection.selectedModel.label}</output>;
    }

    await act(async () =>
      root.render(
        <>
          <Selection />
          <Selection />
        </>,
      ),
    );
    expect(requests).toBe(1);
    await act(async () => {
      resolveCatalog({
        models: [
          {
            id: "gpt-live-1-boulder-alpha",
            label: "Codex Live",
            provider: "Connected Codex",
            description: "Deep session integration",
            available: true,
            unavailableReason: null,
            recommended: false,
          },
        ],
      });
      await response;
    });
    expect(container.querySelectorAll("output")).toHaveLength(2);
    expect(requests).toBe(1);
  });

  test("reports the catalog ready only once the real catalog has loaded", async () => {
    const workspaceId = "88888888-8888-4888-8888-888888888888";
    let resolveCatalog!: (value: { models: unknown[] }) => void;
    const response = new Promise<{ models: unknown[] }>((resolve) => {
      resolveCatalog = resolve;
    });
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => await response,
    } as unknown as OpenGeniClient;

    function Selection() {
      const selection = useRealtimeModelSelection({ client, workspaceId, codexConnected: false });
      return <output>{String(selection.catalogReady)}</output>;
    }

    await act(async () => root.render(<Selection />));
    expect(container.querySelector("output")?.textContent).toBe("false");
    await act(async () => {
      resolveCatalog({
        models: [
          {
            id: "gpt-live-1-boulder-alpha",
            label: "Codex Live",
            provider: "Connected Codex",
            description: "Deep session integration",
            available: false,
            unavailableReason: "Connect Codex",
            recommended: false,
          },
        ],
      });
      await response;
    });
    expect(container.querySelector("output")?.textContent).toBe("true");
  });

  test("treats the fallback as final when the catalog cannot load", async () => {
    const workspaceId = "66666666-6666-4666-8666-666666666666";
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => {
        throw new Error("catalog unavailable");
      },
    } as unknown as OpenGeniClient;

    function Selection() {
      const selection = useRealtimeModelSelection({ client, workspaceId, codexConnected: false });
      return <output>{String(selection.catalogReady)}</output>;
    }

    await act(async () => root.render(<Selection />));
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.querySelector("output")?.textContent).toBe("true");
  });

  test("aborts a shared catalog read only after its final mounted consumer leaves", async () => {
    const workspaceId = "99999999-9999-4999-8999-999999999999";
    const nativeSignals: AbortSignal[] = [];
    const client = {
      getWorkspaceRealtimeModelCatalog: async (
        _workspaceId: string,
        options?: { signal?: AbortSignal },
      ) => {
        const nativeSignal = options?.signal;
        if (nativeSignal) nativeSignals.push(nativeSignal);
        return await new Promise((_resolve, reject) => {
          nativeSignal?.addEventListener(
            "abort",
            () => reject(nativeSignal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    } as unknown as OpenGeniClient;

    function Selection() {
      useRealtimeModelSelection({ client, workspaceId, codexConnected: true });
      return null;
    }

    await act(async () =>
      root.render(
        <>
          <Selection key="first" />
          <Selection key="second" />
        </>,
      ),
    );
    expect(nativeSignals).toHaveLength(1);
    expect(nativeSignals[0]?.aborted).toBe(false);

    await act(async () => root.render(<Selection key="second" />));
    expect(nativeSignals[0]?.aborted).toBe(false);

    await act(async () => root.render(null));
    expect(nativeSignals[0]?.aborted).toBe(true);

    await act(async () => root.render(<Selection key="retry" />));
    expect(nativeSignals).toHaveLength(2);
    expect(nativeSignals[1]?.aborted).toBe(false);
    await act(async () => root.render(null));
  });

  test("does not cache a failed catalog load", async () => {
    const workspaceId = "88888888-8888-4888-8888-888888888888";
    let requests = 0;
    const client = {
      getWorkspaceRealtimeModelCatalog: async () => {
        requests += 1;
        if (requests === 1) throw new Error("catalog temporarily unavailable");
        return {
          models: [
            {
              id: "gpt-live-1-boulder-alpha" as const,
              label: "Codex Live",
              provider: "Connected Codex" as const,
              description: "Deep session integration",
              available: true,
              unavailableReason: null,
              recommended: false,
            },
          ],
        };
      },
    } as unknown as OpenGeniClient;

    function Selection() {
      const selection = useRealtimeModelSelection({ client, workspaceId, codexConnected: true });
      return <output>{selection.selectedModel.label}</output>;
    }

    await act(async () => root.render(<Selection key="failed" />));
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(requests).toBe(1);
    await act(async () => root.render(<Selection key="retry" />));
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));
    expect(requests).toBe(2);
    expect(container.querySelector("output")?.textContent).toBe("Codex Live");
  });

  test("configures the voice model picker below the new-session composer", async () => {
    await act(async () => {
      root.render(
        <RealtimeVoiceControl
          snapshot={idle}
          canStart={true}
          modelAvailable={true}
          menuSide="bottom"
          audioRef={createRef<HTMLAudioElement>()}
          onStart={async () => undefined}
          onStop={async () => undefined}
          onRetry={async () => undefined}
          onRetryAudibleOutput={async () => undefined}
          onSetInputMuted={() => undefined}
          onSetOutputMuted={() => undefined}
        />,
      );
    });

    expect(
      container
        .querySelector('[role="group"][aria-label="Realtime voice"]')
        ?.getAttribute("data-picker-side"),
    ).toBe("bottom");
    expect(container.textContent).not.toContain("Realtime diagnostics");
  });

  test("exposes an autoplay-blocked retry without starting another realtime call", async () => {
    const calls: string[] = [];
    await act(async () => {
      root.render(
        <RealtimeVoiceControl
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
          onSetInputMuted={() => undefined}
          onSetOutputMuted={() => undefined}
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
    expect(container.querySelector('button[aria-label="Start voice"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Resume voice audio"]')).not.toBeNull();
  });

  test("names the voice action without the model, and a host can name it", async () => {
    const render = async (messages?: Record<string, string>) =>
      await act(async () => {
        root.render(
          <OpenGeniMessagesProvider messages={messages}>
            <RealtimeVoiceControl
              snapshot={idle}
              canStart={true}
              modelAvailable={true}
              audioRef={createRef<HTMLAudioElement>()}
              onStart={async () => undefined}
              onStop={async () => undefined}
              onRetry={async () => undefined}
              onRetryAudibleOutput={async () => undefined}
              onSetInputMuted={() => undefined}
              onSetOutputMuted={() => undefined}
            />
          </OpenGeniMessagesProvider>,
        );
      });
    const primary = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="realtime-primary-action"]');
    const status = () => container.querySelector('[role="status"]')?.textContent ?? "";

    await render();
    expect(primary()?.getAttribute("aria-label")).toBe("Start voice");
    expect(status()).toContain("Talk live with the agent.");
    expect(status()).not.toContain("Codex Live");

    await render({
      "realtime.realtimeControl.startVoice": "Talk to Ava",
      "realtime.realtimeControl.talkLiveWithTheAgent": "Ava answers out loud.",
    });
    expect(primary()?.getAttribute("aria-label")).toBe("Talk to Ava");
    expect(status()).toContain("Talk to Ava");
    expect(status()).toContain("Ava answers out loud.");
  });

  test("shows why a voice start failed until the user dismisses or retries it", async () => {
    const calls: string[] = [];
    const failed: SessionRealtimeControllerSnapshot = {
      ...idle,
      status: "error",
      error: "Voice is temporarily unavailable. Try another voice model.",
    };
    const render = async (snapshot: SessionRealtimeControllerSnapshot) =>
      await act(async () => {
        root.render(
          <RealtimeVoiceControl
            snapshot={snapshot}
            canStart={true}
            modelAvailable={true}
            audioRef={createRef<HTMLAudioElement>()}
            onStart={async () => {
              calls.push("start");
            }}
            onStop={async () => undefined}
            onRetry={async () => undefined}
            onRetryAudibleOutput={async () => undefined}
            onSetInputMuted={() => undefined}
            onSetOutputMuted={() => undefined}
          />,
        );
      });
    await render(failed);

    const reason = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="realtime-failure-reason"]');
    // Visible text, not only a tooltip or the model menu.
    expect(reason()?.textContent).toBe(
      "Voice is temporarily unavailable. Try another voice model.",
    );
    const start = container.querySelector<HTMLButtonElement>(
      '[data-testid="realtime-primary-action"]',
    );
    expect(start?.getAttribute("aria-label")).toBe("Try voice again");
    await act(async () => start?.click());
    expect(calls).toEqual(["start"]);

    await act(async () => reason()?.click());
    expect(reason()).toBeNull();

    // A new failure after another attempt is shown again.
    await render({ ...idle, status: "starting" });
    await render(failed);
    expect(reason()).not.toBeNull();
    await render(idle);
    expect(reason()).toBeNull();
  });

  test("starting dictation in the same composer retires a stale start failure", async () => {
    await act(async () => {
      root.render(
        <div className="og-composer">
          <RealtimeVoiceControl
            snapshot={{ ...idle, status: "error", error: "Microphone access is blocked." }}
            canStart={true}
            modelAvailable={true}
            audioRef={createRef<HTMLAudioElement>()}
            onStart={async () => undefined}
            onStop={async () => undefined}
            onRetry={async () => undefined}
            onRetryAudibleOutput={async () => undefined}
            onSetInputMuted={() => undefined}
            onSetOutputMuted={() => undefined}
          />
        </div>,
      );
    });
    const reason = () => container.querySelector('[data-testid="realtime-failure-reason"]');
    expect(reason()).not.toBeNull();
    await act(async () => {
      container
        .querySelector(".og-composer")
        ?.dispatchEvent(new Event("opengeni:composer-voice-input-start"));
    });
    expect(reason()).toBeNull();
  });

  test("keeps an unavailable provider quiet and explains why start is disabled", async () => {
    await act(async () => {
      root.render(
        <RealtimeVoiceControl
          snapshot={idle}
          canStart={false}
          admissionBlocker="Connect Codex to use this voice model."
          modelAvailable={false}
          audioRef={createRef<HTMLAudioElement>()}
          onStart={async () => undefined}
          onStop={async () => undefined}
          onRetry={async () => undefined}
          onRetryAudibleOutput={async () => undefined}
          onSetInputMuted={() => undefined}
          onSetOutputMuted={() => undefined}
        />,
      );
    });

    const start = container.querySelector<HTMLButtonElement>(
      '[data-testid="realtime-primary-action"]',
    );
    expect(start?.dataset.phase).toBe("unavailable");
    expect(start?.disabled).toBe(true);
    // The disabled control names its blocker instead of offering to start.
    expect(start?.getAttribute("aria-label")).toBe(
      "Voice model unavailable: Connect Codex to use this voice model.",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Voice model unavailable",
    );
  });
});
