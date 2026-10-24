import type {
  CreateRecordingPersonRequest,
  ListRecordingModelsResponse,
  Recording,
  RecordingPerson,
  RecordingSpeaker,
  RecordingTranscriptionOptions,
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
  type OpenGeniRecordingsTransport,
} from "@opengeni/sdk/recordings";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { OpenGeniContext } from "../session-context";
import { usePolledValue } from "./internal";

const PROCESSING_POLL_MS = 3_000;

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
  | "listRecordingModels"
>;

/** Refresh every few seconds while `active`, without an extra read when it turns on. */
function useRefreshWhile(active: boolean, refresh: () => Promise<void>): void {
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
      }, PROCESSING_POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [active]);
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
  transcription?: RecordingTranscriptionOptions;
  /** Microphone constraints; false records no microphone. Default: on. */
  microphone?: boolean | MediaTrackConstraints;
  /** Also record shared tab or system audio as its own track (Chromium). Default: off. */
  systemAudio?: boolean;
  timesliceMilliseconds?: number;
  keepAwake?: boolean;
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
   * Recordings from an earlier page or app run this hook is still finishing in
   * the background. Each leaves the list once it is uploaded, removed for having
   * no audio, or failed for good.
   */
  recovered: string[];
  /** Start a new recording; per-recording options override the hook's. */
  start: (
    overrides?: Pick<UseRecorderOptions, "title" | "systemAudio" | "microphone" | "visibility">,
  ) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<void>;
  discard: () => Promise<void>;
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
  const [snapshot, setSnapshot] = useState<RecorderSnapshot>(IDLE_SNAPSHOT);
  const [recovered, setRecovered] = useState<string[]>([]);
  const recorderRef = useRef<Recorder | null>(null);
  const uploaderRef = useRef<RecordingUploader | null>(null);
  const defaultPlatform = useMemo(() => browserRecorderPlatform(), []);
  const platform = options.platform ?? defaultPlatform;
  const platformRef = useRef(platform);
  platformRef.current = platform;
  const support = { supported: platform.supported, systemAudio: platform.systemAudioSupported };
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
        client,
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
  }, [client, store]);

  useEffect(() => {
    if (!support.supported || optionsRef.current.resumePending === false) return;
    let cancelled = false;
    void (async () => {
      // Save what a capture cut short left half-written, then finish everything.
      await platformRef.current.recover?.(store()).catch(() => undefined);
      return await uploader().resume();
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
      const merged = { ...optionsRef.current, ...overrides };
      const recorder = platformRef.current.createRecorder({
        client,
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
        onChange: setSnapshot,
      });
      recorderRef.current = recorder;
      await recorder.start();
    },
    [client, workspaceId, store, uploader],
  );

  return {
    ...snapshot,
    supported: support.supported,
    systemAudioSupported: support.systemAudio,
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

/** The recordings the signed-in person can see, newest first. Polls while any is processing. */
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
  useRefreshWhile(
    options.pollIntervalMs === undefined &&
      (options.enabled ?? true) &&
      recordings.some(isProcessing),
    state.refresh,
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

export type UseRecordingOptions = RecordingsClientOverride & { enabled?: boolean };

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
  rerun: (transcription?: RecordingTranscriptionOptions) => Promise<RecordingTranscriptVersion>;
  setCurrentVersion: (versionId: string) => Promise<void>;
  remove: () => Promise<void>;
};

/** One recording with its transcript versions. Polls while it is being transcribed. */
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
  useRefreshWhile(enabled && nowProcessing, state.refresh);
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
      async (transcription?: RecordingTranscriptionOptions) => {
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
  options: RecordingsClientOverride & { query?: string; enabled?: boolean } = {},
): {
  people: RecordingPerson[];
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  create: (request: CreateRecordingPersonRequest) => Promise<RecordingPerson>;
} {
  const { client, workspaceId } = useEmbeddedRecordings(
    options,
    ["listRecordingPeople", "createRecordingPerson"],
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
  };
}

/** Transcription models this workspace offers, with capabilities, price and the default. */
export function useRecordingModels(
  options: RecordingsClientOverride & { enabled?: boolean } = {},
): {
  models: ListRecordingModelsResponse["models"];
  defaultModel: ListRecordingModelsResponse["default"] | null;
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
  return {
    models: state.data?.models ?? [],
    defaultModel: state.data?.default ?? null,
    loading: state.loading,
    error: state.error,
  };
}
