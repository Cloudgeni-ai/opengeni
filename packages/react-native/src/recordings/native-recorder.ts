import type {
  LiveTranscriber,
  LiveTranscriptTransport,
  Recorder,
  RecorderErrorCode,
  RecorderOptions,
  RecorderSnapshot,
  RecordingUploadStatus,
} from "@opengeni/sdk/recordings";
import { createLiveTranscriber, RecordingUploader } from "@opengeni/sdk/recordings";
import type { FileRecordingChunkStore, RecordingFileSystem } from "./file-store";
import { errorMessage } from "@opengeni/contracts/values";

/** A chunk file the native recorder finished, already in the recording's directory. */
export type NativeAudioChunkEvent = {
  recordingId: string;
  trackNumber: number;
  chunkNumber: number;
  startMilliseconds: number;
  durationMilliseconds: number;
  byteLength: number;
  sha256: string;
  fileName: string;
};

export type NativeAudioStateEvent = {
  recordingId: string;
  /** `interrupted`: the system took the microphone (a call, another app); capture resumes by itself when it can. */
  state: "recording" | "interrupted" | "stopped";
};

export type NativeAudioErrorEvent = { recordingId: string; code: string; message: string };

/**
 * The live transcript's copy of the microphone while it is asked for: 16-bit
 * little-endian mono PCM, base64, starting `recordedMilliseconds` into the
 * recording (excluding pauses).
 */
export type NativeAudioPcmEvent = {
  recordingId: string;
  data: string;
  sampleRate: number;
  recordedMilliseconds: number;
};

/**
 * The native capture module (`OpenGeniAudioCapture`): the microphone encoded
 * as AAC in ADTS frames, cut into chunk files in the recording's directory,
 * named as the file store names them. It keeps recording in the background
 * (iOS audio background mode, an Android microphone foreground service).
 */
