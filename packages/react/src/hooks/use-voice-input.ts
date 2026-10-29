import type { ClientVoiceInputConfig, RecordingTranscriptVersion } from "@opengeni/contracts";
import type { OpenGeniClient } from "@opengeni/sdk";
import {
  OpenGeniRecordingsClient,
  RecordingUploader,
  browserRecorderPlatform,
  type OpenGeniRecordingsTransport,
  type Recorder,
  type RecorderPlatform,
  type RecordingChunkStore,
  type RecordingTransport,
  type RecordingUploadStatus,
  uploadRecordingAudio,
} from "@opengeni/sdk/recordings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { VoiceRecordingStore } from "../voice-recording-store";
import { appendFinalTranscript } from "./use-transcription";

export type VoiceInputStatus =
  | "idle"
  | "requesting-permission"
  | "recording"
  | "saving"
  | "transcribing"
  | "retrying"
  | "recovered"
  | "transcript-ready"
  | "error";

/** The recording calls dictation makes, as `OpenGeniRecordingsClient` provides them. */
export type VoiceInputRecordingsClient = Pick<
  OpenGeniRecordingsClient,
  | "createRecording"
  | "createRecordingUploads"
  | "completeRecordingChunks"
  | "finalizeRecording"
  | "deleteRecording"
  | "listRecordings"
  | "listRecordingTranscriptVersions"
  | "getRecordingTranscript"
  | "createRecordingTranscript"
>;

export type UseVoiceInputOptions = {
  /**
   * The SDK client. Dictation records through its recordings API; a client
   * with only `transcribeAudio` records in memory and sends one request.
   */
  client: VoiceInputClient | null;
  workspaceId: string;
  capability: ClientVoiceInputConfig | null;
  enabled: boolean;
  value: string;
  setValue: (value: string) => void;
  focusInput: () => void;
  disabled?: boolean | undefined;
  /**
   * The language spoken, as an ISO 639-1 or 639-3 code ("nb", "en"). Omitted
   * or null detects it. Each dictation keeps the language it was started in.
   */
  language?: string | null | undefined;
  /**
   * Names and words to listen for, such as the person's vocabulary: at most
   * 100, each up to 50 characters. Each dictation keeps the ones it started with.
   */
  keyterms?: readonly string[] | undefined;
  /**
   * Asked before each new dictation takes the microphone, such as a host's
   * consent prompt. Resolving false (or throwing) keeps the microphone off.
   */
  beforeStart?: (() => boolean | Promise<boolean>) | undefined;
  /**
   * Offer dictations an earlier page, tab or device left in this workspace
   * (default). Off for a host that dictates somewhere else, such as the
   * desktop app's dictation from anywhere: the composer offers them instead.
   */
  recover?: boolean | undefined;
  /**
   * A copy of each dictation's speech once capture ends, for a host that keeps
   * it on the device (the desktop app's dictation history). When the person
   * cancels a dictation, its copy comes with `cancelled` set (again, when
   * capture had already ended): the dictation itself is deleted, so this copy
   * is all that is left of it.
   */
  onAudio?: ((audio: VoiceInputAudio) => void) | undefined;
  /** A recordings client, such as a host proxy. Built from `client` otherwise. */
  recordings?: Partial<VoiceInputRecordingsClient> | undefined;
  /** How this device records; the browser's by default. */
  platform?: RecorderPlatform | undefined;
  /** How often a dictation's transcript is checked. Default 1 second. */
  pollIntervalMilliseconds?: number | undefined;
  now?: (() => Date) | undefined;
  /** @deprecated Dictations are kept by the shared recording store; ignored. */
  createRecordingStore?: (() => VoiceRecordingStore) | undefined;
  /** @deprecated The recorder chooses the recording id; ignored. */
  createRecordingId?: (() => string) | undefined;
  /** @deprecated Recordings are claimed with Web Locks; ignored. */
  createOwnerId?: (() => string) | undefined;
  /** @deprecated The server retries transcription itself; ignored. */
  automaticRetryDelayMilliseconds?: number | undefined;
};

type VoiceInputClient = Pick<OpenGeniClient, "transcribeAudio"> &
  Partial<Pick<OpenGeniClient, "requestJson">>;

/** A dictation's speech, as recorded. */
export type VoiceInputAudio = {
  /** The dictation's recording; null for one sent in a single request. */
  recordingId: string | null;
  audio: Blob;
  durationMilliseconds: number;
  /**
   * The person cancelled the dictation and it is deleted. Speech shorter than
   * a few seconds is taken for an accidental start and never comes; capture
   * cut short by Cancel may miss its last second.
   */
  cancelled?: boolean;
};

export type UseVoiceInputResult = {
  status: VoiceInputStatus;
  error: string | null;
  available: boolean;
  /** Live mic stream while recording; null once stopped/cancelled. */
  stream: MediaStream | null;
  recordingId: string | null;
  durationSeconds: number;
  /** Wall-clock start of the current capture (epoch ms), or null when not recording. */
  recordingStartedAt: number | null;
  /** Capture stops and transcribes automatically after this many seconds. */
  maxRecordingSeconds: number | null;
  /** The speech is saved (on this device or the server) and isn't lost by a reload. */
  locallySaved: boolean;
  hasRecoverableRecording: boolean;
  savedTranscript: string | null;
  /** The microphone's level from 0 to 1 while recording, when the recorder meters it. */
  level: () => number | null;
  start: () => Promise<boolean>;
  /** Stop capture, then transcribe into the draft. */
  stop: () => void;
  /** Transcribe a saved dictation again, or keep waiting for one still being heard. */
  retry: () => void;
  /** Insert a saved transcript into the draft. */
  insertSavedTranscript: () => Promise<void>;
  /**
   * The person's Cancel or Escape: delete the dictation under way, recording
   * or transcribing, so nothing offers it again. Its speech goes to `onAudio`
   * first, marked cancelled, for a host that keeps it. A saved dictation an
   * earlier page left only stops being retried and stays offered.
   */
  cancel: () => void;
  /**
   * Stop without transcribing and keep the speech here, to insert, retry or
   * discard later: for something other than the person ending the dictation,
   * such as another chat opening or live voice taking over. A start of a few
   * seconds is deleted.
   */
  setAside: () => void;
  /** Intentionally delete the current dictation. */
  discard: () => Promise<void>;
  /**
   * Let go of the current dictation without deleting it: a recording stops
   * and uploads, and a held one stays saved for the next composer to offer.
   */
  release: () => void;
  /**
   * Transcribe speech this page already has (a dictation kept on the device)
   * as a new dictation, uploaded the way a recorded one is; its text arrives
   * as a recorded dictation's does. Resolves false when it can't start: not
   * idle, or no recordings client.
   */
  transcribe: (audio: Blob, options?: { durationMilliseconds?: number }) => Promise<boolean>;
};

