// Fakes for dictation tests: the browser's recorder for one-shot dictation,
// and a recordings server and recorder platform for dictations as recordings.
import { expect, mock } from "bun:test";
import {
  createMemoryRecordingChunkStore,
  type Recorder,
  type RecordingChunkStore,
  type RecorderOptions,
  type RecorderPlatform,
  type RecorderSnapshot,
} from "@opengeni/sdk/recordings";
import { act } from "react";
import type { VoiceInputRecordingsClient } from "../src/hooks/use-voice-input";

export const capability = {
  available: true,
  maxDurationSeconds: 60,
  maxSizeBytes: 25 * 1024 * 1024,
  acceptedMimeTypes: ["audio/webm", "audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"],
};

export const resumableCapability = {
  ...capability,
  resumable: {
    maxDurationSeconds: 2 * 60 * 60,
    maxSizeBytes: 512 * 1024 * 1024,
    maxChunkSizeBytes: 8 * 1024 * 1024,
    providerSegmentSeconds: 50,
  },
};

export async function settle(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

/** Let real timers (the transcript poll) run, inside act. */
export async function waitFor(check: () => boolean, timeoutMilliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!check()) {
    if (Date.now() >= deadline) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await settle();
    });
  }
}

// ---------------------------------------------------------------------------
// One-shot dictation: a client with only transcribeAudio records in memory.

export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string) {
    return type.startsWith("audio/webm");
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  startTimeslice: number | undefined;
  bytes = 3;
  private listeners: Array<() => void> = [];
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  constructor(
    readonly stream: MediaStream,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number) {
    this.state = "recording";
    this.startTimeslice = timeslice;
  }
  addEventListener(_type: "stop", listener: () => void) {
    this.listeners.push(listener);
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(this.bytes)], { type: this.mimeType }),
    });
    for (const listener of this.listeners.splice(0)) listener();
  }
}

export function installMediaMocks(options?: { deny?: boolean }) {
  FakeMediaRecorder.instances = [];
  const track = { stop: mock(() => undefined) };
  const getUserMedia = options?.deny
    ? mock(async () => {
        throw new DOMException("Permission denied", "NotAllowedError");
      })
    : mock(async () => ({ getTracks: () => [track] }) as unknown as MediaStream);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  return { track, getUserMedia };
}

// ---------------------------------------------------------------------------
// Durable dictation: a fake recordings server and a fake recorder platform.

export type FakeVersion = {
  id: string;
  state: "queued" | "running" | "complete" | "failed";
  errorCode: string | null;
  createdAt: string;
  text: string;
};
export type FakeRecording = {
  id: string;
  workspaceId: string;
  purpose: string;
  state: "capturing" | "processing" | "ready" | "failed";
  versions: FakeVersion[];
};

export class FakeServer {
  readonly recordings = new Map<string, FakeRecording>();
  readonly created: Array<{ workspaceId: string; request: Record<string, unknown> }> = [];
  readonly deletes: string[] = [];
  readonly transcriptRequests: string[] = [];
  /** What the next version hears; null leaves it running until `complete`. */
  heard: string | null = "hello voice";
  /** Fail the next version with this code instead. */
  failNext: string | null = null;
  /** Deletes fail like this until cleared. */
  deleteFails: "offline" | null = null;
  private versionCount = 0;
  private clock = Date.parse("2026-10-25T08:00:00.000Z");

  seed(input: {
    id: string;
    workspaceId?: string;
    state: FakeRecording["state"];
    text?: string;
    failed?: string;
  }) {
    const recording: FakeRecording = {
      id: input.id,
      workspaceId: input.workspaceId ?? "ws-1",
      purpose: "dictation",
      state: input.state,
      versions: [],
    };
    if (input.state !== "capturing") {
      recording.versions.push(
        this.version(input.failed ? null : (input.text ?? null), input.failed),
      );
    }
    this.recordings.set(input.id, recording);
    return recording;
  }

  version(text: string | null, failed?: string | null): FakeVersion {
    this.versionCount += 1;
    this.clock += 1_000;
    return {
      id: `version-${this.versionCount}`,
      state: failed ? "failed" : text === null ? "running" : "complete",
      errorCode: failed ?? null,
      createdAt: new Date(this.clock).toISOString(),
      text: text ?? "",
    };
  }

  /** Hear the newest running version of a recording now. */
  complete(recordingId: string, text: string) {
    const recording = this.recordings.get(recordingId)!;
    const version = recording.versions.at(-1)!;
    version.state = "complete";
    version.text = text;
    recording.state = "ready";
  }

  /** Called by the fake recorder when its capture is stopped. */
  finalize(recordingId: string) {
    const recording = this.recordings.get(recordingId)!;
    const failed = this.failNext;
    this.failNext = null;
    recording.versions.push(this.version(failed ? null : this.heard, failed));
    recording.state = failed ? "failed" : this.heard === null ? "processing" : "ready";
  }

