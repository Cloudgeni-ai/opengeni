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
 *
 * Providers speak one of the {@link RecordingLiveProtocol}s. ElevenLabs takes
 * the PCM over a WebSocket. OpenAI Realtime (OpenAI and Azure OpenAI) takes
 * the track itself over WebRTC in a browser, where the pushed PCM only keeps
 * the clock, or the PCM over a WebSocket where the WebSocket can carry a
 * header (React Native).
 */
import type { RecordingLiveProtocol, RecordingLiveSession } from "@opengeni/contracts";
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
  /**
   * The recording paused or resumed. Paused audio is not transcribed: a
   * track streamed over WebRTC is muted at once; pushed PCM simply stops.
   */
  setPaused(paused: boolean): void;
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
  /**
   * The WebSocket takes headers as its third argument, as React Native's
   * does, so it can stream to providers that sign in with a header.
   */
  webSocketHeaders?: boolean;
  /**
   * The track's own audio, for providers a browser reaches over WebRTC. The
   * transcriber sends a copy and leaves this one alone.
   */
  mediaTrack?: LiveMediaTrack | null;
  /** Defaults to the global RTCPeerConnection. */
  RTCPeerConnection?: LivePeerConnectionConstructor;
  /** Defaults to the global fetch; posts the WebRTC offer. */
  fetch?: LiveFetch;
  /** A monotonic clock in milliseconds. Defaults to `performance.now()`. */
  now?: () => number;
  onChange?: (snapshot: LiveTranscriptTrackSnapshot) => void;
};

/** The part of `fetch` a WebRTC session uses to post its offer. */
export type LiveFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

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
export type LiveWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> },
) => LiveWebSocket;

/** The part of a `MediaStreamTrack` a live transcript uses. */
export type LiveMediaTrack = {
  enabled: boolean;
  clone(): LiveMediaTrack;
  stop(): void;
};

type LiveDataChannel = {
  readonly readyState: string;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
};

/** The part of an `RTCPeerConnection` a live transcript uses. */
export type LivePeerConnection = {
  readonly connectionState: string;
  addTrack(track: LiveMediaTrack): unknown;
  createDataChannel(label: string): LiveDataChannel;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void>;
  onconnectionstatechange: ((event: unknown) => void) | null;
  close(): void;
};
export type LivePeerConnectionConstructor = new () => LivePeerConnection;

const OPEN = 1;
const CLOSED = 3;
/** Send audio in tenths of a second, as the provider recommends. */
const SEND_MILLISECONDS = 100;
/** Audio held while reconnecting; older audio is dropped from the preview only. */
const HOLD_MILLISECONDS = 15_000;
const SAVE_DELAY_MILLISECONDS = 1_500;
const MIN_BACKOFF_MILLISECONDS = 1_000;
const MAX_BACKOFF_MILLISECONDS = 30_000;
/** A session that stays up this long without text (silence) still counts as working. */
const PROVEN_SESSION_MILLISECONDS = 30_000;
/** How long to wait for the last words after asking the provider to finish. */
const CLOSE_WAIT_MILLISECONDS = 3_000;
/** A plain commit not followed by its timed copy within this long is kept as is. */
const UNTIMED_COMMIT_MILLISECONDS = 1_500;
/** How far back the clock remembers where pushed audio sat in the recording. */
const ANCHOR_MILLISECONDS = 120_000;

/** Provider errors that will not go away by reconnecting. */
const FATAL_PROVIDER_ERRORS = new Set([
  "auth_error",
  "quota_exceeded",
  "input_error",
  "invalid_request",
  "chunk_size_exceeded",
  "unaccepted_terms",
]);

