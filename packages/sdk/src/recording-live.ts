/**
 * The live transcript preview: while a recording is captured, each track is
 * also streamed to a live speech model, so the person recording (and anyone
 * else watching the meeting) can read along. It is a preview; the recording's
 * transcript replaces it when the recording is done.
 *
 * The recorder asks the API for a short-lived grant per track and connects to
 * the provider directly, so audio never passes through Opengeni twice and the
 * workspace's provider key never reaches the device. Finished stretches of
 * text are saved back through the API for other viewers.
 *
 * {@link createLiveTranscriber} is platform-neutral: feed it 16-bit mono PCM
 * with {@link LiveTranscriber.push}. The browser recorder does this for you
 * with `liveTranscript: true`.
 */
import type { RecordingLiveSession } from "@opengeni/contracts";
import type { OpenGeniRecordingsClient } from "./recordings";

/** The client calls a live transcript needs. */
export type LiveTranscriptTransport = Pick<
  OpenGeniRecordingsClient,
  "createRecordingLiveSession" | "appendRecordingLiveSegments"
>;

/** A finished stretch of live text, in milliseconds from the recording's start. */
export type LiveTranscriptSegment = {
  trackNumber: number;
  segmentNumber: number;
  startMilliseconds: number;
  endMilliseconds: number;
  text: string;
};

/**
 * - `connecting`: asking for a session or opening it.
 * - `live`: audio is being transcribed.
 * - `reconnecting`: the connection dropped; audio is held briefly and sent once it is back.
 * - `unavailable`: it can't work here (no provider key, no credit); recording is unaffected.
 * - `closed`: the recording stopped.
 */
export type LiveTranscriptState = "connecting" | "live" | "reconnecting" | "unavailable" | "closed";

export type LiveTranscriptTrackSnapshot = {
  trackNumber: number;
  state: LiveTranscriptState;
  /** Text still being heard, which may change; empty between sentences. */
  partial: string;
  segments: readonly LiveTranscriptSegment[];
  /** Why it is `unavailable` or `reconnecting`. */
  error: { code: string; message: string } | null;
};

export type LiveTranscriber = {
  readonly snapshot: LiveTranscriptTrackSnapshot;
  /**
   * Send captured audio: 16-bit mono PCM at `sampleRate`, starting
   * `recordedMilliseconds` into the recording (excluding pauses).
   */
  push(samples: Int16Array, sampleRate: number, recordedMilliseconds: number): void;
  /** Finish what was heard, save it, and close. */
  close(): Promise<void>;
  /** Close at once without saving anything more, for a discarded recording. */
  abort(): void;
};

export type LiveTranscriberOptions = {
  client: LiveTranscriptTransport;
  workspaceId: string;
  recordingId: string;
  trackNumber: number;
  /** Defaults to the global WebSocket. */
  WebSocket?: LiveWebSocketConstructor;
  onChange?: (snapshot: LiveTranscriptTrackSnapshot) => void;
};

/** The part of the WebSocket API a live transcript uses. */
export type LiveWebSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};
export type LiveWebSocketConstructor = new (url: string) => LiveWebSocket;

const OPEN = 1;
/** Send audio in tenths of a second, as the provider recommends. */
const SEND_MILLISECONDS = 100;
/** Audio held while reconnecting; older audio is dropped from the preview only. */
const HOLD_MILLISECONDS = 15_000;
const SAVE_DELAY_MILLISECONDS = 1_500;
const MIN_BACKOFF_MILLISECONDS = 1_000;
const MAX_BACKOFF_MILLISECONDS = 30_000;
/** How long to wait for the last words after asking the provider to finish. */
const CLOSE_WAIT_MILLISECONDS = 3_000;
/** A plain commit not followed by its timed copy within this long is kept as is. */
const UNTIMED_COMMIT_MILLISECONDS = 1_500;

/** Provider errors that will not go away by reconnecting. */
const FATAL_PROVIDER_ERRORS = new Set([
  "auth_error",
  "quota_exceeded",
  "input_error",
  "invalid_request",
  "chunk_size_exceeded",
  "unaccepted_terms",
]);

