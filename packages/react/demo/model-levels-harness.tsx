import type { ClientModel, LatencyMode, ReasoningEffort } from "@opengeni/sdk";
import {
  ChatComposer,
  ComposerModelPicker,
  type ComposerState,
  type ModelLevel,
} from "@opengeni/react";
import { createRoot } from "react-dom/client";
import { useMemo, useState, type ReactNode } from "react";

import "./styles.css";

const params = new URLSearchParams(window.location.search);

type Preset = "two" | "three" | "everywhere" | "full";
const PRESETS: { id: Preset; label: string; how: string }[] = [
  {
    id: "two",
    label: "2 levels",
    how: "Tap or swipe the name. On Thorough, hold the pill (or push past the end) until the bolt fills, then let go.",
  },
  {
    id: "three",
    label: "3 levels",
    how: "Three levels; Ultrafast only on Thorough.",
  },
  {
    id: "everywhere",
    label: "Ultrafast on every level",
    how: "Every level allows Ultrafast: hold the pill on any of them.",
  },
  {
    id: "full",
    label: "Full picker",
    how: "What a host gets when it passes no levels: today's picker, unchanged.",
  },
];

const STANDARD: ModelLevel = {
  id: "standard",
  label: "Standard",
  model: "example/everyday",
  effort: "high",
};
const THOROUGH: ModelLevel = {
  id: "thorough",
  label: "Thorough",
  model: "example/deep",
  effort: "high",
  ultrafast: true,
};
const QUICK: ModelLevel = { id: "quick", label: "Quick", model: "example/small", effort: "low" };
const LEVELS: Record<Preset, ModelLevel[] | undefined> = {
  two: [STANDARD, THOROUGH],
  three: [QUICK, STANDARD, THOROUGH],
  everywhere: [{ ...QUICK, ultrafast: true }, { ...STANDARD, ultrafast: true }, THOROUGH],
  full: undefined,
};

const capabilities = (ultrafast: boolean): ClientModel["capabilities"] => ({
  reasoning: {
    upstream: "supported",
    runnable: true,
    efforts: ["low", "medium", "high", "xhigh"],
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
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  transports: {
    sse: { upstream: "supported", runnable: true },
    responsesWebSocket: { upstream: "unsupported", runnable: false },
    realtimeAudio: { upstream: "unsupported", runnable: false },
  },
  latencyModes: [
    { id: "standard", upstream: "supported", runnable: true },
    { id: "fast", upstream: "supported", runnable: true },
    ...(ultrafast
      ? [{ id: "ultrafast" as const, upstream: "supported" as const, runnable: true }]
      : []),
  ],
});

const models: ClientModel[] = [
  ["example/everyday", "Everyday Model", "Everyday", true],
  ["example/deep", "Deep Model", "Deep", true],
  ["example/small", "Small Model", "Small", true],
  ["example/other", "Other Model", "Other", false],
].map(([id, label, shortLabel, ultrafast]) => ({
  id: id as string,
  label: label as string,
  shortLabel: shortLabel as string,
  provider: "codex",
  providerLabel: "Codex",
  source: "codex",
  api: "responses",
  capabilities: capabilities(ultrafast as boolean),
}));

function useComposerState(): ComposerState {
  const [value, setValue] = useState("");
  return useMemo<ComposerState>(
    () => ({
      value,
      setValue,
      hasDraftContent: () => value.trim().length > 0,
      send: async () => true,
      steer: async () => true,
      sending: false,
      canSend: value.trim().length > 0,
      pause: async () => {},
      pausing: false,
      resume: async () => {},
      resumeScope: async () => {},
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
}

function Toggle(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      className={[
        "rounded-full border px-3 py-1 text-og-xs transition-colors",
        props.active
          ? "border-og-fg/40 bg-og-surface-2 text-og-fg"
          : "border-og-border text-og-fg-muted hover:text-og-fg",
      ].join(" ")}
    >
      {props.children}
    </button>
  );
}

function Harness() {
  const initialPreset = (params.get("preset") as Preset | null) ?? "two";
  const [preset, setPreset] = useState<Preset>(initialPreset);
  const [theme, setTheme] = useState(params.get("theme") === "light" ? "light" : "dark");
  const [phone, setPhone] = useState(params.get("phone") === "1");
  const [model, setModel] = useState(
    params.get("model") ??
      (params.get("custom") === "1"
        ? "example/other"
        : params.get("level") === "1"
          ? "example/deep"
          : "example/everyday"),
  );
  const [effort, setEffort] = useState<ReasoningEffort>(
    params.get("custom") === "1" ? "medium" : "high",
  );
  const [latencyMode, setLatencyMode] = useState<LatencyMode>(
    params.get("ultrafast") === "1" ? "ultrafast" : "standard",
  );
  const composer = useComposerState();
  const clean = params.get("clean") === "1";
  const how = PRESETS.find((p) => p.id === preset)!.how;

  return (
    <main
      data-og-theme={theme}
      className={[
        "og-root flex min-h-dvh flex-col items-center bg-og-bg px-4 text-og-fg",
        clean ? "pt-5" : "pb-16 pt-10",
      ].join(" ")}
    >
      <div className={clean ? "hidden" : "flex w-full max-w-[680px] flex-col gap-3"}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Host levels">
          {PRESETS.map((p) => (
            <Toggle key={p.id} active={preset === p.id} onClick={() => setPreset(p.id)}>
              {p.label}
            </Toggle>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="State">
          <Toggle
            active={model === "example/other"}
            onClick={() => {
              setModel(model === "example/other" ? "example/everyday" : "example/other");
              setEffort(model === "example/other" ? "high" : "medium");
              setLatencyMode("standard");
            }}
          >
            Chat on another model
          </Toggle>
          <Toggle active={phone} onClick={() => setPhone(!phone)}>
            Phone width
          </Toggle>
          <Toggle
            active={theme === "light"}
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          >
            Light
          </Toggle>
        </div>
        <p className="min-h-10 text-og-sm text-og-fg-muted" aria-live="polite">
          {how}
        </p>
      </div>
      <div
        className={clean ? "w-full" : "mt-[22vh] w-full transition-[max-width] duration-300"}
        style={{ maxWidth: phone ? 390 : 680 }}
      >
        <div className="mb-4 flex justify-end">
          <div className="max-w-[80%] rounded-og-xl bg-og-surface-2 px-4 py-2.5 text-og-md">
            Can you go through last week's change log and tell me what broke the import?
          </div>
        </div>
        <ChatComposer
          composer={composer}
          responsiveBasis="container"
          placeholder="Reply…"
          transcription={{}}
          controlsStart={
            <ComposerModelPicker
              levels={LEVELS[preset]}
              models={models}
              model={model}
              effort={effort}
              latencyMode={latencyMode}
              onModelChange={setModel}
              onEffortChange={setEffort}
              onLatencyModeChange={setLatencyMode}
            />
          }
        />
        <p
          className="mt-3 text-center text-og-xs text-og-fg-subtle tabular-nums"
          aria-live="polite"
        >
          {`${model} · ${effort} · ${latencyMode}`}
        </p>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
