import type { ClientModel, EffectiveSessionControl } from "@opengeni/sdk";
import type { SessionRealtimeControllerSnapshot } from "@opengeni/sdk/realtime";
import { ChatComposer, ModelPolicyPicker, type ComposerState } from "@opengeni/react";
import { RealtimeVoiceControl, type RealtimeModelOption } from "@opengeni/react/realtime";
import { createRoot } from "react-dom/client";
import { useMemo, useRef, useState } from "react";

import type { SlashCommand } from "../src/commands/types";
import { MANAGER_SESSION_ID, MockOpenGeniClient } from "./mock";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const initialWidth = Number(params.get("width") ?? 320);
const initialDensity = params.get("density") === "compact" ? "compact" : "default";
const initialTheme = params.get("theme") === "light" ? "light" : "dark";
const initialVoiceActive = params.get("voice") === "active";
const widths = [280, 320, 360, 420, 640, 768] as const;
const client = new MockOpenGeniClient();

const commands: readonly SlashCommand[] = [
  {
    name: "help",
    description: "Show every command available in this embedded composer",
    run: () => ({ status: "ok" }),
  },
  {
    name: "status",
    description: "Inspect the current workstream status and recent activity",
    run: () => ({ status: "ok" }),
  },
];

const models: ClientModel[] = [
  {
    id: "codex/gpt-5.6-container-responsive-example",
    label: "GPT-5.6 Container Responsive Example",
    shortLabel: "5.6 Example",
    provider: "codex",
    providerLabel: "Codex",
    source: "codex",
    api: "responses",
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium", "high"],
        defaultEffort: "medium",
        required: false,
      },
      functionCalling: { upstream: "supported", runnable: true },
      structuredOutput: { upstream: "supported", runnable: true },
      hostedTools: {
        webSearch: { upstream: "unsupported", runnable: false },
        xSearch: { upstream: "unsupported", runnable: false },
        codeExecution: { upstream: "unsupported", runnable: false },
      },
      inputModalities: ["text"],
      outputModalities: ["text"],
      transports: {
        sse: { upstream: "supported", runnable: true },
        responsesWebSocket: { upstream: "unsupported", runnable: false },
        realtimeAudio: { upstream: "unsupported", runnable: false },
      },
      latencyModes: [
        { id: "standard", upstream: "supported", runnable: true },
        { id: "fast", upstream: "supported", runnable: true },
      ],
    },
  },
];

const realtimeModels: RealtimeModelOption[] = [
  {
    id: "gpt-live-1-boulder-alpha",
    label: "Codex Live With A Long Descriptive Name",
    provider: "Connected Codex",
    description: "Deep session integration",
    available: true,
    unavailableReason: null,
    recommended: true,
  },
  {
    id: "opengeni-gateway/openai/gpt-realtime-2.1",
    label: "GPT Realtime 2.1",
    provider: "OpenGeni",
    description: "Managed realtime voice",
    available: true,
    unavailableReason: null,
    recommended: false,
  },
];

const activeControl: EffectiveSessionControl = {
  state: "active",
  controlVersion: 0,
  controlEtag: "active",
  directState: "active",
  primaryBlocker: null,
  additionalBlockerCount: 0,
  blockers: [],
  resumeOptions: [],
  override: null,
  settlement: null,
};

const pausedBlocker = {
  kind: "session" as const,
  sessionId: MANAGER_SESSION_ID,
  displayName: "Parent workstream with a long descriptive title",
  actor: null,
  reason: "Waiting for review",
  changedAt: null,
  revision: 1,
};

const pausedControl: EffectiveSessionControl = {
  ...activeControl,
  state: "paused",
  controlVersion: 1,
  controlEtag: "paused",
  directState: "paused",
  primaryBlocker: pausedBlocker,
  blockers: [pausedBlocker],
  resumeOptions: [
    {
      scope: "selected",
      targetId: MANAGER_SESSION_ID,
      selectedStateAfter: "active",
      impactCopy: "Runs this workstream",
    },
  ],
};

