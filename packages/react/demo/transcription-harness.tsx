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
// `basis=container` mirrors the embedded OpenGeniChat composer.
const responsiveBasis = params.get("basis") === "container" ? "container" : undefined;
const initialMode: FixtureMode =
  requestedMode === "denied" || requestedMode === "hanging" ? requestedMode : "normal";
if (theme === "light") document.documentElement.dataset.ogTheme = "light";
else delete document.documentElement.dataset.ogTheme;

const capability: ClientVoiceInputConfig = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"],
  // The deployment keeps dictations: each one is a recording until its text is in the draft.
  resumable: {
    maxDurationSeconds: 2 * 60 * 60,
    maxSizeBytes: 512 * 1024 * 1024,
    maxChunkSizeBytes: 8 * 1024 * 1024,
    providerSegmentSeconds: 50,
  },
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

/** A real microphone-like stream: a quiet tone, so the browser's own MediaRecorder records it. */
function toneStream(): MediaStream {
  const context = new AudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.05;
  const destination = context.createMediaStreamDestination();
  oscillator.connect(gain).connect(destination);
  oscillator.start();
  for (const track of destination.stream.getTracks()) {
    const stop = track.stop.bind(track);
    track.stop = () => {
      document.documentElement.dataset.transcriptionTracksStopped = "true";
      stop();
    };
  }
  return destination.stream;
}

function installBrowserFixtures(mode: FixtureMode) {
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
              return toneStream();
            },
    },
  });
}

type FixtureVersion = {
  id: string;
  recordingId: string;
  versionNumber: number;
  state: "running" | "complete";
  errorCode: null;
  createdAt: string;
};
type FixtureRecording = { id: string; state: string; version: FixtureVersion | null };

/**
 * The deployment's recordings API, kept in localStorage so it survives a
 * reload like a real server. Uploads are acknowledged as already stored, and
 * a finalized dictation is heard at once, or never in `hanging` mode.
 */
function createFixtureServer(mode: FixtureMode) {
  const key = "opengeni.transcription-fixture.server";
  const read = (): Record<string, FixtureRecording> => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, FixtureRecording>;
    } catch {
      return {};
    }
  };
  const write = (recordings: Record<string, FixtureRecording>) =>
    localStorage.setItem(key, JSON.stringify(recordings));
  const recordingView = (recording: FixtureRecording) => ({
    id: recording.id,
    workspaceId: "11111111-1111-4111-8111-111111111111",
    purpose: "dictation",
    state: recording.state,
    errorCode: null,
    transcript: recording.version,
    tracks: [],
  });
  const gone = () =>
    Object.assign(new Error("Recording not found."), { status: 404, code: "not_found" });
  return async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const [, recordingId, rest = ""] =
      path.match(/\/recordings(?:\/([^/]+))?(\/.*)?$/u) ?? ([] as string[]);
    const recordings = read();
    const recording = recordingId ? recordings[recordingId] : undefined;
    if (method === "GET" && !recordingId) {
      return {
        recordings: Object.values(recordings).map(recordingView),
        nextBefore: null,
      };
    }
    if (method === "POST" && !recordingId) {
      const id = (body as { recordingId: string }).recordingId;
      recordings[id] = recordings[id] ?? { id, state: "capturing", version: null };
      write(recordings);
      return recordingView(recordings[id]);
    }
    if (!recording) throw gone();
    if (method === "POST" && rest === "/uploads") {
      document.documentElement.dataset.transcriptionChunkEmitted = "true";
      const chunks = (body as { chunks: Array<{ chunkNumber: number }> }).chunks;
      return {
        uploads: chunks.map((chunk) => ({
          chunkNumber: chunk.chunkNumber,
          uploaded: true,
          url: null,
          method: "PUT",
          headers: {},
          expiresAt: null,
        })),
      };
    }
    if (method === "POST" && rest === "/chunks/complete") {
      return { uploaded: (body as { chunkNumbers: number[] }).chunkNumbers, missing: [] };
    }
    if (method === "POST" && rest === "/finalize") {
      document.documentElement.dataset.transcriptionUpload = "started";
      const heard = mode !== "hanging";
      recording.state = heard ? "ready" : "processing";
      recording.version = {
        id: `${recording.id}-v1`,
        recordingId: recording.id,
        versionNumber: 1,
        state: heard ? "complete" : "running",
        errorCode: null,
        createdAt: new Date().toISOString(),
      };
      write(recordings);
      return { recording: recordingView(recording), transcript: recording.version };
    }
    if (method === "GET" && rest === "/transcripts") {
      return { versions: recording.version ? [recording.version] : [] };
    }
    if (method === "GET" && rest === "/transcript") {
      document.documentElement.dataset.transcriptionUpload = "completed";
      return {
        version: recording.version,
        speakers: [],
        segments: [{ index: 0, text: "fixture transcript" }],
        nextAfter: null,
      };
    }
    if (method === "DELETE" && rest === "") {
      delete recordings[recording.id];
      write(recordings);
      return undefined;
    }
    throw new Error(`The fixture server has no ${method} ${path}.`);
  };
}

function createFixtureClient(mode: FixtureMode) {
  const server = createFixtureServer(mode);
  return {
    requestJson: async (method: string, path: string, body?: unknown) =>
      await server(method, path, body),
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
        responsiveBasis={responsiveBasis}
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