/** OpenAI Realtime errors that will not go away by reconnecting. */
const FATAL_OPENAI_ERRORS = new Set([
  "invalid_api_key",
  "insufficient_quota",
  "authentication_error",
  "model_not_found",
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
  for (let index = 0; index < samples.length; index++)
    view.setInt16(index * 2, samples[index]!, true);
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

type OpenAiMessage = {
  type?: unknown;
  item_id?: unknown;
  delta?: unknown;
  transcript?: unknown;
  audio_start_ms?: unknown;
  audio_end_ms?: unknown;
  error?: unknown;
};

/** One stretch of speech an OpenAI Realtime session is transcribing. */
type OpenAiItem = { start: number | null; end: number | null; text: string };

const asText = (value: unknown) => (typeof value === "string" ? value : "");
const asMilliseconds = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function openAiError(value: unknown): { code: string; message: string } {
  const error = (value && typeof value === "object" ? value : {}) as {
    code?: unknown;
    type?: unknown;
    message?: unknown;
  };
  const code = asText(error.code) || asText(error.type) || "provider_error";
  return { code, message: asText(error.message) || code };
}

/** Statuses a WebRTC offer gets that reconnecting won't change. */
const REFUSED_OFFER_STATUSES = new Set([400, 401, 403, 404]);

/**
 * Stream one track to a live model, holding audio through short outages and
 * saving finished text. Errors never reach the recording itself.
 */
export function createLiveTranscriber(options: LiveTranscriberOptions): LiveTranscriber {
  const Socket =
    options.WebSocket ?? (globalThis as { WebSocket?: LiveWebSocketConstructor }).WebSocket ?? null;
  const Peer =
    options.RTCPeerConnection ??
    (globalThis as { RTCPeerConnection?: LivePeerConnectionConstructor }).RTCPeerConnection ??
    null;
  const post: LiveFetch =
    options.fetch ?? ((url, init) => (globalThis.fetch as unknown as LiveFetch)(url, init));
  const clock = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
  const canStream = Boolean(Socket) || Boolean(Peer && options.mediaTrack);
  let snapshot: LiveTranscriptTrackSnapshot = {
    trackNumber: options.trackNumber,
    state: canStream ? "connecting" : "unavailable",
    partial: "",
    segments: [],
    error: canStream ? null : { code: "unsupported", message: "This device can't stream audio." },
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
  /** When the current session started, until it has proven itself. */
  let provingSince: number | null = null;
  const proven = () => {
    backoff = MIN_BACKOFF_MILLISECONDS;
    provingSince = null;
  };
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
  /** The current session's protocol. */
  let protocol: RecordingLiveProtocol = "elevenlabs.scribe_realtime";
  /** The current session carries the track itself over WebRTC, not pushed PCM. */
  let viaWebRtc = false;
  /** The copy of the track sent over WebRTC. */
  let sentTrack: LiveMediaTrack | null = null;
  let paused = false;
  /** When the WebRTC session's audio began, on `clock`. */
  let audioStartedAt = 0;
  /** Where pushed audio sat in the recording, on `clock`; it times WebRTC text. */
  const anchors: { at: number; start: number; end: number }[] = [];
  /** OpenAI Realtime speech being transcribed, by item. */
  const items = new Map<string, OpenAiItem>();
  let latestItem: string | null = null;

  const unavailable = (code: string, message: string) => {
    closed = true;
    pending = [];
    pendingSamples = 0;
    items.clear();
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
        await options.client.appendRecordingLiveSegments(options.workspaceId, options.recordingId, {
          trackNumber: options.trackNumber,
          streamedMilliseconds,
          segments: batch.map(({ trackNumber: _track, ...segment }) => segment),
        });
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

  /**
   * Where a moment on `clock` sat in the recording, from the pushed audio
   * around it. A paused stretch maps to the moment the recording paused.
   */
  const recordedAt = (at: number) => {
    let before: (typeof anchors)[number] | null = null;
    let after: (typeof anchors)[number] | null = null;
    for (const anchor of anchors) {
      if (anchor.at <= at) before = anchor;
      else {
        after = anchor;
        break;
      }
    }
    const fromAfter = after ? Math.max(after.start, after.end - (after.at - at)) : null;
    if (!before) return fromAfter ?? sessionNow();
    const fromBefore = before.end + (at - before.at);
    return fromAfter === null ? fromBefore : Math.min(fromBefore, fromAfter);
  };

  /** An OpenAI Realtime audio time, in the recording. */
  const openAiTime = (milliseconds: number) =>
    viaWebRtc ? recordedAt(audioStartedAt + milliseconds) : (sessionOffset ?? 0) + milliseconds;

  const onOpenAiMessage = (raw: unknown) => {
    let message: OpenAiMessage;
    try {
      message = JSON.parse(String(raw)) as OpenAiMessage;
    } catch {
      return;
    }
    const type = asText(message.type);
    const id = asText(message.item_id);
    const item = () => {
      let entry = items.get(id);
      if (!entry) {
        entry = { start: null, end: null, text: "" };
        items.set(id, entry);
      }
      return entry;
    };
    if (type === "input_audio_buffer.speech_started") {
      item().start = asMilliseconds(message.audio_start_ms);
      latestItem = id;
    } else if (type === "input_audio_buffer.speech_stopped") {
      item().end = asMilliseconds(message.audio_end_ms);
    } else if (type === "input_audio_buffer.committed") {
      item();
    } else if (type === "conversation.item.input_audio_transcription.delta") {
      proven();
      const entry = item();
      entry.text += asText(message.delta);
      latestItem = id;
      emit({ partial: entry.text.trim() });
    } else if (type === "conversation.item.input_audio_transcription.completed") {
      proven();
      const entry = items.get(id);
      items.delete(id);
      const start = entry?.start != null ? openAiTime(entry.start) : lastCommitEnd;
      const end =
        entry?.end != null ? openAiTime(entry.end) : viaWebRtc ? recordedAt(clock()) : sessionNow();
      addSegment(asText(message.transcript), start, Math.max(start, end));
      // Speech after this stretch may already be coming in.
      const partial = (latestItem ? items.get(latestItem)?.text.trim() : "") ?? "";
      if (partial !== snapshot.partial) emit({ partial });
      finished?.();
    } else if (type === "conversation.item.input_audio_transcription.failed") {
      items.delete(id);
      const { message: detail } = openAiError(message.error);
      emit({ error: { code: "transcription_failed", message: detail } });
      finished?.();
    } else if (type === "error") {
      const { code, message: detail } = openAiError(message.error);
      // Asked to finish with nothing left to transcribe.
      if (code === "input_audio_buffer_commit_empty") {
        finished?.();
      } else if (FATAL_OPENAI_ERRORS.has(code)) {
        unavailable(code, `The live transcript stopped: ${detail}`);
      } else {
        emit({ error: { code, message: detail } });
      }
    }
  };

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
      // A provider can start a session and refuse it at once (too many at a
      // time), so only text, or a session that lasts, resets the backoff.
      provingSince = Date.now();
      emit({ state: "live", error: null });
    } else if (type === "partial_transcript") {
      proven();
      emit({ partial: text.trim() });
    } else if (type === "committed_transcript_with_timestamps") {
      proven();
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
      proven();
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
    } else if (
      type.endsWith("_error") ||
      type.includes("exceeded") ||
      type === "throttled" ||
      type === "rate_limited" ||
      type === "queue_overflow" ||
      type === "resource_exhausted" ||
      type === "insufficient_audio_activity"
    ) {
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
    viaWebRtc = false;
    items.clear();
    latestItem = null;
    if (provingSince !== null && Date.now() - provingSince >= PROVEN_SESSION_MILLISECONDS) {
      proven();
    }
    provingSince = null;
    if (closed) return;
    retryAt = Date.now() + backoff;
    backoff = Math.min(MAX_BACKOFF_MILLISECONDS, backoff * 2);
    emit({ state: "reconnecting", partial: "" });
  };

  /**
   * A WebRTC session in the shape of a WebSocket: events travel on a data
   * channel, and a copy of the track is the audio.
   */
  const openWebRtc = (
    PeerConnection: LivePeerConnectionConstructor,
    track: LiveMediaTrack,
    url: string,
    token: string,
  ): LiveWebSocket => {
    const peer = new PeerConnection();
    const copy = track.clone();
    copy.enabled = !paused;
    sentTrack = copy;
    let readyState = 0;
    const channel = peer.createDataChannel("oai-events");
    const adapter: LiveWebSocket = {
      get readyState() {
        return readyState;
      },
      send(data) {
        if (channel.readyState === "open") channel.send(data);
      },
      close() {
        if (readyState === CLOSED) return;
        readyState = CLOSED;
        channel.close();
        peer.close();
        copy.stop();
        if (sentTrack === copy) sentTrack = null;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const fail = (status?: number) => {
      if (readyState === CLOSED) return;
      if (status !== undefined) adapter.onerror?.({ status });
      adapter.close();
      adapter.onclose?.({});
    };
    channel.onopen = () => {
      if (readyState !== 0) return;
      readyState = OPEN;
      adapter.onopen?.({});
    };
    channel.onmessage = (event) => adapter.onmessage?.(event);
    channel.onclose = () => fail();
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === "failed" || peer.connectionState === "closed") fail();
    };
    peer.addTrack(copy);
    void (async () => {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await post(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/sdp" },
        body: offer.sdp ?? "",
      });
      if (!response.ok) return fail(response.status);
      const sdp = await response.text();
      if (readyState === CLOSED) return;
      await peer.setRemoteDescription({ type: "answer", sdp });
    })().catch(() => fail());
    return adapter;
  };

  const connect = async () => {
    if (connecting || closed || !canStream || Date.now() < retryAt) return;
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
    // Audio held until now was kept at the last session's rate.
    const rate = session.audio.sampleRate;
    if (rate !== sampleRate) {
      pending = pending.map((held) => ({
        samples: resamplePcm16(held.samples, sampleRate, rate),
        recordedMilliseconds: held.recordedMilliseconds,
      }));
      pendingSamples = pending.reduce((sum, held) => sum + held.samples.length, 0);
    }
    sampleRate = session.audio.sampleRate;
    protocol = session.protocol;
    let opened: LiveWebSocket;
    if (session.protocol === "openai.realtime") {
      const track = options.mediaTrack;
      if (Peer && track && session.webrtcUrl && session.token) {
        viaWebRtc = true;
        opened = openWebRtc(Peer, track, session.webrtcUrl, session.token);
      } else if (Socket && options.webSocketHeaders && session.token) {
        opened = new Socket(session.url, undefined, {
          headers: { Authorization: `Bearer ${session.token}` },
        });
      } else {
        connecting = false;
        unavailable("unsupported", "This device can't stream audio to the live model.");
        return;
      }
    } else if (Socket) {
      opened = new Socket(session.url);
    } else {
      connecting = false;
      unavailable("unsupported", "This device can't stream audio.");
      return;
    }
    socket = opened;
    opened.onopen = () => {
      connecting = false;
      if (socket !== opened) return;
      if (protocol === "openai.realtime") {
        // The provider checked the secret on connecting, so the session is up.
        provingSince = Date.now();
        emit({ state: "live", error: null });
        if (viaWebRtc) audioStartedAt = clock();
      }
      flush();
    };
    opened.onmessage = (event) => {
      if (socket !== opened) return;
      if (protocol === "openai.realtime") onOpenAiMessage(event.data);
      else onMessage(event.data);
    };
    opened.onerror = (event) => {
      const status = (event as { status?: unknown } | null)?.status;
      if (socket === opened && typeof status === "number" && REFUSED_OFFER_STATUSES.has(status)) {
        unavailable("unavailable", `The live transcript couldn't connect (HTTP ${status}).`);
      }
    };
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
    if (viaWebRtc) {
      // The track carries the audio itself; audio held while connecting is dropped.
      pending = [];
      pendingSamples = 0;
      return;
    }
    const chunk = Math.round((sampleRate * SEND_MILLISECONDS) / 1_000);
    // Whole chunks only, unless asked to send the remainder too.
    const minimum = force ? 1 : chunk;
    while (pending.length > 0 && pendingSamples >= minimum) {
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
        JSON.stringify(
          protocol === "openai.realtime"
            ? { type: "input_audio_buffer.append", audio: base64(pcmBytes(out)) }
            : {
                message_type: "input_audio_chunk",
                audio_base_64: base64(pcmBytes(out)),
                commit: false,
                sample_rate: sampleRate,
              },
        ),
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
      const at = clock();
      const duration = (samples.length / rate) * 1_000;
      anchors.push({ at, start: recordedMilliseconds, end: recordedMilliseconds + duration });
      while (anchors.length > 1 && at - anchors[0]!.at > ANCHOR_MILLISECONDS) anchors.shift();
      if (viaWebRtc) {
        // The track is already on its way; this audio only keeps the clock.
        if (socket?.readyState === OPEN) {
          streamedSamples += Math.round((duration * sampleRate) / 1_000);
        }
        return;
      }
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
        const openAi = protocol === "openai.realtime";
        // Nothing said after Stop belongs in the recording.
        if (sentTrack) sentTrack.enabled = false;
        await new Promise<void>((done) => {
          const timer = setTimeout(done, CLOSE_WAIT_MILLISECONDS);
          finished = () => {
            // OpenAI Realtime finishes each stretch of speech on its own.
            if (openAi && items.size > 0) return;
            clearTimeout(timer);
            done();
          };
          open.send(
            JSON.stringify(
              openAi
                ? { type: "input_audio_buffer.commit" }
                : {
                    message_type: "input_audio_chunk",
                    audio_base_64: "",
                    commit: true,
                    sample_rate: sampleRate,
                  },
            ),
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
      items.clear();
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
      items.clear();
      const open = socket;
      socket = null;
      open?.close();
      emit({ state: "closed", partial: "" });
    },

    setPaused(value) {
      paused = value;
      if (sentTrack) sentTrack.enabled = !value;
    },
  };
}