export interface NativeAudioCapture {
  start(options: {
    recordingId: string;
    directory: string;
    trackNumber: number;
    chunkMilliseconds: number;
    bitRate: number;
    notificationTitle: string;
    notificationText: string;
  }): Promise<{ sampleRate: number; inputName: string | null }>;
  pause(): void;
  resume(): Promise<void>;
  /**
   * Stop and finish the last chunk. Resolves with that chunk (also sent as an
   * event, which may arrive after this resolves), or null when none was left.
   */
  stop(): Promise<NativeAudioChunkEvent | null>;
  /** Stop and delete what is not finished. */
  cancel(): Promise<void>;
  /** Recorded time so far (excluding pauses and interruptions). */
  elapsedMilliseconds(): number;
  /** Input level from 0 to 1. */
  level(): number;
  /** The recording being captured now, also across a JavaScript reload. */
  activeRecordingId(): string | null;
  /** Start or stop sending the live transcript's copy of the audio as `onPcm`. Older builds lack it. */
  setLivePcm?(enabled: boolean): void;
  addListener(
    event: "onChunk",
    listener: (event: NativeAudioChunkEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onState",
    listener: (event: NativeAudioStateEvent) => void,
  ): { remove(): void };
  addListener(
    event: "onError",
    listener: (event: NativeAudioErrorEvent) => void,
  ): { remove(): void };
  addListener(event: "onPcm", listener: (event: NativeAudioPcmEvent) => void): { remove(): void };
}

export const NATIVE_RECORDING_MIME_TYPE = "audio/aac";

export type NativeRecorderOptions = RecorderOptions & {
  native: NativeAudioCapture;
  store: FileRecordingChunkStore;
  fs: RecordingFileSystem;
  randomUUID: () => string;
  /** Resolves false when the person declines microphone access. */
  requestPermission: () => Promise<boolean>;
  /** The ongoing notification Android shows while recording. */
  notification: { title: string; text: string };
  bitRate?: number;
  fetch?: typeof fetch;
};

const message = (error: unknown) => errorMessage(error);

/** Little-endian 16-bit samples from base64. */
function decodePcm(data: string): Int16Array {
  const binary = atob(data);
  const samples = new Int16Array(binary.length >> 1);
  for (let index = 0; index < samples.length; index += 1) {
    const value = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
    samples[index] = value >= 0x8000 ? value - 0x10000 : value;
  }
  return samples;
}

/** A {@link Recorder} on the phone's microphone, with the same lifecycle as the browser one. */
export function createNativeRecorder(options: NativeRecorderOptions): Recorder {
  const { native, store, fs } = options;
  let snapshot: RecorderSnapshot = {
    state: "idle",
    recordingId: null,
    elapsedMilliseconds: 0,
    tracks: [],
    upload: null,
    error: null,
  };
  const emit = (patch: Partial<RecorderSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    options.onChange?.(snapshot);
  };
  const fail = (code: RecorderErrorCode, text: string) =>
    emit({ state: "failed", error: { code, message: text } });
  const uploader =
    options.uploader ??
    new RecordingUploader({
      client: options.client,
      store,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      isCaptureActive: async (id) => native.activeRecordingId() === id,
    });
  let unsubscribe: (() => void) | null = null;
  let subscriptions: Array<{ remove(): void }> = [];
  let ticker: ReturnType<typeof setInterval> | null = null;
  let live: LiveTranscriber | null = null;
  let writes: Promise<void> = Promise.resolve();
  // Chunks already handed to the uploader, so the final one is saved once
  // whether its event or stop()'s result arrives first.
  const seen = new Set<number>();
  const record = (event: NativeAudioChunkEvent) => {
    if (seen.has(event.chunkNumber)) return;
    seen.add(event.chunkNumber);
    // Chain writes so a track's chunks are recorded in order.
    writes = writes
      .then(() => saveChunk(event))
      .catch((error: unknown) => fail("capture_failed", message(error)));
  };

  const release = () => {
    native.setLivePcm?.(false);
    for (const subscription of subscriptions) subscription.remove();
    subscriptions = [];
    if (ticker) clearInterval(ticker);
    ticker = null;
  };

  /** Stream the microphone to the live transcript. Recording never waits on it. */
  const startLive = (recordingId: string) => {
    const client = options.client as Partial<LiveTranscriptTransport>;
    if (!options.liveTranscript || !native.setLivePcm) return;
    if (!client.createRecordingLiveSession || !client.appendRecordingLiveSegments) return;
    const transcriber = createLiveTranscriber({
      client: client as LiveTranscriptTransport,
      workspaceId: options.workspaceId,
      recordingId,
      trackNumber: 0,
      ...(options.liveWebSocket ? { WebSocket: options.liveWebSocket } : {}),
      // React Native's WebSocket takes headers, which OpenAI Realtime signs in with.
      webSocketHeaders: true,
      onChange: (track) => {
        if (live === transcriber) emit({ live: [track] });
      },
    });
    live = transcriber;
    emit({ live: [transcriber.snapshot] });
    subscriptions.push(
      native.addListener("onPcm", (event) => {
        // Paused audio is not recorded, so it is not transcribed either.
        if (event.recordingId !== recordingId || snapshot.state !== "recording") return;
        transcriber.push(decodePcm(event.data), event.sampleRate, event.recordedMilliseconds);
      }),
    );
    native.setLivePcm(true);
  };

  const saveChunk = async (event: NativeAudioChunkEvent) => {
    const path = `${store.directory(event.recordingId)}/${event.fileName}`;
    const bytes = await fs.readBytes(path);
    if (!bytes) throw new Error(`Chunk ${event.chunkNumber} is missing on the device.`);
    // The file is already where the store keeps it; this records it and starts its upload.
    await uploader.addChunk({
      recordingId: event.recordingId,
      trackNumber: event.trackNumber,
      chunkNumber: event.chunkNumber,
      bytes,
      sha256: event.sha256,
      startMilliseconds: event.startMilliseconds,
      durationMilliseconds: event.durationMilliseconds,
    });
  };

  return {
    get snapshot() {
      return snapshot;
    },

    async start() {
      if (
        snapshot.state !== "idle" &&
        snapshot.state !== "failed" &&
        snapshot.state !== "stopped"
      ) {
        return;
      }
      if (options.microphone === false) {
        fail("unsupported", "Phones record the microphone; there is nothing else to record.");
        return;
      }
      emit({ state: "starting", error: null, upload: null, elapsedMilliseconds: 0 });
      let granted = false;
      try {
        granted = await options.requestPermission();
      } catch {
        granted = false;
      }
      if (!granted) {
        fail("microphone_denied", "Microphone access was not allowed.");
        return;
      }
      const recordingId = options.randomUUID();
      unsubscribe ??= uploader.subscribe((status: RecordingUploadStatus) => {
        if (status.recordingId !== snapshot.recordingId) return;
        emit({
          upload: status,
          ...(status.failed
            ? { error: { code: "upload_failed" as const, message: status.failed.message } }
            : {}),
        });
      });
      live = null;
      emit({ recordingId, title: options.title ?? null, live: null });
      await uploader.begin({
        workspaceId: options.workspaceId,
        recordingId,
        create: {
          recordingId,
          ...(options.purpose ? { purpose: options.purpose } : {}),
          ...(options.title ? { title: options.title } : {}),
          ...(options.visibility ? { visibility: options.visibility } : {}),
          startedAt: new Date().toISOString(),
          ...(options.externalRef ? { externalRef: options.externalRef } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.transcription ? { transcription: options.transcription } : {}),
          tracks: [{ trackNumber: 0, source: "microphone", mimeType: NATIVE_RECORDING_MIME_TYPE }],
        },
      });
      writes = Promise.resolve();
      seen.clear();
      subscriptions = [
        native.addListener("onChunk", (event) => {
          if (event.recordingId !== recordingId) return;
          record(event);
        }),
        native.addListener("onState", (event) => {
          if (event.recordingId !== recordingId) return;
          if (event.state === "interrupted" && snapshot.state === "recording") {
            emit({ state: "paused", pauseReason: "interruption" });
          } else if (
            event.state === "recording" &&
            snapshot.state === "paused" &&
            snapshot.pauseReason === "interruption"
          ) {
            emit({ state: "recording", pauseReason: null });
          }
        }),
        native.addListener("onError", (event) => {
          if (event.recordingId !== recordingId) return;
          // Android could not keep recording in the background; it goes on while the app is open.
          if (event.code === "background_unavailable") return;
          fail("capture_failed", event.message);
        }),
      ];
      let input: { inputName: string | null };
      try {
        input = await native.start({
          recordingId,
          directory: store.directory(recordingId),
          trackNumber: 0,
          chunkMilliseconds: options.timesliceMilliseconds ?? 5_000,
          bitRate: options.bitRate ?? 64_000,
          notificationTitle: options.notification.title,
          notificationText: options.notification.text,
        });
      } catch (error) {
        release();
        await uploader.discard(recordingId).catch(() => undefined);
        fail("microphone_unavailable", message(error) || "No microphone could be opened.");
        return;
      }
      ticker = setInterval(() => emit({ elapsedMilliseconds: native.elapsedMilliseconds() }), 250);
      emit({
        state: "recording",
        pauseReason: null,
        tracks: [{ trackNumber: 0, source: "microphone", label: input.inputName || "Microphone" }],
      });
      startLive(recordingId);
    },

    pause() {
      if (snapshot.state !== "recording") return;
      native.pause();
      emit({
        state: "paused",
        pauseReason: "person",
        elapsedMilliseconds: native.elapsedMilliseconds(),
      });
    },

    resume() {
      if (snapshot.state !== "paused") return;
      void native.resume().then(
        () => emit({ state: "recording", pauseReason: null }),
        (error: unknown) => fail("capture_failed", message(error)),
      );
    },

    async stop(stopOptions = {}) {
      const recordingId = snapshot.recordingId;
      if (!recordingId || (snapshot.state !== "recording" && snapshot.state !== "paused")) {
        return snapshot.upload;
      }
      emit({ state: "stopping", elapsedMilliseconds: native.elapsedMilliseconds() });
      try {
        const last = await native.stop();
        if (last && last.recordingId === recordingId) record(last);
      } catch {
        // What was written is kept; recovery saves a chunk the stop could not finish.
      }
      await writes;
      release();
      // The live transcript finishes its last words while the upload completes.
      const liveClosed = live?.close();
      const status = await uploader.finish(recordingId, { ...stopOptions, endedAt: new Date() });
      await liveClosed?.catch(() => undefined);
      emit({
        state: status.failed ? "failed" : "stopped",
        pauseReason: null,
        upload: status,
        ...(status.failed
          ? { error: { code: "upload_failed" as const, message: status.failed.message } }
          : {}),
      });
      return status;
    },

    async discard() {
      const recordingId = snapshot.recordingId;
      release();
      live?.abort();
      live = null;
      await native.cancel().catch(() => undefined);
      await writes;
      if (recordingId) await uploader.discard(recordingId);
      emit({
        state: "idle",
        recordingId: null,
        pauseReason: null,
        elapsedMilliseconds: 0,
        tracks: [],
        upload: null,
        live: null,
      });
    },

    async rename(title: string) {
      const recordingId = snapshot.recordingId;
      if (!recordingId) throw new Error("Nothing is being recorded to rename.");
      await uploader.rename(options.workspaceId, recordingId, title);
      if (snapshot.recordingId === recordingId) emit({ title });
    },

    levels(): Record<number, number> {
      if (snapshot.state !== "recording") return {};
      return { 0: native.level() };
    },
  };
}