type Pending = { samples: Int16Array; recordedMilliseconds: number };

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function pcmBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) view.setInt16(index * 2, samples[index]!, true);
  return bytes;
}

/** Resample 16-bit PCM to `to` Hz by averaging (down) or linear interpolation (up). */
export function resamplePcm16(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  const length = Math.floor((samples.length * to) / from);
  const out = new Int16Array(length);
  const ratio = from / to;
  for (let index = 0; index < length; index++) {
    const start = index * ratio;
    if (ratio >= 1) {
      const begin = Math.floor(start);
      const end = Math.min(samples.length, Math.max(begin + 1, Math.floor(start + ratio)));
      let sum = 0;
      for (let cursor = begin; cursor < end; cursor++) sum += samples[cursor]!;
      out[index] = Math.round(sum / (end - begin));
    } else {
      const left = Math.floor(start);
      const right = Math.min(samples.length - 1, left + 1);
      const fraction = start - left;
      out[index] = Math.round(samples[left]! * (1 - fraction) + samples[right]! * fraction);
    }
  }
  return out;
}

type ProviderWord = { text?: unknown; start?: unknown; end?: unknown; type?: unknown };
type ProviderMessage = {
  message_type?: unknown;
  text?: unknown;
  words?: unknown;
  error?: unknown;
  message?: unknown;
};

/**
 * Stream one track to a live model, holding audio through short outages and
 * saving finished text. Errors never reach the recording itself.
 */