export const VOICE_RECORDING_TIMESLICE_MILLISECONDS = 1_000;
/** @deprecated Dictations no longer use owner heartbeats. */
export const VOICE_RECORDING_OWNER_HEARTBEAT_MILLISECONDS = 5_000;
/** @deprecated Dictations no longer use owner heartbeats. */
export const VOICE_RECORDING_OWNER_STALE_MILLISECONDS = 30_000;
/** The longest one-shot dictation, recorded in memory and sent in one request. */
export const VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS = 600;
/** The longest dictation recorded through the recordings API. */
export const VOICE_RECORDING_RESUMABLE_CLIENT_MAX_DURATION_SECONDS = 8 * 60 * 60;
// A dictation ended this soon is taken for an accidental start: nothing of it is kept.
const ACCIDENTAL_START_MAX_MILLISECONDS = 3_000;
const DEFAULT_POLL_MILLISECONDS = 1_000;
const MAX_POLL_MILLISECONDS = 15_000;
const TAKEN_STORAGE_KEY = "opengeni.voice-input.taken.v1";
const MIME_PREFERENCES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"];
const currentDate = () => new Date();

const recordingClients = new WeakMap<object, OpenGeniRecordingsClient>();

/**
 * The recordings client dictation uses, or null when only one-shot
 * transcription is possible (no recordings client, or the deployment can't
 * keep dictations).
 */
function dictationClient(
  explicit: Partial<VoiceInputRecordingsClient> | undefined,
  client: VoiceInputClient | null,
): VoiceInputRecordingsClient | null {
  let candidate: object | undefined = explicit;
  if (!candidate && client && typeof client.requestJson === "function") {
    candidate = recordingClients.get(client);
    if (!candidate) {
      const created = new OpenGeniRecordingsClient(client as OpenGeniRecordingsTransport);
      recordingClients.set(client, created);
      candidate = created;
    }
  }
  if (!candidate) return null;
  const methods = candidate as Record<string, unknown>;
  const required: Array<keyof VoiceInputRecordingsClient> = [
    "createRecording",
    "createRecordingUploads",
    "completeRecordingChunks",
    "finalizeRecording",
    "deleteRecording",
    "listRecordings",
    "listRecordingTranscriptVersions",
    "getRecordingTranscript",
    "createRecordingTranscript",
  ];
  return required.every((method) => typeof methods[method] === "function")
    ? (candidate as VoiceInputRecordingsClient)
    : null;
}

/** What one dictation is doing, outside React state so async work reads it current. */
type Dictation = {
  recordingId: string;
  /** Insert the text as soon as it is ready; off once set aside or recovered. */
  autoInsert: boolean;
  /** Dictated here and now, not one an earlier page left: Cancel deletes it. */
  fresh: boolean;
  text: string | null;
};

/**
 * Dictation for a composer: record the microphone, transcribe it with the
 * workspace's voice input, and add the text to the draft without sending.
 *
 * Each dictation is a recording (purpose `dictation`): saved on the device
 * every second, uploaded as it is spoken, transcribed by the server, private
 * to its speaker and deleted a day after it is heard. Closing the tab, losing
 * the connection or a failed transcription loses nothing: the next composer
 * that opens in this workspace offers the saved text. Taking the text deletes
 * the dictation first, so two tabs never insert the same speech.
 */
