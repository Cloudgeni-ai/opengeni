import type {
  CreateRecordingPersonRequest,
  ListRecordingModelsResponse,
  Recording,
  RecordingLiveSegment,
  RecordingNote,
  RecordingNoteKind,
  RecordingPerson,
  RecordingVoiceprintConsent,
  RecordingSpeaker,
  RecordingTranscriptionRequest,
  RecordingTranscriptPage,
  RecordingTranscriptSegment,
  RecordingTranscriptVersion,
  RecordingVisibility,
  UpdateRecordingRequest,
} from "@opengeni/contracts";
import {
  browserRecorderPlatform,
  OpenGeniRecordingsClient,
  RecordingUploader,
  type Recorder,
  type RecorderPlatform,
  type RecorderSnapshot,
  type RecordingChunkStore,
  type SystemAudioKind,
  type RecordingTransport,
  type OpenGeniRecordingsTransport,
} from "@opengeni/sdk/recordings";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { OpenGeniContext } from "../session-context";
import { usePolledValue } from "./internal";

const PROCESSING_POLL_MS = 3_000;
// A meeting recorded on another device changes little until it ends, so pages
// showing it read it less often, only to notice when the capture finishes.
const CAPTURING_POLL_MS = 10_000;

/**
 * Client surface of the recording hooks, as `OpenGeniRecordingsClient` provides
 * it. Each hook checks only the methods it calls, so a host proxy can expose a subset.
 */
export type RecordingsClientLike = Pick<
  OpenGeniRecordingsClient,
  | "listRecordings"
  | "createRecording"
  | "getRecording"
  | "updateRecording"
  | "deleteRecording"
  | "createRecordingUploads"
  | "completeRecordingChunks"
  | "finalizeRecording"
  | "listRecordingTranscriptVersions"
  | "createRecordingTranscript"
  | "getRecordingTranscript"
  | "setCurrentRecordingTranscript"
  | "updateRecordingSpeakers"
  | "updateRecordingSegments"
  | "getRecordingTrackAudio"
  | "listRecordingPeople"
  | "createRecordingPerson"
  | "rememberRecordingPersonVoice"
  | "forgetRecordingPersonVoice"
  | "listRecordingModels"
  | "createRecordingLiveSession"
  | "appendRecordingLiveSegments"
  | "listRecordingLiveSegments"
  | "listRecordingNotes"
  | "saveRecordingNote"
>;

/** Refresh every `intervalMs` while `active`, without an extra read when it turns on. */
function useRefreshWhile(
  active: boolean,
  refresh: () => Promise<void>,
  intervalMs: number = PROCESSING_POLL_MS,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timer = setTimeout(() => {
        void refreshRef.current().finally(() => {
          if (!cancelled) tick();
        });
      }, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, intervalMs]);
}

export type RecordingsClientOverride = {
  /** A recordings client, such as a host proxy. Built from the provider's client otherwise. */
  recordings?: Partial<RecordingsClientLike> | undefined;
  /** A client exposing `requestJson` (the SDK client) to build the recordings client from. */
  client?: object | undefined;
  workspaceId?: string | undefined;
};

const recordingClients = new WeakMap<object, OpenGeniRecordingsClient>();

/**
 * Resolve the recording methods one hook calls: the explicit `recordings`
 * client, else an `OpenGeniRecordingsClient` over the provider's SDK client.
 */
function useEmbeddedRecordings(
  override: RecordingsClientOverride,
  requiredMethods: readonly (keyof RecordingsClientLike)[],
  hookName: string,
): { client: RecordingsClientLike; workspaceId: string } {
  const context = useContext(OpenGeniContext);
  const workspaceId = override.workspaceId ?? context?.workspaceId;
  let candidate: object | undefined = override.recordings;
  if (!candidate) {
    const base = (override.client ?? context?.client) as
      | Partial<OpenGeniRecordingsTransport>
      | undefined;
    if (base && typeof base.requestJson === "function") {
      candidate = recordingClients.get(base);
      if (!candidate) {
        const created = new OpenGeniRecordingsClient(base as OpenGeniRecordingsTransport);
        recordingClients.set(base, created);
        candidate = created;
      }
    }
  }
  if (!candidate || !workspaceId) {
    throw new Error(
      `@opengeni/react: ${hookName} needs a recordings client and workspace. Wrap the tree in <OpenGeniProvider> with the SDK client, or pass { recordings, workspaceId }.`,
    );
  }
  const methods = candidate as Record<string, unknown>;
  const missing = requiredMethods.filter((method) => typeof methods[method] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `@opengeni/react: ${hookName} requires recordings client method${missing.length === 1 ? "" : "s"} ${missing.join(", ")}.`,
    );
  }
  return { client: candidate as RecordingsClientLike, workspaceId };
}