export function createLiveTranscriber(options: LiveTranscriberOptions): LiveTranscriber {
  const Socket =
    options.WebSocket ??
    (globalThis as { WebSocket?: LiveWebSocketConstructor }).WebSocket ??
    null;
  let snapshot: LiveTranscriptTrackSnapshot = {
    trackNumber: options.trackNumber,
    state: Socket ? "connecting" : "unavailable",
    partial: "",
    segments: [],
    error: Socket ? null : { code: "unsupported", message: "This device can't stream audio." },
  };
  const emit = (patch: Partial<LiveTranscriptTrackSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    options.onChange?.(snapshot);
  };

  let session: RecordingLiveSession | null = null;
  let socket: LiveWebSocket | null = null;
  let connecting = false;
  let backoff = MIN_BACKOFF_MILLISECONDS;
  let retryAt = 0;
  let closed = false;
  /** Audio not yet sent, in send order. */
  let pending: Pending[] = [];
  let pendingSamples = 0;
  /** Where the current session's audio starts in the recording. */
  let sessionOffset: number | null = null;
  let sessionSamples = 0;
  let lastCommitEnd = 0;
  let streamedSamples = 0;
  let sampleRate = 16_000;
  let nextSegment = 0;
  let unsaved: LiveTranscriptSegment[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saving: Promise<void> = Promise.resolve();
  let untimed: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  let finished: (() => void) | null = null;

  const unavailable = (code: string, message: string) => {
    closed = true;
    pending = [];
    pendingSamples = 0;
    socket?.close();
    socket = null;
    emit({ state: "unavailable", partial: "", error: { code, message } });
  };

  const scheduleSave = (now = false) => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(
      () => {
        saveTimer = null;
        saving = saving.then(save);
      },
      now ? 0 : SAVE_DELAY_MILLISECONDS,
    );
  };

  const save = async () => {
    do {
      const batch = unsaved.slice(0, 100);
      const streamedMilliseconds = Math.round((streamedSamples / sampleRate) * 1_000);
      try {
        await options.client.appendRecordingLiveSegments(
          options.workspaceId,
          options.recordingId,
          {
            trackNumber: options.trackNumber,
            streamedMilliseconds,
            segments: batch.map(({ trackNumber: _track, ...segment }) => segment),
          },
        );
      } catch {
        // Saving is for other viewers only; try again a little later.
        if (!closed) scheduleSave();
        return;
      }
      unsaved = unsaved.slice(batch.length);
    } while (unsaved.length > 0);
  };

  const addSegment = (text: string, start: number, end: number) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const segment: LiveTranscriptSegment = {
      trackNumber: options.trackNumber,
      segmentNumber: nextSegment++,
      startMilliseconds: Math.max(0, Math.round(start)),
      endMilliseconds: Math.max(Math.round(start), Math.round(end)),
      text: trimmed,
    };
    lastCommitEnd = segment.endMilliseconds;
    unsaved.push(segment);
    emit({ segments: [...snapshot.segments, segment], partial: "" });
    scheduleSave();
  };

  /** Where the session's audio has reached, in recording time. */
  const sessionNow = () => (sessionOffset ?? 0) + (sessionSamples / sampleRate) * 1_000;

  const onMessage = (raw: unknown) => {
    let message: ProviderMessage;
    try {
      message = JSON.parse(String(raw)) as ProviderMessage;
    } catch {
      return;
    }
    const type = typeof message.message_type === "string" ? message.message_type : "";
    const text = typeof message.text === "string" ? message.text : "";
    if (type === "session_started") {
      backoff = MIN_BACKOFF_MILLISECONDS;
      emit({ state: "live", error: null });
    } else if (type === "partial_transcript") {
      emit({ partial: text.trim() });
    } else if (type === "committed_transcript_with_timestamps") {
      if (untimed) clearTimeout(untimed.timer);
      untimed = null;
      const words = (Array.isArray(message.words) ? message.words : []) as ProviderWord[];
      const timed = words.filter(
        (word) =>
          word.type !== "spacing" && typeof word.start === "number" && typeof word.end === "number",
      );
      const offset = sessionOffset ?? 0;
      const start = timed.length > 0 ? offset + (timed[0]!.start as number) * 1_000 : lastCommitEnd;
      const end = timed.length > 0 ? offset + (timed.at(-1)!.end as number) * 1_000 : sessionNow();
      addSegment(text, start, end);
      finished?.();
    } else if (type === "committed_transcript") {
      // The timed copy normally follows at once; keep this one if it doesn't.
      if (untimed) clearTimeout(untimed.timer);
      const end = sessionNow();
      const start = lastCommitEnd;
      untimed = {
        text,
        timer: setTimeout(() => {
          untimed = null;
          addSegment(text, start, end);
          finished?.();
        }, UNTIMED_COMMIT_MILLISECONDS),
      };
    } else if (type.endsWith("_error") || type.includes("exceeded") || type === "throttled" || type === "rate_limited" || type === "queue_overflow" || type === "resource_exhausted" || type === "insufficient_audio_activity") {
      const detail =
        typeof message.error === "string"
          ? message.error
          : typeof message.message === "string"
            ? message.message
            : type;
      if (FATAL_PROVIDER_ERRORS.has(type)) {
        unavailable(
          type,
          type === "quota_exceeded"
            ? "The live transcript stopped: the provider account has no credit left."
            : type === "auth_error"
              ? "The live transcript stopped: the provider refused this workspace's key."
              : `The live transcript stopped: ${detail}`,
        );
      } else {
        emit({ error: { code: type, message: detail } });
      }
    }
  };

  const dropSocket = () => {
    socket = null;
    session = null;
    sessionOffset = null;
    sessionSamples = 0;
    if (closed) return;
    retryAt = Date.now() + backoff;
    backoff = Math.min(MAX_BACKOFF_MILLISECONDS, backoff * 2);
    emit({ state: "reconnecting", partial: "" });
  };

  const connect = async () => {
    if (connecting || closed || !Socket || Date.now() < retryAt) return;
    connecting = true;
    try {
      session = await options.client.createRecordingLiveSession(
        options.workspaceId,
        options.recordingId,
        { trackNumber: options.trackNumber },
      );
    } catch (error) {
      connecting = false;
      const status = (error as { status?: number }).status;
      const code = (error as { details?: { code?: string } }).details?.code;
      // Not found is retried: the recording may not have reached the server yet.
      if (status === 400 || status === 403 || status === 409 || code === "quota_exceeded") {
        unavailable(
          code ?? "unavailable",
          error instanceof Error ? error.message : "The live transcript isn't available.",
        );
        return;
      }
      dropSocket();
      return;
    }
    if (closed) {
      connecting = false;
      return;
    }
    sampleRate = session.audio.sampleRate;
    const opened = new Socket(session.url);
    socket = opened;
    opened.onopen = () => {
      connecting = false;
      flush();
    };
    opened.onmessage = (event) => {
      if (socket === opened) onMessage(event.data);
    };
    opened.onerror = () => undefined;
    opened.onclose = () => {
      connecting = false;
      if (socket !== opened) return;
      dropSocket();
      finished?.();
    };
  };

  /** Send whole tenths of a second of pending audio while connected. */
  const flush = (force = false) => {
    if (!socket || socket.readyState !== OPEN) {
      void connect();
      return;
    }
    const chunk = Math.round((sampleRate * SEND_MILLISECONDS) / 1_000);
    while (pending.length > 0 && (force || pendingSamples >= chunk)) {
      const take = Math.min(pendingSamples, Math.max(chunk, 1));
      const out = new Int16Array(take);
      let filled = 0;
      let first: number | null = null;
      while (filled < take && pending.length > 0) {
        const head = pending[0]!;
        first ??= head.recordedMilliseconds;
        const count = Math.min(take - filled, head.samples.length);
        out.set(head.samples.subarray(0, count), filled);
        filled += count;
        if (count === head.samples.length) pending.shift();
        else
          pending[0] = {
            samples: head.samples.subarray(count),
            recordedMilliseconds: head.recordedMilliseconds + (count / sampleRate) * 1_000,
          };
      }
      pendingSamples -= filled;
      if (sessionOffset === null) {
        sessionOffset = first ?? 0;
        lastCommitEnd = Math.max(lastCommitEnd, sessionOffset);
      }
      socket.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: base64(pcmBytes(out)),
          commit: false,
          sample_rate: sampleRate,
        }),
      );
      sessionSamples += filled;
      streamedSamples += filled;
    }
  };

  return {
    get snapshot() {
      return snapshot;
    },

    push(samples, rate, recordedMilliseconds) {
      if (closed || samples.length === 0) return;
      const converted = resamplePcm16(samples, rate, session?.audio.sampleRate ?? sampleRate);
      // A gap in recording time (a pause) starts a new session, so the
      // provider's clock stays in step with the recording's.
      const expected =
        pending.length > 0
          ? pending.at(-1)!.recordedMilliseconds +
            (pending.at(-1)!.samples.length / sampleRate) * 1_000
          : sessionOffset !== null
            ? sessionNow()
            : null;
      if (expected !== null && Math.abs(recordedMilliseconds - expected) > 500) {
        flush(true);
        const stale = socket;
        if (stale) {
          socket = null;
          session = null;
          sessionOffset = null;
          sessionSamples = 0;
          stale.close();
        }
      }
      pending.push({ samples: converted, recordedMilliseconds });
      pendingSamples += converted.length;
      const hold = (sampleRate * HOLD_MILLISECONDS) / 1_000;
      while (pendingSamples > hold && pending.length > 1) {
        pendingSamples -= pending.shift()!.samples.length;
      }
      flush();
    },

    async close() {
      if (closed) {
        await saving;
        return;
      }
      if (socket && socket.readyState === OPEN) {
        flush(true);
        const open = socket;
        await new Promise<void>((done) => {
          const timer = setTimeout(done, CLOSE_WAIT_MILLISECONDS);
          finished = () => {
            clearTimeout(timer);
            done();
          };
          open.send(
            JSON.stringify({
              message_type: "input_audio_chunk",
              audio_base_64: "",
              commit: true,
              sample_rate: sampleRate,
            }),
          );
        });
        finished = null;
      }
      if (untimed) {
        clearTimeout(untimed.timer);
        const { text } = untimed;
        untimed = null;
        addSegment(text, lastCommitEnd, sessionNow());
      }
      closed = true;
      const open = socket;
      socket = null;
      open?.close();
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      if (unsaved.length > 0 || streamedSamples > 0) {
        saving = saving.then(save);
      }
      await saving;
      emit({ state: "closed", partial: "" });
    },

    abort() {
      if (closed && !socket) return;
      closed = true;
      if (saveTimer) clearTimeout(saveTimer);
      if (untimed) clearTimeout(untimed.timer);
      saveTimer = null;
      untimed = null;
      unsaved = [];
      pending = [];
      pendingSamples = 0;
      const open = socket;
      socket = null;
      open?.close();
      emit({ state: "closed", partial: "" });
    },
  };
}