function ResponsiveComposerHarness() {
  const [width, setWidth] = useState(
    widths.includes(initialWidth as (typeof widths)[number]) ? initialWidth : 320,
  );
  const [density, setDensity] = useState(initialDensity);
  const [theme, setTheme] = useState(initialTheme);
  const [paused, setPaused] = useState(params.get("paused") === "1");
  const [voiceActive, setVoiceActive] = useState(initialVoiceActive);
  const [value, setValue] = useState("A long prompt remains editable while the panel resizes.");
  const [model, setModel] = useState(models[0]!.id);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const composer = useMemo<ComposerState>(
    () => ({
      value,
      setValue,
      hasDraftContent: () => value.trim().length > 0,
      send: async () => true,
      steer: async () => true,
      sending: false,
      canSend: value.trim().length > 0,
      pause: async () => setPaused(true),
      pausing: false,
      resume: async () => setPaused(false),
      resumeScope: async () => setPaused(false),
      resuming: false,
      draft: null,
      draftRevision: 0,
      draftLoading: false,
      draftSaving: false,
      draftConflict: null,
      applyDraft: () => {},
      reloadDraft: async () => {},
      resolveDraftConflict: async () => {},
      restoredResources: [],
      removeRestoredResource: () => {},
      error: null,
      clearError: () => {},
    }),
    [value],
  );

  const realtimeSnapshot: SessionRealtimeControllerSnapshot = voiceActive
    ? {
        status: "active",
        realtimeId: "33333333-3333-4333-8333-333333333333",
        mode: {
          id: "33333333-3333-4333-8333-333333333333",
          sessionId: MANAGER_SESSION_ID,
          operationId: "44444444-4444-4444-8444-444444444444",
          browserInstanceId: "55555555-5555-4555-8555-555555555555",
          model: realtimeModels[0]!.id,
          state: "active",
          version: 1,
          connectionEpoch: 1,
          leaseExpiresAt: "2026-08-06T12:00:30.000Z",
          lastHeartbeatAt: "2026-08-06T12:00:00.000Z",
          startedAt: "2026-08-06T12:00:00.000Z",
          endedAt: null,
          endReason: null,
        },
        bridge: null,
        microphone: "active",
        inputMuted: false,
        audibleOutput: "audible",
        outputMuted: false,
        connectionGeneration: 1,
        reconnectAttempt: 0,
        diagnostic: null,
        error: null,
      }
    : {
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

  return (
    <main className="og-root min-h-dvh bg-og-bg p-8 text-og-fg">
      <section className="mx-auto max-w-6xl">
        <h1 className="text-og-md font-semibold">Container-responsive composer matrix</h1>
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Harness controls">
          {widths.map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => setWidth(candidate)}
              className="rounded-og-md border border-og-border px-2 py-1 text-og-xs"
            >
              {candidate}px
            </button>
          ))}
          <button
            type="button"
            onClick={() => setDensity((current) => (current === "compact" ? "default" : "compact"))}
            className="rounded-og-md border border-og-border px-2 py-1 text-og-xs"
          >
            Density: {density}
          </button>
          <button
            type="button"
            onClick={() => setTheme((current) => (current === "light" ? "dark" : "light"))}
            className="rounded-og-md border border-og-border px-2 py-1 text-og-xs"
          >
            Theme: {theme}
          </button>
          <button
            type="button"
            onClick={() => setPaused((current) => !current)}
            className="rounded-og-md border border-og-border px-2 py-1 text-og-xs"
          >
            Paused: {String(paused)}
          </button>
          <button
            type="button"
            onClick={() => setVoiceActive((current) => !current)}
            className="rounded-og-md border border-og-border px-2 py-1 text-og-xs"
          >
            Voice: {voiceActive ? "active" : "idle"}
          </button>
        </div>
        <div className="mt-8 min-h-[30rem] rounded-og-xl border border-dashed border-og-border p-4">
          <div
            data-composer-panel
            data-panel-width={width}
            data-og-theme={theme}
            data-og-density={density === "compact" ? "compact" : undefined}
            className="rounded-og-xl bg-og-surface-1 p-3 shadow-og-lg transition-[width] duration-200"
            style={{ width, maxWidth: "100%" }}
          >
            <ChatComposer
              composer={composer}
              responsiveBasis="container"
              effectiveControl={paused ? pausedControl : activeControl}
              transcription={{}}
              controlsStart={
                <ModelPolicyPicker
                  models={models}
                  model={model}
                  effort="medium"
                  latencyMode="fast"
                  onModelChange={setModel}
                  onEffortChange={() => {}}
                  onLatencyModeChange={() => {}}
                />
              }
              actionsStart={
                <RealtimeVoiceControl
                  snapshot={realtimeSnapshot}
                  canStart={!voiceActive}
                  modelAvailable
                  modelMenu="split"
                  showDiagnostics={false}
                  audioRef={audioRef}
                  selectedModel={realtimeModels[0]}
                  models={realtimeModels}
                  onSelectModel={() => {}}
                  onStart={async () => setVoiceActive(true)}
                  onStop={async () => setVoiceActive(false)}
                  onRetry={async () => {}}
                  onRetryAudibleOutput={async () => {}}
                  onSetInputMuted={() => {}}
                  onSetOutputMuted={() => {}}
                />
              }
              commands={commands}
              commandContext={{
                client,
                workspaceId: "11111111-2222-4333-8444-555555555555",
                sessionId: MANAGER_SESSION_ID,
                status: "idle",
                permissions: [],
              }}
            />
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ResponsiveComposerHarness />);
