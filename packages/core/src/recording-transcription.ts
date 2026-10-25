import type {
  RecordingDiarization,
  RecordingLiveProtocol,
  RecordingTrackSource,
  RecordingTranscriptionCapabilities,
} from "@opengeni/contracts";

/**
 * Recording transcription: one interface for every speech-to-text provider
 * a recording can use, plus the pure pieces that turn per-track words into
 * a transcript. Providers declare what each model can do; callers only ask
 * for what the chosen model supports.
 */

export type RecordingTranscriptionModelSpec = {
  model: string;
  name: string;
  capabilities: RecordingTranscriptionCapabilities;
  /** List price in USD per audio hour; null when unknown. */
  usdPerHour: number | null;
  /** Extra price share when keyterms are used (0.3 is 30% more). */
  keytermsPremium?: number;
  /**
   * Containers the model accepts. The worker converts other audio to the
   * first one; absent means any format a recording is prepared in.
   */
  audioFormats?: readonly RecordingProviderAudioFormat[];
};

/** Audio containers a transcription model can be sent. */
export type RecordingProviderAudioFormat = "flac" | "wav" | "mp3" | "webm" | "mp4";

export type RecordingTranscriptionAudio = {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
};

export type RecordingTranscriptionRequest = {
  audio: RecordingTranscriptionAudio;
  model: string;
  /** ISO 639 hint; omitted means detect. */
  language?: string | undefined;
  /** Ask the model to tell speakers apart. Ignored when it cannot. */
  diarize: boolean;
  /** Upper bound on distinct speakers. */
  maxSpeakers?: number | undefined;
  keyterms?: readonly string[] | undefined;
  signal?: AbortSignal | undefined;
};

export type RecordingTranscribedWord = {
  text: string;
  startMilliseconds: number;
  endMilliseconds: number;
  /** The model's own speaker id inside this call, when it diarized. */
  speaker: string | null;
  /** Whether a space separates this word from the previous one. */
  spaceBefore: boolean;
};

export type RecordingTranscriptionResult = {
  /** BCP 47 language tags ("en", "nb"), whatever form the provider reports them in. */
  languages: string[];
  /** Audio length the provider measured, when it says. */
  audioMilliseconds: number | null;
  diarized: boolean;
  words: RecordingTranscribedWord[];
};

/** A provider key, or a short-lived token for providers that take one (Microsoft Entra ID). */
export type RecordingTranscriptionCredentials = { apiKey: string } | { accessToken: string };

/** A live session a client opens itself, straight to the provider. */
export type RecordingLiveSessionGrant = {
  protocol: RecordingLiveProtocol;
  /** WebSocket URL carrying a single-use credential; never the provider key. */
  url: string;
  audio: { encoding: "pcm_s16le"; sampleRate: number };
  expiresAt: Date;
};

export type RecordingLiveSessionRequest = {
  model: string;
  /** ISO 639 hint; omitted means detect. */
  language?: string | undefined;
  signal?: AbortSignal | undefined;
};

export type RecordingTranscriptionProvider = {
  id: string;
  name: string;
  models: readonly RecordingTranscriptionModelSpec[];
  /** Transcribe a whole file. Only called for models with `capabilities.batch`. */
  transcribe(
    request: RecordingTranscriptionRequest,
    credentials: RecordingTranscriptionCredentials,
  ): Promise<RecordingTranscriptionResult>;
  /**
   * Grant a client one live session. Present when some model has
   * `capabilities.live`; only called for those models.
   */
  createLiveSession?(
    request: RecordingLiveSessionRequest,
    credentials: RecordingTranscriptionCredentials,
  ): Promise<RecordingLiveSessionGrant>;
};

export type RecordingTranscriptionErrorCode =
  | "unauthorized"
  | "invalid_audio"
  | "too_large"
  | "not_supported"
  | "quota_exceeded"
  | "rate_limited"
  | "provider"
  | "timeout"
  | "network"
  | "unavailable";

/** A provider call failed. Retryable failures may succeed if tried again later. */
export class RecordingTranscriptionError extends Error {
  readonly name = "RecordingTranscriptionError";
  constructor(
    message: string,
    readonly code: RecordingTranscriptionErrorCode,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** Estimated cost of transcribing `audioMilliseconds` at the model's list price, in micro-dollars. */
export function estimateRecordingTranscriptionCostMicros(
  model: RecordingTranscriptionModelSpec,
  audioMilliseconds: number,
  options: { keyterms?: boolean } = {},
): number | null {
  if (model.usdPerHour === null) return null;
  const premium = options.keyterms ? 1 + (model.keytermsPremium ?? 0) : 1;
  return Math.round((audioMilliseconds / 3_600_000) * model.usdPerHour * premium * 1_000_000);
}

// --- Diarization -----------------------------------------------------------

/** One stretch of time in which a speaker talks. */
export type SpeakerTurn = {
  startMilliseconds: number;
  endMilliseconds: number;
  speaker: string;
};

/** A diarized speaker's voice: a unit-length embedding of what they said. */
export type DiarizedVoice = {
  speaker: string;
  speechMilliseconds: number;
  embedding: number[];
};

export type RecordingDiarizerResult = {
  turns: SpeakerTurn[];
  voices: DiarizedVoice[];
  /** The speaker model behind `voices`; vectors only compare within one model. */
  voiceModel: string;
};

/**
 * Tells speakers apart in audio on its own, for models that cannot. Our CPU
 * diarizer implements this; GPU diarizers can later sit behind it too.
 */
export type RecordingDiarizer = {
  id: string;
  diarize(
    audio: RecordingTranscriptionAudio,
    options: { maxSpeakers?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<RecordingDiarizerResult>;
};

/**
 * Give each word the speaker whose turn overlaps it most. A word inside no
 * turn takes the nearest turn's speaker, so short gaps keep their speaker.
 */
export function labelWordsFromTurns(
  words: readonly RecordingTranscribedWord[],
  turns: readonly SpeakerTurn[],
): RecordingTranscribedWord[] {
  if (turns.length === 0) return words.map((word) => ({ ...word, speaker: null }));
  const ordered = [...turns].sort(
    (left, right) => left.startMilliseconds - right.startMilliseconds,
  );
  let first = 0;
  return words.map((word) => {
    while (first < ordered.length && ordered[first]!.endMilliseconds <= word.startMilliseconds) {
      first += 1;
    }
    const shares = new Map<string, number>();
    for (let index = first; index < ordered.length; index += 1) {
      const turn = ordered[index]!;
      if (turn.startMilliseconds >= word.endMilliseconds) break;
      const shared =
        Math.min(turn.endMilliseconds, word.endMilliseconds) -
        Math.max(turn.startMilliseconds, word.startMilliseconds);
      if (shared > 0) shares.set(turn.speaker, (shares.get(turn.speaker) ?? 0) + shared);
    }
    let speaker: string | null = null;
    let best = 0;
    for (const [candidate, shared] of shares) {
      if (shared > best) {
        best = shared;
        speaker = candidate;
      }
    }
    if (speaker === null) {
      const middle = (word.startMilliseconds + word.endMilliseconds) / 2;
      let distance = Number.POSITIVE_INFINITY;
      for (const turn of ordered) {
        const gap =
          middle < turn.startMilliseconds
            ? turn.startMilliseconds - middle
            : middle > turn.endMilliseconds
              ? middle - turn.endMilliseconds
              : 0;
        if (gap < distance) {
          distance = gap;
          speaker = turn.speaker;
        }
      }
    }
    return { ...word, speaker };
  });
}

// --- Pieces of long tracks --------------------------------------------------

/** A stretch of a track sent to the model on its own, on the track's timeline. */
export type RecordingTranscriptionPiece = {
  startMilliseconds: number;
  endMilliseconds: number;
  /** Words that start in [keepFrom, keepUntil) are taken from this piece. */
  keepFromMilliseconds: number;
  keepUntilMilliseconds: number;
};

/** Pieces overlap by this much on each side, so no word is cut at a boundary. */
export const RECORDING_PIECE_OVERLAP_MILLISECONDS = 10_000;

/**
 * Split a track a model can't take whole into overlapping pieces. Each word
 * is kept from the one piece whose keep window it starts in, and that piece
 * holds the whole word because the pieces overlap past their windows.
 */
export function planRecordingTranscriptionPieces(
  durationMilliseconds: number,
  maxPieceMilliseconds: number | null,
  overlapMilliseconds = RECORDING_PIECE_OVERLAP_MILLISECONDS,
): RecordingTranscriptionPiece[] {
  const duration = Math.max(0, Math.ceil(durationMilliseconds));
  if (maxPieceMilliseconds === null || duration <= maxPieceMilliseconds) {
    return [
      {
        startMilliseconds: 0,
        endMilliseconds: duration,
        keepFromMilliseconds: 0,
        keepUntilMilliseconds: Number.POSITIVE_INFINITY,
      },
    ];
  }
  const overlap = Math.min(overlapMilliseconds, Math.floor(maxPieceMilliseconds / 4));
  const stride = maxPieceMilliseconds - 2 * overlap;
  const count = Math.ceil(duration / stride);
  const pieces: RecordingTranscriptionPiece[] = [];
  for (let index = 0; index < count; index += 1) {
    const keepFrom = index * stride;
    const last = index === count - 1;
    const keepUntil = last ? Number.POSITIVE_INFINITY : (index + 1) * stride;
    pieces.push({
      startMilliseconds: Math.max(0, keepFrom - overlap),
      endMilliseconds: last ? duration : Math.min(duration, keepUntil + overlap),
      keepFromMilliseconds: keepFrom,
      keepUntilMilliseconds: keepUntil,
    });
  }
  return pieces;
}

/**
 * Join the pieces' results into one track result. Speaker ids are only
 * meaningful inside one call, so a track sent in several pieces has none.
 */
export function mergeRecordingTranscriptionPieces(
  parts: ReadonlyArray<{
    piece: RecordingTranscriptionPiece;
    result: RecordingTranscriptionResult;
  }>,
): RecordingTranscriptionResult {
  if (parts.length === 1) {
    const [{ piece, result }] = parts as [(typeof parts)[number]];
    if (piece.startMilliseconds === 0) return result;
  }
  const several = parts.length > 1;
  const words: RecordingTranscribedWord[] = [];
  const languages = new Set<string>();
  let audioMilliseconds: number | null = 0;
  for (const { piece, result } of parts) {
    for (const language of result.languages) languages.add(language);
    audioMilliseconds =
      audioMilliseconds === null || result.audioMilliseconds === null
        ? null
        : Math.max(audioMilliseconds, piece.startMilliseconds + result.audioMilliseconds);
    let firstOfPiece = true;
    for (const word of result.words) {
      const start = word.startMilliseconds + piece.startMilliseconds;
      if (start < piece.keepFromMilliseconds || start >= piece.keepUntilMilliseconds) continue;
      const spaceBefore = words.length > 0 && (word.spaceBefore || firstOfPiece);
      firstOfPiece = false;
      words.push({
        ...word,
        startMilliseconds: start,
        endMilliseconds: word.endMilliseconds + piece.startMilliseconds,
        speaker: several ? null : word.speaker,
        spaceBefore,
      });
    }
  }
  return {
    languages: [...languages],
    audioMilliseconds,
    diarized: !several && (parts[0]?.result.diarized ?? false),
    words,
  };
}

// --- Tracks and segments ----------------------------------------------------

export type RecordingTrackPlan = {
  trackNumber: number;
  /**
   * Every word on this track is one known speaker (`track-N`), so it needs
   * no diarization: the microphone next to computer audio is the person
   * recording.
   */
  fixedLabel: string | null;
  diarize: boolean;
};

/**
 * Decide how to label each track. When a microphone track sits next to a
 * system-audio track, the microphone is the person recording and only the
 * other tracks need diarization.
 */
export function planRecordingTracks(
  tracks: ReadonlyArray<{ trackNumber: number; source: RecordingTrackSource }>,
): RecordingTrackPlan[] {
  const hasSystem = tracks.some((track) => track.source === "system");
  return [...tracks]
    .sort((left, right) => left.trackNumber - right.trackNumber)
    .map((track) =>
      hasSystem && track.source === "microphone"
        ? {
            trackNumber: track.trackNumber,
            fixedLabel: `track-${track.trackNumber}`,
            diarize: false,
          }
        : { trackNumber: track.trackNumber, fixedLabel: null, diarize: true },
    );
}

export type RecordingTrackWords = {
  trackNumber: number;
  fixedLabel: string | null;
  words: readonly RecordingTranscribedWord[];
};

export type RecordingTranscriptSegmentDraft = {
  startMilliseconds: number;
  endMilliseconds: number;
  trackNumber: number;
  speakerLabel: string | null;
  text: string;
  words: Array<{ text: string; startMs: number; endMs: number }>;
};

const SEGMENT_GAP_MILLISECONDS = 2_000;
const SEGMENT_SOFT_MAX_MILLISECONDS = 60_000;
const SEGMENT_HARD_MAX_MILLISECONDS = 180_000;
const SENTENCE_END = /[.!?…。！？]["')\]]*$/u;

/**
 * Speaker labels for a track's words. Diarized ids become `speaker_N` in
 * order of first appearance; with several diarized tracks they carry the
 * track (`t1_speaker_0`), since each provider call numbers speakers anew.
 */
function trackLabeler(track: RecordingTrackWords, prefixTracks: boolean) {
  const numbers = new Map<string, number>();
  return (speaker: string | null): string | null => {
    if (track.fixedLabel) return track.fixedLabel;
    if (speaker === null) return null;
    let number = numbers.get(speaker);
    if (number === undefined) {
      number = numbers.size;
      numbers.set(speaker, number);
    }
    return prefixTracks ? `t${track.trackNumber}_speaker_${number}` : `speaker_${number}`;
  };
}

/**
 * The transcript label each diarized speaker id gets on each track, as
 * buildRecordingSegments assigns them, so per-speaker data (such as voices)
 * can follow the speakers into the transcript.
 */
export function recordingSpeakerLabels(
  tracks: readonly RecordingTrackWords[],
): Map<number, Map<string, string>> {
  const diarizedTracks = tracks.filter((track) => !track.fixedLabel).length;
  const labels = new Map<number, Map<string, string>>();
  for (const track of tracks) {
    if (track.fixedLabel) continue;
    const label = trackLabeler(track, diarizedTracks > 1);
    const byId = new Map<string, string>();
    for (const word of track.words) {
      if (!word.text.trim() || word.speaker === null || byId.has(word.speaker)) continue;
      byId.set(word.speaker, label(word.speaker)!);
    }
    labels.set(track.trackNumber, byId);
  }
  return labels;
}

/**
 * Turn per-track words into transcript segments ordered by time. A segment
 * ends when the speaker changes, after a pause over two seconds, at a
 * sentence end once it passes a minute, or at three minutes regardless.
 */
export function buildRecordingSegments(
  tracks: readonly RecordingTrackWords[],
): RecordingTranscriptSegmentDraft[] {
  const diarizedTracks = tracks.filter((track) => !track.fixedLabel).length;
  const segments: RecordingTranscriptSegmentDraft[] = [];
  for (const track of tracks) {
    const label = trackLabeler(track, diarizedTracks > 1);
    let current: RecordingTranscriptSegmentDraft | null = null;
    const close = () => {
      if (current && current.text.trim()) {
        current.text = current.text.trim();
        segments.push(current);
      }
      current = null;
    };
    for (const word of track.words) {
      const text = word.text.trim();
      if (!text) continue;
      const speaker = label(word.speaker);
      const open = current as RecordingTranscriptSegmentDraft | null;
      if (open) {
        const length = open.endMilliseconds - open.startMilliseconds;
        const breakHere =
          open.speakerLabel !== speaker ||
          word.startMilliseconds - open.endMilliseconds > SEGMENT_GAP_MILLISECONDS ||
          length > SEGMENT_HARD_MAX_MILLISECONDS ||
          (length > SEGMENT_SOFT_MAX_MILLISECONDS && SENTENCE_END.test(open.text));
        if (breakHere) close();
      }
      const target = current as RecordingTranscriptSegmentDraft | null;
      if (!target) {
        current = {
          startMilliseconds: word.startMilliseconds,
          endMilliseconds: word.endMilliseconds,
          trackNumber: track.trackNumber,
          speakerLabel: speaker,
          text,
          words: [{ text, startMs: word.startMilliseconds, endMs: word.endMilliseconds }],
        };
        continue;
      }
      target.text += word.spaceBefore ? ` ${text}` : text;
      target.endMilliseconds = Math.max(target.endMilliseconds, word.endMilliseconds);
      target.words.push({ text, startMs: word.startMilliseconds, endMs: word.endMilliseconds });
    }
    close();
  }
  return segments.sort(
    (left, right) =>
      left.startMilliseconds - right.startMilliseconds || left.trackNumber - right.trackNumber,
  );
}

/** How a version's speakers were told apart, for the transcript's record. */
export function recordingDiarizationKind(input: {
  plans: readonly RecordingTrackPlan[];
  providerDiarized: boolean;
  ourDiarizer: boolean;
}): RecordingDiarization {
  if (input.plans.some((plan) => plan.diarize)) {
    if (input.ourDiarizer) return "ours";
    if (input.providerDiarized) return "provider";
  }
  return input.plans.some((plan) => plan.fixedLabel) ? "tracks" : "none";
}

// --- ElevenLabs Scribe ------------------------------------------------------

const ELEVENLABS_SPEECH_TO_TEXT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVENLABS_API_BASE_URL = "https://api.elevenlabs.io";
const ELEVENLABS_REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
/** ElevenLabs single-use tokens last 15 minutes; grant a little less. */
const ELEVENLABS_LIVE_TOKEN_MILLISECONDS = 14 * 60 * 1_000;
const LIVE_SAMPLE_RATE = 16_000;
/** Long recordings are chunked server-side; an hour can take a few minutes. */
const ELEVENLABS_REQUEST_TIMEOUT_MILLISECONDS = 60 * 60 * 1_000;

const SCRIBE_CAPABILITIES: RecordingTranscriptionCapabilities = {
  batch: true,
  live: false,
  diarization: true,
  liveDiarization: false,
  multichannel: true,
  maxSpeakers: 32,
  wordTimestamps: true,
  languages: [],
  languageDetection: true,
  keyterms: true,
  speakerLibrary: false,
  maxDurationSeconds: 10 * 60 * 60,
  maxFileBytes: 3 * 1024 * 1024 * 1024,
};

/** Scribe v2 Realtime: words as they are spoken, per track, without speakers. */
const SCRIBE_REALTIME_CAPABILITIES: RecordingTranscriptionCapabilities = {
  batch: false,
  live: true,
  diarization: false,
  liveDiarization: false,
  multichannel: false,
  maxSpeakers: null,
  wordTimestamps: true,
  languages: [],
  languageDetection: true,
  keyterms: false,
  speakerLibrary: false,
  maxDurationSeconds: null,
  maxFileBytes: null,
};

type ElevenLabsWord = {
  text?: unknown;
  type?: unknown;
  start?: unknown;
  end?: unknown;
  speaker_id?: unknown;
};

type ElevenLabsResponse = {
  language_code?: unknown;
  words?: unknown;
  audio_duration_secs?: unknown;
};

/**
 * The shortest standard form of a provider's language code: ISO 639-3 "eng"
 * and "nob" become "en" and "nb"; a code Intl can't read is kept as given.
 */
/**
 * ElevenLabs knows Norwegian as one language ("no", "nor"), so Bokmål and
 * Nynorsk are sent as Norwegian.
 */
export function elevenLabsLanguage(code: string): string {
  return code === "nb" || code === "nn" || code === "nob" || code === "nno" ? "no" : code;
}

export function canonicalLanguageTag(code: string): string {
  try {
    return Intl.getCanonicalLocales(code.trim())[0] ?? code;
  } catch {
    return code;
  }
}

function seconds(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000)
    : null;
}

/** Turn ElevenLabs words and spacing into our words. Audio events are dropped. */
export function parseElevenLabsTranscript(body: unknown): RecordingTranscriptionResult {
  if (!body || typeof body !== "object") {
    throw new RecordingTranscriptionError("ElevenLabs returned no transcript", "provider", true);
  }
  const response = body as ElevenLabsResponse;
  const raw = Array.isArray(response.words) ? (response.words as ElevenLabsWord[]) : [];
  const words: RecordingTranscribedWord[] = [];
  let pendingSpace = false;
  let diarized = false;
  for (const item of raw) {
    if (item.type === "spacing") {
      pendingSpace = true;
      continue;
    }
    if (item.type !== undefined && item.type !== "word") continue;
    const text = typeof item.text === "string" ? item.text : "";
    const start = seconds(item.start);
    const end = seconds(item.end);
    if (!text.trim() || start === null || end === null) continue;
    const speaker = typeof item.speaker_id === "string" ? item.speaker_id : null;
    if (speaker) diarized = true;
    words.push({
      text,
      startMilliseconds: start,
      endMilliseconds: Math.max(start, end),
      speaker,
      spaceBefore: words.length > 0 && pendingSpace,
    });
    pendingSpace = false;
  }
  const language =
    typeof response.language_code === "string" && response.language_code
      ? [canonicalLanguageTag(response.language_code)]
      : [];
  return {
    languages: language,
    audioMilliseconds: seconds(response.audio_duration_secs),
    diarized,
    words,
  };
}

function elevenLabsError(
  status: number,
  detail: string,
  action = "transcribe this audio",
): RecordingTranscriptionError {
  const message = `ElevenLabs could not ${action} (HTTP ${status}${detail ? `: ${detail}` : ""})`;
  if (status === 401 || status === 403) {
    return new RecordingTranscriptionError(message, "unauthorized", false);
  }
  if (status === 413) return new RecordingTranscriptionError(message, "too_large", false);
  if (status === 400 || status === 415 || status === 422) {
    return new RecordingTranscriptionError(message, "invalid_audio", false);
  }
  if (status === 402) return new RecordingTranscriptionError(message, "quota_exceeded", false);
  if (status === 429) return new RecordingTranscriptionError(message, "rate_limited", true);
  if (status >= 500) return new RecordingTranscriptionError(message, "unavailable", true);
  return new RecordingTranscriptionError(message, "provider", false);
}

/** ElevenLabs takes only its own API key. */
function elevenLabsApiKey(credentials: RecordingTranscriptionCredentials): string {
  if ("apiKey" in credentials && credentials.apiKey) return credentials.apiKey;
  throw new RecordingTranscriptionError("ElevenLabs needs an API key", "unauthorized", false);
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: { message?: unknown; status?: unknown } };
    const message = body.detail?.message ?? body.detail?.status;
    return typeof message === "string" ? message.slice(0, 300) : "";
  } catch {
    return "";
  }
}

/** ElevenLabs Scribe, using the workspace's or organization's own ElevenLabs key. */
export function createElevenLabsRecordingTranscriptionProvider(
  options: {
    fetch?: typeof fetch;
    url?: string;
    timeoutMilliseconds?: number;
    now?: () => Date;
  } = {},
): RecordingTranscriptionProvider {
  const request = options.fetch ?? fetch;
  return {
    id: "elevenlabs",
    name: "ElevenLabs",
    models: [
      {
        model: "scribe_v2",
        name: "Scribe v2",
        capabilities: SCRIBE_CAPABILITIES,
        usdPerHour: 0.22,
        keytermsPremium: 0.3,
      },
      {
        model: "scribe_v2_realtime",
        name: "Scribe v2 Realtime",
        capabilities: SCRIBE_REALTIME_CAPABILITIES,
        usdPerHour: 0.39,
      },
    ],
    async createLiveSession(input, credentials) {
      const now = options.now?.() ?? new Date();
      let response: Response;
      try {
        response = await request(`${ELEVENLABS_API_BASE_URL}/v1/single-use-token/realtime_scribe`, {
          method: "POST",
          headers: { "xi-api-key": elevenLabsApiKey(credentials) },
          signal: input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        });
      } catch (error) {
        if (input.signal?.aborted) throw error;
        throw new RecordingTranscriptionError("Could not reach ElevenLabs", "network", true);
      }
      if (!response.ok) {
        throw elevenLabsError(
          response.status,
          await errorDetail(response),
          "start a live transcript",
        );
      }
      const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
      if (typeof body?.token !== "string" || body.token.length === 0) {
        throw new RecordingTranscriptionError(
          "ElevenLabs returned no live session token",
          "provider",
          true,
        );
      }
      const url = new URL(ELEVENLABS_REALTIME_URL);
      url.searchParams.set("model_id", input.model);
      url.searchParams.set("token", body.token);
      url.searchParams.set("audio_format", `pcm_${LIVE_SAMPLE_RATE}`);
      url.searchParams.set("commit_strategy", "vad");
      url.searchParams.set("include_timestamps", "true");
      if (input.language) url.searchParams.set("language_code", elevenLabsLanguage(input.language));
      return {
        protocol: "elevenlabs.scribe_realtime",
        url: url.toString(),
        audio: { encoding: "pcm_s16le", sampleRate: LIVE_SAMPLE_RATE },
        expiresAt: new Date(now.getTime() + ELEVENLABS_LIVE_TOKEN_MILLISECONDS),
      };
    },
    async transcribe(input, credentials) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([input.audio.bytes as Uint8Array<ArrayBuffer>], { type: input.audio.mimeType }),
        input.audio.fileName,
      );
      form.append("model_id", input.model);
      form.append("timestamps_granularity", "word");
      form.append("tag_audio_events", "false");
      form.append("diarize", input.diarize ? "true" : "false");
      if (input.language) form.append("language_code", elevenLabsLanguage(input.language));
      if (input.diarize && input.maxSpeakers) {
        form.append("num_speakers", String(Math.min(32, Math.max(1, input.maxSpeakers))));
      }
      for (const term of input.keyterms ?? []) form.append("keyterms", term);
      const timeout = AbortSignal.timeout(
        options.timeoutMilliseconds ?? ELEVENLABS_REQUEST_TIMEOUT_MILLISECONDS,
      );
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await request(options.url ?? ELEVENLABS_SPEECH_TO_TEXT_URL, {
          method: "POST",
          headers: { "xi-api-key": elevenLabsApiKey(credentials) },
          body: form,
          signal,
        });
      } catch (error) {
        if (timeout.aborted) {
          throw new RecordingTranscriptionError("ElevenLabs took too long", "timeout", true);
        }
        if (input.signal?.aborted) throw error;
        throw new RecordingTranscriptionError("Could not reach ElevenLabs", "network", true);
      }
      if (!response.ok) throw elevenLabsError(response.status, await errorDetail(response));
      return parseElevenLabsTranscript(await response.json());
    },
  };
}

/** Providers a deployment offers for recordings, by id. */
export type RecordingTranscriptionProviderRegistry = ReadonlyMap<
  string,
  RecordingTranscriptionProvider
>;

export function createRecordingTranscriptionProviderRegistry(
  providers: readonly RecordingTranscriptionProvider[] = [
    createElevenLabsRecordingTranscriptionProvider(),
  ],
): RecordingTranscriptionProviderRegistry {
  return new Map(providers.map((provider) => [provider.id, provider]));
}

export const DEFAULT_RECORDING_TRANSCRIPTION = { providerId: "elevenlabs", model: "scribe_v2" };
/** The live model a recorder streams to when a request names none. */
export const DEFAULT_RECORDING_LIVE_TRANSCRIPTION = {
  providerId: "elevenlabs",
  model: "scribe_v2_realtime",
};

/**
 * A provider's model, if it is offered for this use: `batch` transcribes
 * whole tracks, `live` streams while recording.
 */
export function findRecordingTranscriptionModel(
  registry: RecordingTranscriptionProviderRegistry,
  providerId: string,
  model: string,
  use: "batch" | "live" = "batch",
): { provider: RecordingTranscriptionProvider; spec: RecordingTranscriptionModelSpec } | null {
  const provider = registry.get(providerId);
  const spec = provider?.models.find((candidate) => candidate.model === model);
  if (!provider || !spec) return null;
  if (use === "live")
    return spec.capabilities.live && provider.createLiveSession ? { provider, spec } : null;
  return spec.capabilities.batch ? { provider, spec } : null;
}