export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputResult {
  const { workspaceId, capability, enabled, value, focusInput, disabled = false } = options;
  const sdkClient = options.client;
  const recordings = useMemo(
    () => dictationClient(options.recordings, sdkClient),
    [options.recordings, sdkClient],
  );
  const defaultPlatform = useMemo(() => browserRecorderPlatform(), []);
  const platform = options.platform ?? defaultPlatform;
  const durable = Boolean(recordings && capability?.resumable && platform.supported);

  const [status, setStatus] = useState<VoiceInputStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [savedTranscript, setSavedTranscript] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const errorRef = useRef<string | null>(null);
  errorRef.current = error;

  const latest = useRef({
    ...options,
    recordings,
    platform,
    durable,
    disabled,
    value,
  });
  latest.current = { ...options, recordings, platform, durable, disabled, value };
  const statusRef = useRef(status);
  statusRef.current = status;
  const generationRef = useRef(0);
  const dictationRef = useRef<Dictation | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const oneShotRef = useRef<OneShotCapture | null>(null);
  /** The language the in-memory dictation was started in. */
  const oneShotLanguage = useRef<string | null>(null);
  /** A start is waiting on `beforeStart`; another start is ignored meanwhile. */
  const gatingRef = useRef(false);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploaderRef = useRef<RecordingUploader | null>(null);
  /** The speech of the dictation being recorded, copied as it is saved, for `onAudio`. */
  const audioCopies = useRef(new Map<string, AudioCopy>());
  /** The copy `onAudio` was given for the dictation in hand, to give again if it is cancelled. */
  const handed = useRef<VoiceInputAudio | null>(null);
  const startedAtRef = useRef(0);
  /** Text a one-shot dictation heard while it couldn't go into the draft. */
  const oneShotText = useRef<string | null>(null);
  /** `watch`, for the callbacks declared before it (it calls them in turn). */
  const watchRef = useRef<
    (dictation: Dictation, versionId: string | null, generation: number) => Promise<void>
  >(async () => undefined);
  /** `loadSaved`, to look again once a leftover upload lands. */
  const loadSavedRef = useRef<(generation: number) => Promise<void>>(async () => undefined);

  const now = useCallback(() => (latest.current.now ?? currentDate)(), []);

  const maxRecordingSeconds = capability
    ? durable && capability.resumable
      ? Math.min(
          capability.resumable.maxDurationSeconds,
          VOICE_RECORDING_RESUMABLE_CLIENT_MAX_DURATION_SECONDS,
        )
      : Math.min(capability.maxDurationSeconds, VOICE_RECORDING_CLIENT_MAX_DURATION_SECONDS)
    : null;
  const maxRecordingSecondsRef = useRef(maxRecordingSeconds);
  maxRecordingSecondsRef.current = maxRecordingSeconds;

  /** Calls the latest recordings client, so a refreshed sign-in reaches running uploads. */
  const transport = useMemo<RecordingTransport>(() => {
    const current = () => {
      const found = latest.current.recordings;
      if (!found) throw new Error("Dictation needs a recordings client.");
      return found;
    };
    return {
      createRecording: (...args) => current().createRecording(...args),
      createRecordingUploads: (...args) => current().createRecordingUploads(...args),
      completeRecordingChunks: (...args) => current().completeRecordingChunks(...args),
      finalizeRecording: (...args) => current().finalizeRecording(...args),
      deleteRecording: (...args) => current().deleteRecording(...args),
    };
  }, []);

  const uploader = useCallback((): RecordingUploader => {
    if (!uploaderRef.current) {
      const current = latest.current.platform;
      const isCaptureActive = current.isCaptureActive;
      uploaderRef.current = new RecordingUploader({
        client: transport,
        store: copyingStore(current.createStore(), audioCopies.current),
        ...(current.fetch ? { fetch: current.fetch } : {}),
        ...(isCaptureActive ? { isCaptureActive: (id: string) => isCaptureActive(id) } : {}),
      });
    }
    return uploaderRef.current;
  }, [transport]);

  const clearStopTimer = () => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
  };

  /** Nothing in hand: back to the microphone button. */
  const settleIdle = useCallback(() => {
    dictationRef.current = null;
    recorderRef.current = null;
    oneShotRef.current = null;
    handed.current = null;
    clearStopTimer();
    setStatus("idle");
    setError(null);
    setStream(null);
    setRecordingId(null);
    setDurationSeconds(0);
    setRecordingStartedAt(null);
    setSavedTranscript(null);
    setHeld(false);
  }, []);

  /**
   * Keep a dictation to insert, retry or discard later. `autoInsert` stays on
   * only for text that arrived while a send held the composer.
   */
  const hold = useCallback(
    (
      dictation: Dictation,
      next: VoiceInputStatus,
      code: string | null = null,
      autoInsert = false,
    ) => {
      dictationRef.current = { ...dictation, autoInsert };
      setRecordingId(dictation.recordingId);
      setSavedTranscript(dictation.text);
      setHeld(true);
      setStatus(next);
      setError(code);
      setStream(null);
      setRecordingStartedAt(null);
    },
    [],
  );

  const insertText = useCallback((text: string) => {
    const { setValue: write, focusInput: focus } = latest.current;
    write(appendFinalTranscript(latest.current.value, text));
    focus();
  }, []);

  /** Give the host its copy of a dictation's speech; its trouble is its own. */
  const giveAudio = useCallback((audio: VoiceInputAudio) => {
    try {
      latest.current.onAudio?.(audio);
    } catch {
      // The host's copy is its own concern; the dictation goes on.
    }
  }, []);

  /** Look for a dictation an earlier page, tab or device left with this workspace. */
  const loadSaved = useCallback(
    async (generation: number): Promise<void> => {
      const client = latest.current.recordings;
      const workspace = latest.current.workspaceId;
      if (!client || !latest.current.durable || latest.current.recover === false) return;
      // Dictations a closed page or crashed app left on this device: finish
      // uploading them here.
      const resumed = await uploader()
        .resume({
          only: (stored) =>
            stored.create.purpose === "dictation" && stored.workspaceId === workspace,
        })
        .catch((): string[] => []);
      let listed;
      try {
        listed = await client.listRecordings(workspace, { purpose: "dictation", limit: 10 });
      } catch {
        return;
      }
      if (generation !== generationRef.current || dictationRef.current) return;
      const taken = readTaken();
      const listedIds = new Set(listed.recordings.map((recording) => recording.id));
      for (const recording of listed.recordings) {
        if (taken.has(recording.id)) {
          // Its text went into a draft while the delete couldn't reach the server.
          void client.deleteRecording(workspace, recording.id).then(
            () => forgetTaken(recording.id),
            (cause: unknown) => {
              if (httpStatus(cause) === 404) forgetTaken(recording.id);
            },
          );
          continue;
        }
        const dictation: Dictation = {
          recordingId: recording.id,
          autoInsert: false,
          fresh: false,
          text: null,
        };
        if (recording.state === "capturing") {
          // Still being spoken in another tab or on another device: that composer owns it.
          if (!resumed.includes(recording.id)) continue;
          // Left behind on this device: hold it while its last chunks upload.
          hold(dictation, "retrying");
          void uploader()
            .finish(recording.id)
            .then(
              (upload) => {
                if (generation !== generationRef.current) return;
                if (upload.discarded) settleIdle();
                else if (upload.failed)
                  hold(dictation, "error", voiceInputCode(upload.failed.code));
                else void watchRef.current(dictation, null, generation);
              },
              () => undefined,
            );
          return;
        }
        if (recording.state === "failed") {
          hold(
            dictation,
            "error",
            voiceInputCode(recording.transcript?.errorCode ?? recording.errorCode),
          );
          return;
        }
        hold(dictation, recording.state === "ready" ? "transcribing" : "retrying");
        void watchRef.current(dictation, null, generation);
        return;
      }
      // One the server hasn't heard of yet: offer it once its upload lands.
      const unlisted = resumed.filter((id) => !listedIds.has(id));
      if (unlisted.length > 0) {
        void Promise.any(unlisted.map((id) => uploader().finish(id))).then(
          () => {
            if (generation === generationRef.current && !dictationRef.current) {
              void loadSavedRef.current(generation);
            }
          },
          () => undefined,
        );
      }
    },
    [hold, settleIdle, uploader],
  );
  loadSavedRef.current = loadSaved;

  /** Take the text: delete the dictation, then insert it once. */
  const take = useCallback(
    async (dictation: Dictation, text: string, generation: number): Promise<void> => {
      const client = latest.current.recordings;
      const workspace = latest.current.workspaceId;
      let insert = true;
      if (client) {
        try {
          await client.deleteRecording(workspace, dictation.recordingId);
        } catch (cause) {
          if (httpStatus(cause) === 404) {
            // Another tab took it, or it expired: never insert it twice.
            insert = false;
          } else {
            // The server is out of reach: insert now and delete it later.
            rememberTaken(dictation.recordingId);
          }
        }
      }
      if (generation !== generationRef.current) {
        if (insert && text.trim()) rememberTaken(dictation.recordingId);
        return;
      }
      if (insert && text.trim()) insertText(text);
      settleIdle();
      void loadSaved(generation);
    },
    [insertText, loadSaved, settleIdle],
  );

  /** Wait for the server to hear a dictation, then insert or hold its text. */
  const watch = useCallback(
    async (dictation: Dictation, versionId: string | null, generation: number): Promise<void> => {
      const client = latest.current.recordings;
      const workspace = latest.current.workspaceId;
      if (!client) return;
      let delay = latest.current.pollIntervalMilliseconds ?? DEFAULT_POLL_MILLISECONDS;
      for (;;) {
        if (generation !== generationRef.current) return;
        let version: RecordingTranscriptVersion | undefined;
        try {
          const versions = await client.listRecordingTranscriptVersions(
            workspace,
            dictation.recordingId,
          );
          version = versionId
            ? versions.find((item) => item.id === versionId)
            : [...versions].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
        } catch (cause) {
          if (httpStatus(cause) === 404) {
            if (generation === generationRef.current) settleIdle();
            return;
          }
          // Offline or a server hiccup: keep the dictation and keep checking.
          delay = Math.min(MAX_POLL_MILLISECONDS, delay * 2);
        }
        if (generation !== generationRef.current) return;
        if (version?.state === "failed") {
          hold(dictation, "error", voiceInputCode(version.errorCode));
          return;
        }
        if (version?.state === "complete") {
          const text = await transcriptText(client, workspace, dictation.recordingId, version.id);
          if (generation !== generationRef.current) return;
          if (text === null) {
            delay = Math.min(MAX_POLL_MILLISECONDS, delay * 2);
          } else {
            const current = dictationRef.current;
            const automatic =
              current?.recordingId === dictation.recordingId &&
              current.autoInsert &&
              !latest.current.disabled;
            if (automatic) {
              await take(dictation, text, generation);
            } else {
              // Set aside, recovered, or a send holds the composer: keep it,
              // and insert it once the send is done unless it was set aside.
              const waitingForSend =
                current?.recordingId === dictation.recordingId && current.autoInsert;
              hold({ ...dictation, text }, "transcript-ready", null, waitingForSend);
            }
            return;
          }
        }
        await sleep(delay);
      }
    },
    [hold, settleIdle, take],
  );
  watchRef.current = watch;

  const finishOneShot = useCallback(
    async (capture: OneShotCapture, generation: number, autoInsert: boolean) => {
      const audio = await capture.stop();
      oneShotRef.current = null;
      if (generation !== generationRef.current) return;
      if (!audio || audio.size === 0) {
        settleIdle();
        return;
      }
      const copy: VoiceInputAudio = {
        recordingId: null,
        audio,
        durationMilliseconds: Math.round(capture.durationSeconds() * 1_000),
      };
      giveAudio(copy);
      handed.current = copy;
      const maxBytes = latest.current.capability?.maxSizeBytes;
      if (maxBytes !== undefined && audio.size > maxBytes) {
        settleIdle();
        setStatus("error");
        setError("too_large");
        return;
      }
      const client = latest.current.client;
      if (!client) return;
      setStatus("transcribing");
      try {
        const response = await client.transcribeAudio(latest.current.workspaceId, {
          audio,
          mimeType: audio.type || capture.mimeType,
          durationSeconds: capture.durationSeconds(),
          ...(oneShotLanguage.current ? { language: oneShotLanguage.current } : {}),
        });
        if (generation !== generationRef.current) return;
        if (autoInsert && !latest.current.disabled) {
          insertText(response.text);
          settleIdle();
        } else {
          // Kept in memory only: it is gone if the page closes.
          oneShotText.current = response.text;
          setSavedTranscript(response.text);
          setHeld(true);
          setStatus("transcript-ready");
        }
      } catch (cause) {
        if (generation !== generationRef.current) return;
        settleIdle();
        setStatus("error");
        setError(errorCode(cause));
      }
    },
    [giveAudio, insertText, settleIdle],
  );

  const finishCapture = useCallback(
    async (autoInsert: boolean) => {
      const generation = generationRef.current;
      clearStopTimer();
      const oneShot = oneShotRef.current;
      if (oneShot) {
        setStatus("saving");
        setStream(null);
        await finishOneShot(oneShot, generation, autoInsert);
        return;
      }
      const recorder = recorderRef.current;
      if (!recorder) return;
      const id = recorder.snapshot.recordingId;
      const elapsed = recorder.snapshot.elapsedMilliseconds;
      setStatus(autoInsert ? "saving" : "recovered");
      setStream(null);
      setRecordingStartedAt(null);
      if (dictationRef.current) dictationRef.current.autoInsert = autoInsert;
      let upload: RecordingUploadStatus | null;
      try {
        upload = await recorder.stop();
      } catch {
        upload = null;
      }
      recorderRef.current = null;
      const audio = id ? takeCopy(audioCopies.current, id) : null;
      if (generation !== generationRef.current || !id) return;
      if (!upload || upload.discarded) {
        settleIdle();
        return;
      }
      if (audio && latest.current.onAudio && !upload.failed) {
        const copy: VoiceInputAudio = { recordingId: id, audio, durationMilliseconds: elapsed };
        giveAudio(copy);
        handed.current = copy;
      }
      const dictation = dictationRef.current ?? {
        recordingId: id,
        autoInsert,
        fresh: true,
        text: null,
      };
      if (upload.failed) {
        await uploader()
          .discard(id)
          .catch(() => undefined);
        settleIdle();
        setStatus("error");
        setError(voiceInputCode(upload.failed.code));
        return;
      }
      const versionId = uploader().finalized.get(id)?.transcript.id ?? null;
      if (dictation.autoInsert) setStatus("transcribing");
      else hold(dictation, "recovered");
      await watch(dictation, versionId, generation);
    },
    [finishOneShot, giveAudio, hold, settleIdle, uploader, watch],
  );

  const stop = useCallback(() => {
    if (statusRef.current !== "recording") return;
    void finishCapture(true);
  }, [finishCapture]);

  const beginCapture = useCallback(
    (input: MediaStream | null, id: string | null) => {
      startedAtRef.current = now().getTime();
      setStream(input);
      setRecordingId(id);
      setDurationSeconds(0);
      setRecordingStartedAt(startedAtRef.current);
      setStatus("recording");
      const limit = maxRecordingSecondsRef.current;
      if (limit) {
        stopTimerRef.current = setTimeout(() => {
          if (statusRef.current === "recording") void finishCapture(true);
        }, limit * 1_000);
      }
    },
    [finishCapture, now],
  );

  const start = useCallback(async (): Promise<boolean> => {
    const startable = () => {
      const current = latest.current;
      return !(
        (!current.durable && !current.client) ||
        !current.capability?.available ||
        !current.enabled ||
        current.disabled ||
        statusRef.current === "requesting-permission" ||
        statusRef.current === "recording" ||
        statusRef.current === "saving" ||
        statusRef.current === "transcribing" ||
        dictationRef.current
      );
    };
    if (gatingRef.current || !startable()) return false;
    const gate = latest.current.beforeStart;
    if (gate) {
      gatingRef.current = true;
      let allowed = false;
      try {
        allowed = await gate();
      } catch {
        allowed = false;
      } finally {
        gatingRef.current = false;
      }
      if (!allowed || !startable()) return false;
    }
    const current = latest.current;
    if (!current.capability) return false;
    const generation = ++generationRef.current;
    setStatus("requesting-permission");
    setError(null);
    const language = current.language || null;
    if (!current.durable) {
      oneShotLanguage.current = language;
      const capture = await startOneShot(current.capability.acceptedMimeTypes);
      if (generation !== generationRef.current) {
        if (!(capture instanceof Error)) await capture.stop();
        return false;
      }
      if (capture instanceof Error) {
        setStatus("error");
        setError(errorCode(capture));
        return false;
      }
      oneShotRef.current = capture;
      beginCapture(capture.stream, null);
      return true;
    }
    const transcription = dictationTranscription(language, current.keyterms);
    // One dictation at a time: a copy left by an earlier one is dropped.
    audioCopies.current.clear();
    const copying = Boolean(current.onAudio);
    const recorder = current.platform.createRecorder({
      client: transport,
      workspaceId: current.workspaceId,
      purpose: "dictation",
      microphone: true,
      ...(transcription ? { transcription } : {}),
      uploader: uploader(),
      timesliceMilliseconds: VOICE_RECORDING_TIMESLICE_MILLISECONDS,
      keepAwake: false,
      onChange: (snapshot) => {
        if (recorderRef.current !== recorder) return;
        // The id is known before the first chunk is saved.
        if (copying && snapshot.recordingId && !audioCopies.current.has(snapshot.recordingId)) {
          audioCopies.current.set(snapshot.recordingId, { mimeType: null, parts: [] });
        }
        setDurationSeconds(snapshot.elapsedMilliseconds / 1_000);
        // The server refused the dictation (voice input turned off, no credits).
        if (snapshot.state === "recording" && snapshot.upload?.failed) {
          const code = voiceInputCode(snapshot.upload.failed.code);
          recorderRef.current = null;
          dictationRef.current = null;
          void recorder.discard().catch(() => undefined);
          settleIdle();
          setStatus("error");
          setError(code);
        }
      },
    });
    recorderRef.current = recorder;
    await recorder.start();
    if (generation !== generationRef.current) {
      await recorder.discard().catch(() => undefined);
      return false;
    }
    const snapshot = recorder.snapshot;
    if (snapshot.state !== "recording" || !snapshot.recordingId) {
      recorderRef.current = null;
      setStatus("error");
      setError(captureCode(snapshot.error?.code ?? null));
      return false;
    }
    dictationRef.current = {
      recordingId: snapshot.recordingId,
      autoInsert: true,
      fresh: true,
      text: null,
    };
    beginCapture(recorder.inputStream?.(0) ?? null, snapshot.recordingId);
    return true;
  }, [beginCapture, settleIdle, transport, uploader]);

  const discard = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    const recorder = recorderRef.current;
    const oneShot = oneShotRef.current;
    const dictation = dictationRef.current;
    settleIdle();
    oneShotText.current = null;
    audioCopies.current.clear();
    if (oneShot) await oneShot.stop().catch(() => undefined);
    if (recorder) {
      await recorder.discard().catch(() => undefined);
    } else if (dictation) {
      await uploader()
        .discard(dictation.recordingId)
        .catch(() => undefined);
      await latest.current.recordings
        ?.deleteRecording(latest.current.workspaceId, dictation.recordingId)
        .catch(() => undefined);
    }
    focusInput();
    if (generation === generationRef.current) void loadSaved(generation);
  }, [focusInput, loadSaved, settleIdle, uploader]);

  const cancel = useCallback(() => {
    const current = statusRef.current;
    if (current === "requesting-permission") {
      generationRef.current += 1;
      settleIdle();
      return;
    }
    const dictation = dictationRef.current;
    // Speech of a few seconds or more goes to the host before it is deleted.
    const keep = (copy: VoiceInputAudio | null) => {
      if (copy && copy.durationMilliseconds >= ACCIDENTAL_START_MAX_MILLISECONDS) {
        giveAudio({ ...copy, cancelled: true });
      }
    };
    if (current === "recording") {
      const recorder = recorderRef.current;
      const id = recorder?.snapshot.recordingId ?? null;
      if (recorder && id && latest.current.onAudio) {
        // What is saved so far: the deletion below drops the last moment of capture.
        const audio = takeCopy(audioCopies.current, id);
        const spoken = Math.max(
          recorder.snapshot.elapsedMilliseconds,
          now().getTime() - startedAtRef.current,
        );
        if (audio) keep({ recordingId: id, audio, durationMilliseconds: spoken });
      }
      void discard();
      return;
    }
    if (current !== "saving" && current !== "transcribing" && current !== "retrying") return;
    if (dictation && !dictation.fresh) {
      // One an earlier page left: stop retrying it; it stays offered.
      dictation.autoInsert = false;
      setHeld(true);
      setStatus("recovered");
      return;
    }
    // A dictation being heard: in hand (`dictation`), or sent in one request (none).
    if (handed.current) {
      keep(handed.current);
    } else if (dictation && latest.current.onAudio) {
      // Cancelled while its upload finishes: the copy has not been given yet.
      const audio = takeCopy(audioCopies.current, dictation.recordingId);
      const recorder = recorderRef.current;
      if (audio) {
        keep({
          recordingId: dictation.recordingId,
          audio,
          durationMilliseconds: recorder?.snapshot.elapsedMilliseconds ?? 0,
        });
      }
    }
    void discard();
  }, [discard, giveAudio, now, settleIdle]);

  const setAside = useCallback(() => {
    const current = statusRef.current;
    if (current === "requesting-permission") {
      generationRef.current += 1;
      settleIdle();
      return;
    }
    if (current === "recording") {
      const elapsed = now().getTime() - startedAtRef.current;
      if (elapsed < ACCIDENTAL_START_MAX_MILLISECONDS) {
        void discard();
        return;
      }
      // Real speech is never deleted here: it is kept to insert later.
      void finishCapture(false);
      return;
    }
    if (current === "saving" || current === "transcribing" || current === "retrying") {
      const dictation = dictationRef.current;
      if (!dictation) return;
      dictation.autoInsert = false;
      setHeld(true);
      setStatus("recovered");
    }
  }, [discard, finishCapture, now, settleIdle]);

  const retry = useCallback(() => {
    const dictation = dictationRef.current;
    const client = latest.current.recordings;
    if (!dictation || dictation.text !== null || !client || latest.current.disabled) return;
    const generation = ++generationRef.current;
    const failed = statusRef.current === "error" || errorRef.current !== null;
    dictation.autoInsert = true;
    setHeld(false);
    setError(null);
    setStatus("transcribing");
    void (async () => {
      let versionId: string | null = null;
      if (failed) {
        try {
          versionId = (
            await client.createRecordingTranscript(
              latest.current.workspaceId,
              dictation.recordingId,
            )
          ).id;
        } catch (cause) {
          if (generation !== generationRef.current) return;
          if (httpStatus(cause) === 404) {
            settleIdle();
            return;
          }
          hold(dictation, "error", errorCode(cause));
          return;
        }
      }
      await watch(dictation, versionId, generation);
    })();
  }, [hold, settleIdle, watch]);

  const insertSavedTranscript = useCallback(async (): Promise<void> => {
    if (latest.current.disabled) return;
    const generation = ++generationRef.current;
    const dictation = dictationRef.current;
    if (oneShotText.current !== null) {
      insertText(oneShotText.current);
      oneShotText.current = null;
      settleIdle();
      return;
    }
    if (!dictation || dictation.text === null) return;
    await take(dictation, dictation.text, generation);
  }, [insertText, settleIdle, take]);

  const release = useCallback(() => {
    generationRef.current += 1;
    // Capture ends; the upload finishes in the background, as on a workspace change.
    void recorderRef.current?.stop().catch(() => undefined);
    void oneShotRef.current?.stop().catch(() => undefined);
    oneShotText.current = null;
    audioCopies.current.clear();
    settleIdle();
  }, [settleIdle]);

  const transcribe = useCallback(
    async (audio: Blob, timing: { durationMilliseconds?: number } = {}): Promise<boolean> => {
      const current = latest.current;
      const client = current.recordings;
      if (
        !client ||
        !current.durable ||
        current.disabled ||
        !current.enabled ||
        !current.capability?.available ||
        statusRef.current !== "idle" ||
        audio.size === 0
      ) {
        return false;
      }
      const generation = ++generationRef.current;
      const newId = crypto.randomUUID();
      const transcription = dictationTranscription(current.language || null, current.keyterms);
      // Held like a recorded dictation from here on.
      const dictation: Dictation = {
        recordingId: newId,
        autoInsert: true,
        fresh: true,
        text: null,
      };
      dictationRef.current = dictation;
      setRecordingId(newId);
      setError(null);
      setStatus("saving");
      let upload: RecordingUploadStatus;
      try {
        upload = await uploadRecordingAudio({
          uploader: uploader(),
          workspaceId: current.workspaceId,
          recordingId: newId,
          audio,
          durationMilliseconds: timing.durationMilliseconds ?? 0,
          create: { purpose: "dictation", ...(transcription ? { transcription } : {}) },
        });
      } catch (cause) {
        if (generation !== generationRef.current) return false;
        settleIdle();
        setStatus("error");
        setError(errorCode(cause));
        return false;
      }
      if (generation !== generationRef.current) return true;
      if (upload.discarded || upload.failed) {
        await uploader()
          .discard(newId)
          .catch(() => undefined);
        settleIdle();
        setStatus("error");
        setError(upload.failed ? voiceInputCode(upload.failed.code) : "invalid_audio");
        return false;
      }
      if (dictation.autoInsert) setStatus("transcribing");
      else hold(dictation, "recovered");
      void watch(dictation, uploader().finalized.get(newId)?.transcript.id ?? null, generation);
      return true;
    },
    [hold, settleIdle, uploader, watch],
  );

  // A transcript that arrived while a send held the composer goes in once it is free.
  useEffect(() => {
    const dictation = dictationRef.current;
    if (disabled || status !== "transcript-ready" || !dictation?.autoInsert || !dictation.text)
      return;
    void take(dictation, dictation.text, ++generationRef.current);
  }, [disabled, status, take]);

  // A new workspace: let go of this one's dictation (it stays saved there) and
  // look for one saved in the new one.
  useEffect(() => {
    const generation = ++generationRef.current;
    const recorder = recorderRef.current;
    if (recorder) {
      // Capture ends with the workspace; the upload finishes in the background.
      void recorder.stop().catch(() => undefined);
    }
    void oneShotRef.current?.stop().catch(() => undefined);
    settleIdle();
    oneShotText.current = null;
    if (durable) void loadSaved(generation);
  }, [workspaceId, durable, loadSaved, settleIdle]);

  useEffect(() => {
    // No document (React Native): there is no Escape key to listen for.
    if (typeof document === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        // A dialog, menu, or popover that handled Escape owns it.
        !event.defaultPrevented &&
        (status === "requesting-permission" ||
          status === "recording" ||
          status === "saving" ||
          status === "transcribing" ||
          status === "retrying")
      ) {
        event.preventDefault();
        cancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cancel, status]);

  const level = useCallback((): number | null => {
    const levels = recorderRef.current?.levels();
    const first = levels?.[0];
    return typeof first === "number" ? first : null;
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      clearStopTimer();
      // Unmounting while recording keeps the speech: capture stops and the
      // dictation is uploaded and transcribed, for the next composer to offer.
      void recorderRef.current?.stop().catch(() => undefined);
      recorderRef.current = null;
      void oneShotRef.current?.stop().catch(() => undefined);
      oneShotRef.current = null;
      uploaderRef.current = null;
    },
    [],
  );

  return {
    status,
    error,
    available: Boolean(
      capability?.available && enabled && !disabled && (durable || canRecordInMemory()),
    ),
    stream,
    recordingId,
    durationSeconds,
    recordingStartedAt: status === "recording" ? recordingStartedAt : null,
    maxRecordingSeconds,
    locallySaved: durable && recordingId !== null,
    hasRecoverableRecording: held && status !== "recording",
    savedTranscript,
    level,
    start,
    stop,
    retry,
    insertSavedTranscript,
    cancel,
    setAside,
    discard,
    release,
    transcribe,
  };
}

/** The speech of one dictation, copied chunk by chunk as it is saved. */
type AudioCopy = { mimeType: string | null; parts: Array<Uint8Array | undefined> };

/** One dictation's copied speech as one file, or null when none was saved; the copy is let go. */
function takeCopy(copies: Map<string, AudioCopy>, recordingId: string): Blob | null {
  const copy = copies.get(recordingId);
  copies.delete(recordingId);
  const parts = copy?.parts.filter((part): part is Uint8Array => part !== undefined) ?? [];
  if (!copy || parts.length === 0) return null;
  return new Blob(parts as BlobPart[], copy.mimeType ? { type: copy.mimeType } : {});
}

/** The recording options a dictation sends: its language and the words to listen for. */
function dictationTranscription(
  language: string | null,
  keyterms: readonly string[] | undefined,
): { language?: string; keyterms?: string[] } | null {
  const terms = (keyterms ?? []).map((term) => term.trim()).filter(Boolean);
  if (!language && terms.length === 0) return null;
  return {
    ...(language ? { language } : {}),
    ...(terms.length > 0 ? { keyterms: terms.slice(0, 100) } : {}),
  };
}

/**
 * The recorder's local store, also copying the microphone's chunks of each
 * recording in `copies` as they are saved.
 */
function copyingStore(
  store: RecordingChunkStore,
  copies: Map<string, AudioCopy>,
): RecordingChunkStore {
  return {
    putRecording: async (recording) => {
      const copy = copies.get(recording.recordingId);
      if (copy && !copy.mimeType) {
        copy.mimeType =
          recording.create.tracks.find((track) => track.trackNumber === 0)?.mimeType ?? null;
      }
      await store.putRecording(recording);
    },
    getRecording: (recordingId) => store.getRecording(recordingId),
    listRecordings: () => store.listRecordings(),
    deleteRecording: (recordingId) => store.deleteRecording(recordingId),
    putChunk: async (chunk) => {
      await store.putChunk(chunk);
      const copy = copies.get(chunk.recordingId);
      if (copy && chunk.trackNumber === 0) copy.parts[chunk.chunkNumber] = chunk.bytes;
    },
    listChunks: (recordingId) => store.listChunks(recordingId),
    readChunk: (recordingId, trackNumber, chunkNumber) =>
      store.readChunk(recordingId, trackNumber, chunkNumber),
    deleteChunks: (recordingId, trackNumber, chunkNumbers) =>
      store.deleteChunks(recordingId, trackNumber, chunkNumbers),
  };
}