/**
 * The recordings client the hooks use, for calls no hook wraps (deleting from
 * a list, reading track audio): the explicit `recordings` client, else one
 * built over the provider's SDK client.
 */
export function useRecordingsClient(options: RecordingsClientOverride = {}): {
  client: RecordingsClientLike;
  workspaceId: string;
} {
  return useEmbeddedRecordings(options, [], "useRecordingsClient");
}

// --- Capture -------------------------------------------------------------------

export type UseRecorderOptions = RecordingsClientOverride & {
  title?: string;
  visibility?: RecordingVisibility;
  /** Your own id for what this recording belongs to, to find it again with `useRecordings`. */
  externalRef?: string;
  metadata?: Record<string, unknown>;
  transcription?: RecordingTranscriptionRequest;
  /** Microphone constraints; false records no microphone. Default: on. */
  microphone?: boolean | MediaTrackConstraints;
  /** Also record shared tab or system audio as its own track (Chromium). Default: off. */
  systemAudio?: boolean;
  timesliceMilliseconds?: number;
  keepAwake?: boolean;
  /**
   * Also show a live transcript while recording, in `live`: each track is
   * streamed to the workspace's live speech model as it is captured, which
   * the provider bills for. A preview only. Default: off.
   */
  liveTranscript?: boolean;
  /**
   * Where capture runs. Default: the browser (MediaRecorder and IndexedDB).
   * React Native passes `useNativeRecorderPlatform()` from `@opengeni/react-native/recordings`.
   */
  platform?: RecorderPlatform;
  /** Local storage for chunks not uploaded yet. Default: the platform's (IndexedDB in browsers). */
  store?: RecordingChunkStore;
  /** Finish recordings an earlier page left behind when the hook mounts. Default: on. */
  resumePending?: boolean;
  /** Called once the server has every chunk of a recording and transcription has started. */
  onFinished?: (recordingId: string) => void;
};

export type UseRecorderResult = RecorderSnapshot & {
  /** This browser can record audio at all. */
  supported: boolean;
  /** This browser can share a tab's or the system's audio. */
  systemAudioSupported: boolean;
  /**
   * How: `desktop` records other apps' audio directly (inside a desktop app);
   * `display` asks the browser to share a tab or screen. Null when it can't.
   */
  systemAudioKind: SystemAudioKind | null;
  /**
   * Recordings from an earlier page or app run this hook is still finishing in
   * the background. Each leaves the list once it is uploaded, removed for having
   * no audio, or failed for good.
   */
  recovered: string[];
  /** Start a new recording; per-recording options override the hook's. */
  start: (
    overrides?: Pick<
      UseRecorderOptions,
      | "title"
      | "systemAudio"
      | "microphone"
      | "visibility"
      | "liveTranscript"
      | "transcription"
      | "externalRef"
      | "metadata"
    >,
  ) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  discard: () => Promise<void>;
  /** Rename the recording being made; the title reaches the server with the upload. */
  rename: (title: string) => Promise<void>;
  /** Input level per track number, 0 to 1. Read it from an animation frame for a meter. */
  levels: () => Record<number, number>;
};

const IDLE_SNAPSHOT: RecorderSnapshot = {
  state: "idle",
  recordingId: null,
  elapsedMilliseconds: 0,
  tracks: [],
  upload: null,
  error: null,
};

/**
 * Record a meeting in the browser. Audio is saved locally every few seconds
 * and uploaded in the background, so a reload or a lost connection loses
 * nothing. Unmounting while recording stops capture (the microphone is
 * released) and finishes the upload in the background; keep the hook in a
 * component that outlives page navigation to record across it.
 */
