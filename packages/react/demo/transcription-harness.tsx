import type { ClientVoiceInputConfig, EffectiveSessionControl } from "@opengeni/sdk";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatComposer, type ComposerState } from "@opengeni/react";
import "./styles.css";

type FixtureMode = "normal" | "denied" | "hanging";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const requestedMode = params.get("mode");
const crowdedChrome = params.get("chrome") === "crowded";
const initialMode: FixtureMode =
  requestedMode === "denied" || requestedMode === "hanging" ? requestedMode : "normal";
if (theme === "light") document.documentElement.dataset.ogTheme = "light";
else delete document.documentElement.dataset.ogTheme;

const capability: ClientVoiceInputConfig = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"],
};

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

class FixtureMediaRecorder {
  static isTypeSupported(type: string) {
    return (
      type.startsWith("audio/webm") || type.startsWith("audio/mp4") || type.startsWith("audio/ogg")
    );
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    options?: MediaRecorderOptions,
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
  }
  start(timeslice?: number) {
    this.state = "recording";
    document.documentElement.dataset.transcriptionStatus = "recording";
    document.documentElement.dataset.transcriptionTimeslice = String(timeslice ?? 0);
    setTimeout(() => {
      if (this.state !== "recording") return;
      this.ondataavailable?.({
        data: new Blob([new Uint8Array([9, 8, 7, 6])], { type: this.mimeType }),
        timecode: timeslice ?? 5_000,
      } as BlobEvent);
      document.documentElement.dataset.transcriptionChunkEmitted = "true";
    }, 0);
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array([1, 2, 3, 4])], { type: this.mimeType }),
    } as BlobEvent);
    this.onstop?.();
  }
}

function installBrowserFixtures(mode: FixtureMode) {
  const track = {
    stop() {
      document.documentElement.dataset.transcriptionTracksStopped = "true";
    },
  };
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia:
        mode === "denied"
          ? async () => {
              throw new DOMException("Permission denied", "NotAllowedError");
            }
          : async () => {
              const requests = Number(
                document.documentElement.dataset.transcriptionMicRequests ?? "0",
              );
              document.documentElement.dataset.transcriptionMicRequests = String(requests + 1);
              return {
                getTracks: () => [track],
              } as unknown as MediaStream;
            },
    },
  });
  Object.defineProperty(window, "MediaRecorder", {
    configurable: true,
    value: FixtureMediaRecorder,
  });
}

function createFixtureClient(mode: FixtureMode) {
  return {
    async transcribeAudio(
      _workspaceId: string,
      input: { signal?: AbortSignal | undefined },
    ): Promise<{ text: string; languages: string[] }> {
      document.documentElement.dataset.transcriptionUpload = "started";
      if (mode === "hanging") {
        await new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(input.signal?.reason ?? new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      document.documentElement.dataset.transcriptionUpload = "completed";
      return { text: "fixture transcript", languages: ["en"] };
    },
  };
}

function App() {
  const [value, setValue] = useState("Existing editable draft");
  const [sent, setSent] = useState<string | null>(null);
  const [mode] = useState<FixtureMode>(initialMode);
  const client = useMemo(() => createFixtureClient(mode), [mode]);
  useMemo(() => {
    installBrowserFixtures(mode);
    return null;
  }, [mode]);

  const composer: ComposerState = {
    value,
    setValue,
    hasDraftContent: () => value.trim().length > 0,
    send: async () => {
      setSent(value);
      document.documentElement.dataset.transcriptionSubmitted = value;
      return true;
    },
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
  };

  return (
    <main
      data-transcription-harness
      className="mx-auto flex min-h-screen max-w-3xl flex-col justify-end gap-4 p-4"
    >
      <h1 className="text-og-sm font-medium text-og-fg">Voice input fixture</h1>
      <p className="text-og-xs text-og-fg-muted">
        Mode <code>{mode}</code>. Stop records and immediately uploads a transcription.
      </p>
      {sent ? <p>Sent: {sent}</p> : null}
      <ChatComposer
        composer={composer}
        effectiveControl={crowdedChrome ? activeControl : undefined}
        transcription={{
          client: client as never,
          workspaceId: "11111111-1111-4111-8111-111111111111",
          capability,
          workspaceEnabled: true,
        }}
        controlsLeading={
          crowdedChrome ? (
            <button
              type="button"
              aria-label="Open composer tools"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-og-md border border-og-border pointer-coarse:size-11"
            >
              +
            </button>
          ) : undefined
        }
        controlsStart={
          crowdedChrome ? (
            <button
              type="button"
              aria-label="Model and effort"
              className="inline-flex h-8 min-w-24 shrink-0 items-center justify-center rounded-og-md border border-og-border px-2 text-og-xs pointer-coarse:h-11"
            >
              Model
            </button>
          ) : undefined
        }
        actionsStart={
          crowdedChrome ? (
            <button
              type="button"
              aria-label="Start realtime voice"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-og-md border border-og-border pointer-coarse:size-11"
            >
              R
            </button>
          ) : undefined
        }
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