/** The whole transcript of one version, or null when it couldn't be read now. */
async function transcriptText(
  client: VoiceInputRecordingsClient,
  workspaceId: string,
  recordingId: string,
  versionId: string,
): Promise<string | null> {
  const parts: string[] = [];
  let after: number | undefined;
  try {
    for (;;) {
      const page = await client.getRecordingTranscript(workspaceId, recordingId, {
        versionId,
        ...(after !== undefined ? { after } : {}),
        limit: 500,
      });
      for (const segment of page.segments) parts.push(segment.text.trim());
      if (page.nextAfter === null) break;
      after = page.nextAfter;
    }
  } catch {
    return null;
  }
  return parts.filter(Boolean).join(" ");
}

/** A short dictation recorded in memory, for clients that can only transcribe one request. */
type OneShotCapture = {
  stream: MediaStream;
  mimeType: string;
  durationSeconds: () => number;
  /** Stop and return what was recorded; null if nothing was. */
  stop: () => Promise<Blob | null>;
};

function canRecordInMemory(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

async function startOneShot(accepted: string[]): Promise<OneShotCapture | Error> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (cause) {
    return cause instanceof Error ? cause : new Error(String(cause));
  }
  try {
    const preferred = chooseMimeType(accepted);
    const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
    const parts: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) parts.push(event.data);
    };
    const startedAt = performance.now();
    recorder.start(VOICE_RECORDING_TIMESLICE_MILLISECONDS);
    let stopped: Promise<Blob | null> | null = null;
    return {
      stream,
      mimeType: recorder.mimeType || preferred || "audio/webm",
      durationSeconds: () => (performance.now() - startedAt) / 1_000,
      stop: () =>
        (stopped ??= new Promise<Blob | null>((resolve) => {
          const done = () => {
            for (const track of stream.getTracks()) track.stop();
            resolve(
              parts.length > 0
                ? new Blob(parts, { type: recorder.mimeType || preferred || "audio/webm" })
                : null,
            );
          };
          if (recorder.state === "inactive") return done();
          recorder.addEventListener("stop", done, { once: true });
          recorder.stop();
        })),
    };
  } catch (cause) {
    for (const track of stream.getTracks()) track.stop();
    return cause instanceof Error ? cause : new Error(String(cause));
  }
}