export function useRecorder(options: UseRecorderOptions = {}): UseRecorderResult {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    [
      "createRecording",
      "createRecordingUploads",
      "completeRecordingChunks",
      "finalizeRecording",
      "deleteRecording",
    ],
    "useRecorder",
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // The uploader outlives client changes (a sign-in token that loads late or is
  // refreshed, a switched account), so it calls through to the latest client
  // instead of keeping the one it was created with.
  const clientRef = useRef(client);
  clientRef.current = client;
  const transport = useMemo<RecordingTransport>(() => {
    const methods = clientRef.current as Partial<RecordingsClientLike>;
    return {
      createRecording: (...args) => clientRef.current.createRecording(...args),
      createRecordingUploads: (...args) => clientRef.current.createRecordingUploads(...args),
      completeRecordingChunks: (...args) => clientRef.current.completeRecordingChunks(...args),
      finalizeRecording: (...args) => clientRef.current.finalizeRecording(...args),
      deleteRecording: (...args) => clientRef.current.deleteRecording(...args),
      ...(typeof methods.updateRecording === "function"
        ? { updateRecording: (...args) => clientRef.current.updateRecording(...args) }
        : {}),
      // Only a client that has the live calls can show a live transcript.
      ...(typeof methods.createRecordingLiveSession === "function" &&
      typeof methods.appendRecordingLiveSegments === "function"
        ? {
            createRecordingLiveSession: (...args) =>
              clientRef.current.createRecordingLiveSession(...args),
            appendRecordingLiveSegments: (...args) =>
              clientRef.current.appendRecordingLiveSegments(...args),
          }
        : {}),
    };
  }, []);
  const [snapshot, setSnapshot] = useState<RecorderSnapshot>(IDLE_SNAPSHOT);
  const [recovered, setRecovered] = useState<string[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const uploaderRef = useRef<RecordingUploader | null>(null);
  const defaultPlatform = useMemo(() => browserRecorderPlatform(), []);
  const platform = options.platform ?? defaultPlatform;
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const support = {
    supported: platform.supported,
    systemAudio: platform.systemAudioSupported,
    systemAudioKind:
      platform.systemAudioKind ?? (platform.systemAudioSupported ? ("display" as const) : null),
  };
  const storeRef = useRef<RecordingChunkStore | null>(null);
  const store = useCallback(
    (): RecordingChunkStore =>
      optionsRef.current.store ?? (storeRef.current ??= platformRef.current.createStore()),
    [],
  );

  const uploader = useCallback((): RecordingUploader => {
    if (!uploaderRef.current) {
      const isCaptureActive = platformRef.current.isCaptureActive;
      const platformFetch = platformRef.current.fetch;
      uploaderRef.current = new RecordingUploader({
        client: transport,
        store: store(),
        ...(platformFetch ? { fetch: platformFetch } : {}),
        ...(isCaptureActive ? { isCaptureActive: (id: string) => isCaptureActive(id) } : {}),
        onStatus: (status) => {
          if (status.finalized) optionsRef.current.onFinished?.(status.recordingId);
          if (status.finalized || status.discarded || status.failed) {
            setRecovered((previous) =>
              previous.includes(status.recordingId)
                ? previous.filter((id) => id !== status.recordingId)
                : previous,
            );
          }
        },
      });
    }
    return uploaderRef.current;
  }, [transport, store]);

  useEffect(() => {
    if (!support.supported || optionsRef.current.resumePending === false) return;
    let cancelled = false;
    void (async () => {
      // Save what a capture cut short left half-written, then finish everything.
      await platformRef.current.recover?.(store()).catch(() => undefined);
      // Dictations are the composer's to finish; this hook finishes the rest.
      return await uploader().resume({
        only: (recording) => recording.create.purpose !== "dictation",
      });
    })()
      .then((ids) => {
        if (cancelled) return;
        // Some may already be done by now: keep only those still in flight.
        const open = ids.filter((id) => {
          const status = uploader().status(id);
          return !(status?.finalized || status?.discarded || status?.failed);
        });
        if (open.length > 0) setRecovered(open);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [support.supported, uploader, store]);

  useEffect(
    () => () => {
      const recorder = recorderRef.current;
      if (
        recorder &&
        (recorder.snapshot.state === "recording" || recorder.snapshot.state === "paused")
      ) {
        void recorder.stop().catch(() => undefined);
      }
    },
    [],
  );

  const start = useCallback<UseRecorderResult["start"]>(
    async (overrides = {}) => {
      const current = recorderRef.current?.snapshot.state;
      if (
        current === "starting" ||
        current === "recording" ||
        current === "paused" ||
        current === "stopping"
      ) {
        return;
      }
      const merged = {
        ...optionsRef.current,
        ...overrides,
        // A start can set one transcription option, such as the language, and
        // keep the rest the hook was given.
        ...(overrides.transcription
          ? { transcription: { ...optionsRef.current.transcription, ...overrides.transcription } }
          : {}),
      };
      // Earlier recorders stay subscribed to the shared uploader for their own
      // recording; only the current one may change what the hook shows.
      let recorder: Recorder | null = null;
      recorder = platformRef.current.createRecorder({
        client: transport,
        workspaceId,
        store: store(),
        uploader: uploader(),
        ...(merged.title ? { title: merged.title } : {}),
        ...(merged.visibility ? { visibility: merged.visibility } : {}),
        ...(merged.externalRef ? { externalRef: merged.externalRef } : {}),
        ...(merged.metadata ? { metadata: merged.metadata as never } : {}),
        ...(merged.transcription ? { transcription: merged.transcription } : {}),
        ...(merged.microphone !== undefined ? { microphone: merged.microphone } : {}),
        ...(merged.systemAudio !== undefined ? { systemAudio: merged.systemAudio } : {}),
        ...(merged.timesliceMilliseconds
          ? { timesliceMilliseconds: merged.timesliceMilliseconds }
          : {}),
        ...(merged.keepAwake !== undefined ? { keepAwake: merged.keepAwake } : {}),
        ...(merged.liveTranscript ? { liveTranscript: true } : {}),
        onChange: (next) => {
          if (recorderRef.current === recorder) setSnapshot(next);
        },
      });
      recorderRef.current = recorder;
      await recorder.start();
    },
    [transport, workspaceId, store, uploader],
  );

  return {
    ...snapshot,
    supported: support.supported,
    systemAudioSupported: support.systemAudio,
    systemAudioKind: support.systemAudioKind,
    recovered,
    start,
    pause: useCallback(() => recorderRef.current?.pause(), []),
    resume: useCallback(() => recorderRef.current?.resume(), []),
    stop: useCallback(async () => {
      await recorderRef.current?.stop();
    }, []),
    discard: useCallback(async () => {
      await recorderRef.current?.discard();
    }, []),
    rename: useCallback(async (title: string) => {
      const recorder = recorderRef.current;
      if (!recorder) throw new Error("Nothing is being recorded to rename.");
      await recorder.rename(title);
    }, []),
    levels: useCallback(() => recorderRef.current?.levels() ?? {}, []),
  };
}

// --- Reads -------------------------------------------------------------------------

export type UseRecordingsOptions = RecordingsClientOverride & {
  query?: string;
  externalRef?: string;
  limit?: number;
  pollIntervalMs?: number;
  enabled?: boolean;
};

export type UseRecordingsResult = {
  recordings: Recording[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<void>;
};

function isProcessing(recording: Recording | null | undefined): boolean {
  if (!recording) return false;
  const state = recording.transcript?.state;
  return recording.state === "processing" || state === "queued" || state === "processing";
}

/**
 * The recordings the signed-in person can see, newest first. Polls while any is
 * being transcribed, and less often while any is still being recorded.
 */
export function useRecordings(options: UseRecordingsOptions = {}): UseRecordingsResult {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    ["listRecordings"],
    "useRecordings",
  );
  const { query, externalRef, limit } = options;
  const load = useCallback(
    async (signal?: AbortSignal) =>
      await client.listRecordings(workspaceId, {
        ...(query ? { query } : {}),
        ...(externalRef ? { externalRef } : {}),
        ...(limit ? { limit } : {}),
        ...(signal ? { signal } : {}),
      }),
    [client, workspaceId, query, externalRef, limit],
  );
  const state = usePolledValue(load, {
    pollIntervalMs: options.pollIntervalMs,
    enabled: options.enabled,
  });
  const [older, setOlder] = useState<{
    key: unknown;
    recordings: Recording[];
    nextBefore: { startedAt: string; id: string } | null;
  } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Older pages belong to the first page they continued; a new query starts over.
  const olderForThisList = older && older.key === load ? older : null;
  const recordings = useMemo(() => {
    const first = state.data?.recordings ?? [];
    if (!olderForThisList) return first;
    const seen = new Set(first.map((recording) => recording.id));
    return [
      ...first,
      ...olderForThisList.recordings.filter((recording) => !seen.has(recording.id)),
    ];
  }, [state.data, olderForThisList]);
  const anyProcessing = recordings.some(isProcessing);
  useRefreshWhile(
    options.pollIntervalMs === undefined &&
      (options.enabled ?? true) &&
      (anyProcessing || recordings.some((recording) => recording.state === "capturing")),
    state.refresh,
    anyProcessing ? PROCESSING_POLL_MS : CAPTURING_POLL_MS,
  );
  const nextBefore = olderForThisList
    ? olderForThisList.nextBefore
    : (state.data?.nextBefore ?? null);
  const loadMore = useCallback(async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await client.listRecordings(workspaceId, {
        ...(query ? { query } : {}),
        ...(externalRef ? { externalRef } : {}),
        ...(limit ? { limit } : {}),
        before: nextBefore,
      });
      setOlder((previous) => ({
        key: load,
        recordings: [
          ...(previous && previous.key === load ? previous.recordings : []),
          ...page.recordings,
        ],
        nextBefore: page.nextBefore,
      }));
    } finally {
      setLoadingMore(false);
    }
  }, [client, workspaceId, query, externalRef, limit, nextBefore, loadingMore, load]);
  return {
    recordings,
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
    hasMore: nextBefore !== null,
    loadingMore,
    loadMore,
  };
}

export type UseRecordingOptions = RecordingsClientOverride & {
  enabled?: boolean;
};

export type UseRecordingResult = {
  recording: Recording | null;
  versions: RecordingTranscriptVersion[];
  loading: boolean;
  error: Error | null;
  /** Transcription is still running; the hook polls until it is done. */
  processing: boolean;
  refresh: () => Promise<void>;
  update: (request: UpdateRecordingRequest) => Promise<Recording>;
  /** Transcribe again, optionally with another model, as a new version. */
  rerun: (transcription?: RecordingTranscriptionRequest) => Promise<RecordingTranscriptVersion>;
  setCurrentVersion: (versionId: string) => Promise<void>;
  remove: () => Promise<void>;
};

/**
 * One recording with its transcript versions. Polls while it is being
 * transcribed, and less often while it is still being recorded, here or on
 * another device, so a page showing it notices when the recording ends.
 */
export function useRecording(
  recordingId: string | null,
  options: UseRecordingOptions = {},
): UseRecordingResult {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    ["getRecording", "listRecordingTranscriptVersions"],
    "useRecording",
  );
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!recordingId) return null;
      const [recording, versions] = await Promise.all([
        client.getRecording(workspaceId, recordingId, signal ? { signal } : {}),
        client.listRecordingTranscriptVersions(workspaceId, recordingId),
      ]);
      return { recording, versions };
    },
    [client, workspaceId, recordingId],
  );
  const enabled = (options.enabled ?? true) && recordingId !== null;
  const state = usePolledValue(load, { enabled });
  const recording = state.data?.recording ?? null;
  const versions = state.data?.versions ?? [];
  const nowProcessing =
    isProcessing(recording) ||
    versions.some((version) => version.state === "queued" || version.state === "processing");
  useRefreshWhile(
    enabled && (nowProcessing || recording?.state === "capturing"),
    state.refresh,
    nowProcessing ? PROCESSING_POLL_MS : CAPTURING_POLL_MS,
  );
  const refresh = state.refresh;
  const require = () => {
    if (!recordingId) throw new Error("No recording selected.");
    return recordingId;
  };
  return {
    recording,
    versions,
    loading: state.loading,
    error: state.error,
    processing: nowProcessing,
    refresh,
    update: useCallback(
      async (request: UpdateRecordingRequest) => {
        const updated = await client.updateRecording(workspaceId, require(), request);
        await refresh();
        return updated;
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [client, workspaceId, recordingId, refresh],
    ),
    rerun: useCallback(
      async (transcription?: RecordingTranscriptionRequest) => {
        const version = await client.createRecordingTranscript(
          workspaceId,
          require(),
          transcription ? { transcription } : {},
        );
        await refresh();
        return version;
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [client, workspaceId, recordingId, refresh],
    ),
    setCurrentVersion: useCallback(
      async (versionId: string) => {
        await client.setCurrentRecordingTranscript(workspaceId, require(), versionId);
        await refresh();
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [client, workspaceId, recordingId, refresh],
    ),
    remove: useCallback(
      async () => {
        await client.deleteRecording(workspaceId, require());
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [client, workspaceId, recordingId],
    ),
  };
}

const LIVE_POLL_MS = 2_000;

export type UseLiveTranscriptOptions = RecordingsClientOverride & {
  /** Default: on while a recording id is given. */
  enabled?: boolean;
};

export type UseLiveTranscriptResult = {
  /** Finished live text from every track, in time order. */
  segments: RecordingLiveSegment[];
  /** A transcript is ready, so the preview is over. */
  ended: boolean;
  error: Error | null;
};

/**
 * The live transcript of a recording someone is capturing, as the recorder
 * saves it, for viewers on other devices. Polls every two seconds until the
 * transcript is ready. The device recording has it sooner in `useRecorder().live`.
 */
export function useLiveTranscript(
  recordingId: string | null,
  options: UseLiveTranscriptOptions = {},
): UseLiveTranscriptResult {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    ["listRecordingLiveSegments"],
    "useLiveTranscript",
  );
  const enabled = (options.enabled ?? true) && recordingId !== null;
  const [state, setState] = useState<UseLiveTranscriptResult & { recordingId: string | null }>({
    recordingId,
    segments: [],
    ended: false,
    error: null,
  });
  const current = state.recordingId === recordingId ? state : null;
  const ended = current?.ended ?? false;
  useEffect(() => {
    if (!enabled || !recordingId || ended) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let after = 0;
    let segments: RecordingLiveSegment[] = [];
    const read = async () => {
      try {
        const page = await client.listRecordingLiveSegments(workspaceId, recordingId, { after });
        if (cancelled) return;
        after = page.after;
        if (page.segments.length > 0) {
          segments = [...segments, ...page.segments].sort(
            (left, right) =>
              left.startMilliseconds - right.startMilliseconds || left.sequence - right.sequence,
          );
        }
        setState({
          recordingId,
          segments: page.ended ? [] : segments,
          ended: page.ended,
          error: null,
        });
        if (page.ended) return;
      } catch (error) {
        if (cancelled) return;
        setState((previous) => ({
          ...(previous.recordingId === recordingId ? previous : { segments: [], ended: false }),
          recordingId,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
      timer = setTimeout(() => void read(), LIVE_POLL_MS);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, workspaceId, recordingId, enabled, ended]);
  return {
    segments: current?.segments ?? [],
    ended,
    error: current?.error ?? null,
  };
}

export type UseTranscriptOptions = RecordingsClientOverride & {
  /** A specific version; the current one by default. */
  versionId?: string;
  /** Change it to read again, for example when a new version completes. */
  refreshKey?: unknown;
  enabled?: boolean;
};

export type UseTranscriptResult = {
  version: RecordingTranscriptVersion | null;
  speakers: RecordingSpeaker[];
  segments: RecordingTranscriptSegment[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /** Name a speaker label after a person in the directory or with a plain name; null clears it. */
  nameSpeaker: (
    label: string,
    name: { personId: string } | { name: string } | null,
  ) => Promise<void>;
  /** Turn down a voice suggestion; that person is not suggested for this voice again. */
  rejectSuggestion: (label: string) => Promise<void>;
  /** Move one segment to another speaker label. */
  moveSegment: (segmentIndex: number, label: string) => Promise<void>;
  /** Correct one segment's text; null restores the original. */
  editSegment: (segmentIndex: number, text: string | null) => Promise<void>;
};

const TRANSCRIPT_PAGE = 2_000;

/** A whole transcript version with its speakers, and the edits people make to it. */
export function useTranscript(
  recordingId: string | null,
  options: UseTranscriptOptions = {},
): UseTranscriptResult {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    ["getRecordingTranscript", "updateRecordingSpeakers", "updateRecordingSegments"],
    "useTranscript",
  );
  const { versionId, refreshKey } = options;
  const load = useCallback(
    async (signal?: AbortSignal): Promise<RecordingTranscriptPage | null> => {
      void refreshKey;
      if (!recordingId) return null;
      let page = await client.getRecordingTranscript(workspaceId, recordingId, {
        ...(versionId ? { versionId } : {}),
        limit: TRANSCRIPT_PAGE,
        ...(signal ? { signal } : {}),
      });
      const segments = [...page.segments];
      while (page.nextAfter !== null) {
        page = await client.getRecordingTranscript(workspaceId, recordingId, {
          versionId: page.version.id,
          after: page.nextAfter,
          limit: TRANSCRIPT_PAGE,
          ...(signal ? { signal } : {}),
        });
        segments.push(...page.segments);
      }
      return { ...page, segments, nextAfter: null };
    },
    [client, workspaceId, recordingId, versionId, refreshKey],
  );
  const state = usePolledValue(load, {
    enabled: (options.enabled ?? true) && recordingId !== null,
  });
  // Edits answer with the new speakers or segments; keep them until the next read.
  const [local, setLocal] = useState<{
    base: unknown;
    speakers?: RecordingSpeaker[];
    segments?: Map<number, RecordingTranscriptSegment>;
  } | null>(null);
  const base = state.data;
  const overlay = local && local.base === base ? local : null;
  const speakers = overlay?.speakers ?? base?.speakers ?? [];
  const segments = useMemo(() => {
    const original = base?.segments ?? [];
    const changed = overlay?.segments;
    return changed ? original.map((segment) => changed.get(segment.index) ?? segment) : original;
  }, [base, overlay]);
  const versionFor = () => {
    if (!recordingId || !base) throw new Error("The transcript is not loaded yet.");
    return { recordingId, versionId: base.version.id };
  };
  const applySpeakers = (next: RecordingSpeaker[]) =>
    setLocal((previous) => ({
      ...(previous && previous.base === base ? previous : {}),
      base,
      speakers: next,
    }));
  const applySegments = (next: RecordingTranscriptSegment[]) =>
    setLocal((previous) => {
      const kept = previous && previous.base === base ? previous : { base };
      const merged = new Map(kept.segments ?? []);
      for (const segment of next) merged.set(segment.index, segment);
      return { ...kept, base, segments: merged };
    });
  return {
    version: base?.version ?? null,
    speakers,
    segments,
    loading: state.loading,
    error: state.error,
    refresh: state.refresh,
    nameSpeaker: async (label, name) => {
      const target = versionFor();
      const result = await client.updateRecordingSpeakers(
        workspaceId,
        target.recordingId,
        {
          assignments: [
            name === null
              ? { label, personId: null, name: null }
              : "personId" in name
                ? { label, personId: name.personId }
                : { label, name: name.name },
          ],
        },
        { versionId: target.versionId },
      );
      applySpeakers(result.speakers);
    },
    rejectSuggestion: async (label) => {
      const target = versionFor();
      const result = await client.updateRecordingSpeakers(
        workspaceId,
        target.recordingId,
        { rejectSuggestions: [{ label }] },
        { versionId: target.versionId },
      );
      applySpeakers(result.speakers);
    },
    moveSegment: async (segmentIndex, label) => {
      const target = versionFor();
      const result = await client.updateRecordingSpeakers(
        workspaceId,
        target.recordingId,
        { segmentOverrides: [{ segmentIndex, label }] },
        { versionId: target.versionId },
      );
      applySpeakers(result.speakers);
      const moved = segments.find((segment) => segment.index === segmentIndex);
      if (moved) applySegments([{ ...moved, speakerLabel: label }]);
    },
    editSegment: async (segmentIndex, text) => {
      const target = versionFor();
      const result = await client.updateRecordingSegments(
        workspaceId,
        target.recordingId,
        { edits: [{ segmentIndex, text }] },
        { versionId: target.versionId },
      );
      applySegments(result.segments);
    },
  };
}

/** The organization's people directory, to name speakers with. */
export function useRecordingPeople(
  options: RecordingsClientOverride & {
    query?: string;
    enabled?: boolean;
  } = {},
): {
  people: RecordingPerson[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (request: CreateRecordingPersonRequest) => Promise<RecordingPerson>;
  /** Agree to have a person's voice remembered (see rememberRecordingPersonVoice). */
  rememberVoice: (
    personId: string,
    consent: RecordingVoiceprintConsent,
  ) => Promise<RecordingPerson>;
  /** Forget a person's voice and withdraw their agreement. */
  forgetVoice: (personId: string) => Promise<RecordingPerson>;
} {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    [
      "listRecordingPeople",
      "createRecordingPerson",
      "rememberRecordingPersonVoice",
      "forgetRecordingPersonVoice",
    ],
    "useRecordingPeople",
  );
  const query = options.query;
  const load = useCallback(
    async () => await client.listRecordingPeople(workspaceId, query ? { query } : {}),
    [client, workspaceId, query],
  );
  const state = usePolledValue(load, { enabled: options.enabled });
  const refresh = state.refresh;
  return {
    people: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refresh,
    create: useCallback(
      async (request: CreateRecordingPersonRequest) => {
        const person = await client.createRecordingPerson(workspaceId, request);
        await refresh();
        return person;
      },
      [client, workspaceId, refresh],
    ),
    rememberVoice: useCallback(
      async (personId: string, consent: RecordingVoiceprintConsent) => {
        const person = await client.rememberRecordingPersonVoice(workspaceId, personId, {
          consent,
        });
        await refresh();
        return person;
      },
      [client, workspaceId, refresh],
    ),
    forgetVoice: useCallback(
      async (personId: string) => {
        const person = await client.forgetRecordingPersonVoice(workspaceId, personId);
        await refresh();
        return person;
      },
      [client, workspaceId, refresh],
    ),
  };
}

/**
 * Models this workspace offers, with capabilities, price and the default:
 * `models` make transcripts; `liveModels` stream the live transcript.
 */
export function useRecordingModels(
  options: RecordingsClientOverride & { enabled?: boolean } = {},
): {
  models: ListRecordingModelsResponse["models"];
  liveModels: ListRecordingModelsResponse["models"];
  defaultModel: ListRecordingModelsResponse["default"] | null;
  /** The deployment uses one model for every transcription; workspaces cannot pick. */
  pinned: boolean;
  loading: boolean;
  error: Error | null;
} {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    ["listRecordingModels"],
    "useRecordingModels",
  );
  const load = useCallback(
    async () => await client.listRecordingModels(workspaceId),
    [client, workspaceId],
  );
  const state = usePolledValue(load, { enabled: options.enabled });
  const all = state.data?.models;
  const models = useMemo(() => (all ?? []).filter((entry) => entry.capabilities.batch), [all]);
  const liveModels = useMemo(() => (all ?? []).filter((entry) => entry.capabilities.live), [all]);
  return {
    models,
    liveModels,
    defaultModel: state.data?.default ?? null,
    pinned: state.data?.pinned === true,
    loading: state.loading,
    error: state.error,
  };
}

// --- Notes -------------------------------------------------------------------

/** How often an open meeting checks for notes someone else, or an agent, saved. */
const NOTES_POLL_MS = 15_000;

export type UseRecordingNotesOptions = RecordingsClientOverride & {
  enabled?: boolean;
  /** Check for notes saved elsewhere this often; default 15 seconds, 0 to never. */
  pollIntervalMs?: number;
};

export type UseRecordingNotesResult = {
  /** What people jotted down while the meeting was recorded. */
  notepad: RecordingNote | null;
  /** The written-up summary, decisions and action items. */
  notes: RecordingNote | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  /**
   * Replace the notepad or the notes. The notes are saved against the revision
   * this hook last read, so a newer save made elsewhere fails with 409
   * `notes_changed` instead of being overwritten; the notepad, saved as people
   * type, always wins.
   */
  save: (kind: RecordingNoteKind, body: string) => Promise<RecordingNote>;
};

/** A meeting's notepad and notes, kept fresh while it is open. */
export function useRecordingNotes(
  recordingId: string | null,
  options: UseRecordingNotesOptions = {},
): UseRecordingNotesResult {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    ["listRecordingNotes", "saveRecordingNote"],
    "useRecordingNotes",
  );
  const load = useCallback(
    async () =>
      recordingId ? (await client.listRecordingNotes(workspaceId, recordingId)).notes : [],
    [client, workspaceId, recordingId],
  );
  const pollIntervalMs = options.pollIntervalMs ?? NOTES_POLL_MS;
  const state = usePolledValue(load, {
    enabled: (options.enabled ?? true) && recordingId !== null,
    ...(pollIntervalMs > 0 ? { pollIntervalMs } : {}),
  });
  const notes = state.data ?? [];
  const notepad = notes.find((note) => note.kind === "notepad") ?? null;
  const written = notes.find((note) => note.kind === "notes") ?? null;
  const writtenRevision = written?.revision ?? 0;
  const refresh = state.refresh;
  return {
    notepad,
    notes: written,
    loading: state.loading,
    error: state.error,
    refresh,
    save: useCallback(
      async (kind: RecordingNoteKind, body: string) => {
        if (!recordingId) throw new Error("No recording selected.");
        const saved = await client.saveRecordingNote(workspaceId, recordingId, kind, {
          body,
          ...(kind === "notes" ? { expectedRevision: writtenRevision } : {}),
        });
        await refresh();
        return saved;
      },
      [client, workspaceId, recordingId, writtenRevision, refresh],
    ),
  };
}