  readonly client: VoiceInputRecordingsClient = {
    createRecording: async (workspaceId, request) => {
      this.created.push({ workspaceId, request: request as Record<string, unknown> });
      const id = request.recordingId ?? `recording-${this.created.length}`;
      this.seed({ id, workspaceId, state: "capturing" });
      return { id } as never;
    },
    createRecordingUploads: async (_workspaceId, _recordingId, request) =>
      ({
        uploads: request.chunks.map((chunk) => ({
          chunkNumber: chunk.chunkNumber,
          uploaded: true,
          url: null,
          method: "PUT",
          headers: {},
          expiresAt: null,
        })),
      }) as never,
    completeRecordingChunks: async (_workspaceId, _recordingId, request) =>
      ({ uploaded: request.chunkNumbers, missing: [] }) as never,
    finalizeRecording: async (_workspaceId, recordingId) => {
      const recording = this.recordings.get(recordingId);
      if (!recording) throw Object.assign(new Error("gone"), { status: 404 });
      if (recording.state === "capturing") this.finalize(recordingId);
      const version = recording.versions.at(-1)!;
      return { recording: { id: recordingId }, transcript: { ...version } } as never;
    },
    deleteRecording: async (_workspaceId, recordingId) => {
      if (this.deleteFails === "offline") throw new TypeError("Failed to fetch");
      this.deletes.push(recordingId);
      if (!this.recordings.delete(recordingId))
        throw Object.assign(new Error("gone"), { status: 404 });
    },
    listRecordings: async (workspaceId, options) => {
      expect(options?.purpose).toBe("dictation");
      return {
        recordings: [...this.recordings.values()]
          .filter((recording) => recording.workspaceId === workspaceId)
          .map((recording) => ({
            id: recording.id,
            state: recording.state,
            purpose: recording.purpose,
            errorCode: null,
            transcript: recording.versions.at(-1) ?? null,
          })),
        nextBefore: null,
      } as never;
    },
    listRecordingTranscriptVersions: async (_workspaceId, recordingId) => {
      const recording = this.recordings.get(recordingId);
      if (!recording) throw Object.assign(new Error("gone"), { status: 404 });
      return recording.versions.map((version) => ({ ...version })) as never;
    },
    getRecordingTranscript: async (_workspaceId, recordingId, options) => {
      const version = this.recordings
        .get(recordingId)
        ?.versions.find((item) => item.id === options?.versionId);
      return {
        segments: version?.text ? [{ text: version.text }] : [],
        nextAfter: null,
      } as never;
    },
    createRecordingTranscript: async (_workspaceId, recordingId) => {
      this.transcriptRequests.push(recordingId);
      const recording = this.recordings.get(recordingId)!;
      const version = this.version(this.heard);
      recording.versions.push(version);
      recording.state = this.heard === null ? "processing" : "ready";
      return { ...version } as never;
    },
  };
}

export function fakePlatform(
  server: FakeServer,
  options?: {
    deny?: boolean;
    store?: RecordingChunkStore;
    /** Chunks each recording saves as it starts, through its uploader. */
    chunks?: Uint8Array[];
    /** How long each recording says it has been capturing once it starts. */
    elapsedMilliseconds?: number;
  },
) {
  const recorders: Array<{ options: RecorderOptions; stopped: boolean; discarded: boolean }> = [];
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const store = options?.store;
  const platform: RecorderPlatform = {
    supported: true,
    systemAudioSupported: false,
    createStore: () => store ?? createMemoryRecordingChunkStore(),
    isCaptureActive: async () => false,
    createRecorder(recorderOptions): Recorder {
      const entry = { options: recorderOptions, stopped: false, discarded: false };
      recorders.push(entry);
      let snapshot: RecorderSnapshot = {
        state: "idle",
        recordingId: null,
        elapsedMilliseconds: 0,
        tracks: [],
        upload: null,
        error: null,
      };
      const status = (id: string) => ({
        recordingId: id,
        created: true,
        pendingChunks: 0,
        pendingBytes: 0,
        uploading: false,
        retryingAfterError: null,
        failed: null,
        finalized: true,
        discarded: false,
      });
      return {
        get snapshot() {
          return snapshot;
        },
        async start() {
          if (options?.deny) {
            snapshot = {
              ...snapshot,
              state: "failed",
              error: { code: "microphone_denied", message: "denied" },
            };
            return;
          }
          const created = await recorderOptions.client.createRecording(
            recorderOptions.workspaceId,
            {
              purpose: recorderOptions.purpose,
              tracks: [{ trackNumber: 0, source: "microphone", label: "Microphone" }],
            } as never,
          );
          snapshot = {
            ...snapshot,
            state: "recording",
            recordingId: created.id,
            elapsedMilliseconds: options?.elapsedMilliseconds ?? 0,
          };
          if (options?.chunks) {
            recorderOptions.onChange?.(snapshot);
            for (const [chunkNumber, bytes] of options.chunks.entries()) {
              await recorderOptions.uploader?.addChunk({
                recordingId: created.id,
                trackNumber: 0,
                chunkNumber,
                bytes,
                sha256: "0".repeat(64),
                startMilliseconds: chunkNumber * 1_000,
                durationMilliseconds: 1_000,
              });
            }
          }
        },
        pause() {},
        resume() {},
        async stop() {
          entry.stopped = true;
          const id = snapshot.recordingId!;
          snapshot = { ...snapshot, state: "stopped" };
          server.finalize(id);
          return status(id);
        },
        async discard() {
          entry.discarded = true;
          const id = snapshot.recordingId;
          snapshot = { ...snapshot, state: "stopped" };
          if (id) server.recordings.delete(id);
        },
        async rename() {},
        levels: () => ({ 0: 0 }),
        inputStream: () => (snapshot.state === "recording" ? stream : null),
      };
    },
  };
  return { platform, recorders, stream };
}