function chooseMimeType(accepted: string[]): string | undefined {
  const normalized = accepted.map((value) => value.trim().toLowerCase());
  return MIME_PREFERENCES.find((mimeType) => {
    const bare = mimeType.split(";")[0] ?? mimeType;
    const allowed =
      normalized.includes(mimeType) ||
      normalized.includes(bare) ||
      normalized.some((candidate) => candidate.split(";")[0] === bare);
    return (
      allowed &&
      (typeof MediaRecorder.isTypeSupported !== "function" ||
        MediaRecorder.isTypeSupported(mimeType))
    );
  });
}

/** A voice input error code the composer explains, from a recording or version code. */
function voiceInputCode(code: string | null): string {
  if (!code) return "unknown";
  if (code.startsWith("voice_")) return voiceInputCode(code.slice("voice_".length));
  if (code.startsWith("provider_")) return "provider";
  switch (code) {
    case "insufficient_credits":
    case "allowance_exhausted":
    case "monthly_model_cost_limit":
    case "policy_blocked":
    case "not_supported":
    case "unavailable":
    case "too_large":
    case "invalid_audio":
    case "network":
    case "provider":
    case "timeout":
      return code;
    case "upstream_unavailable":
    case "storage_unavailable":
      return "unavailable";
    default:
      return "unknown";
  }
}

function captureCode(code: string | null): string {
  switch (code) {
    case "microphone_denied":
      return "permission_denied";
    case "unsupported":
    case "microphone_unavailable":
      return "not_supported";
    case "upload_failed":
      return "unavailable";
    default:
      return "unknown";
  }
}

function errorCode(error: unknown): string {
  const details = (error as { details?: { transcriptionCode?: unknown; code?: unknown } }).details;
  if (typeof details?.transcriptionCode === "string") return details.transcriptionCode;
  if (typeof details?.code === "string") return voiceInputCode(details.code);
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return voiceInputCode(error.code);
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") return "permission_denied";
  if (error instanceof DOMException && error.name === "NotSupportedError") return "not_supported";
  if (error instanceof TypeError) return "network";
  return "unknown";
}

function httpStatus(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Dictations whose text is in a draft but whose delete hasn't reached the server. */
function readTaken(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(TAKEN_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function writeTaken(ids: Set<string>): void {
  try {
    globalThis.localStorage?.setItem(TAKEN_STORAGE_KEY, JSON.stringify([...ids].slice(-50)));
  } catch {
    /* Private mode: the server deletes it within a day anyway. */
  }
}

function rememberTaken(recordingId: string): void {
  const ids = readTaken();
  ids.add(recordingId);
  writeTaken(ids);
}

function forgetTaken(recordingId: string): void {
  const ids = readTaken();
  if (ids.delete(recordingId)) writeTaken(ids);
}
