/**
 * Plain helpers for meeting UIs (web, phone, embedders): words for a recording's state, clock
 * times, speaker names and colors, and the transcript grouped into turns.
 * No React here, so each rule is tested on its own.
 */
import {
  defaultRecordingSpeakerName,
  type Recording,
  type RecordingSpeaker,
  type RecordingTrack,
  type RecordingTranscriptSegment,
  type RecordingTranscriptVersion,
} from "@opengeni/contracts";

/** "4:07", "1:02:09". Never negative; rounds down to the second. */
export function formatClock(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

/** "45 sec", "12 min", "1 h 5 min": a recording's length in a list. */
export function formatDuration(milliseconds: number): string {
  // Non-breaking spaces keep "23 sec" together when large text wraps a line.
  const seconds = Math.round(Math.max(0, milliseconds) / 1000);
  if (seconds < 60) return `${seconds}\u00a0sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}\u00a0min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}\u00a0h` : `${hours}\u00a0h ${rest}\u00a0min`;
}

export type MeetingPhase =
  | { kind: "uploading" }
  | { kind: "transcribing"; version: RecordingTranscriptVersion | null }
  | { kind: "ready"; version: RecordingTranscriptVersion }
  | { kind: "failed"; version: RecordingTranscriptVersion | null }
  | { kind: "no_transcript" };

/**
 * Where a recording is in its life, from the reader's side. A recording still
 * capturing is "uploading": the audio is on the recorder's device until its
 * chunks reach storage. A failed re-run leaves an older complete version
 * current, so the transcript stays readable.
 */
export function meetingPhase(recording: Recording): MeetingPhase {
  if (recording.state === "capturing") return { kind: "uploading" };
  const version = recording.transcript;
  if (version?.state === "complete") return { kind: "ready", version };
  if (version?.state === "queued" || version?.state === "processing") {
    return { kind: "transcribing", version };
  }
  if (version?.state === "failed" || recording.state === "failed") {
    return { kind: "failed", version: version ?? null };
  }
  if (recording.state === "processing") return { kind: "transcribing", version: null };
  return { kind: "no_transcript" };
}

/** The one-word state a list row shows, or null when there is nothing to say. */
export function meetingStatusLabel(
  phase: MeetingPhase,
): { label: string; tone: "progress" | "danger" | "neutral" } | null {
  switch (phase.kind) {
    case "uploading":
      return { label: "Uploading", tone: "progress" };
    case "transcribing":
      return { label: "Transcribing", tone: "progress" };
    case "failed":
      return { label: "Transcript failed", tone: "danger" };
    case "no_transcript":
      return { label: "No transcript", tone: "neutral" };
    case "ready":
      return null;
  }
}

/**
 * Plain words for a transcription error code, with what to do about it. The
 * codes are the worker's: its own (`missing_provider_key`, `invalid_audio`,
 * ...) and the provider's, prefixed `provider_`.
 */
export function transcriptErrorText(code: string | null): string {
  switch (code) {
    case "missing_provider_key":
      return "No transcription provider is connected for this workspace. An organization admin can connect one in Organization settings, under Models.";
    case "provider_unauthorized":
      return "The transcription provider didn't accept its key. An organization admin can reconnect it in Organization settings, under Models.";
    case "provider_quota_exceeded":
      return "The transcription provider refused the job because its account has no credit left. Ask an organization admin to check it, then transcribe again.";
    case "provider_too_large":
      return "This recording is longer than the model accepts. Try another model.";
    case "provider_not_supported":
    case "model_unavailable":
      return "That model isn't available anymore. Try another model.";
    case "invalid_audio":
    case "provider_invalid_audio":
    case "ffmpeg_failed":
      return "The audio couldn't be read. Part of the upload may be damaged.";
    case "storage_unavailable":
      return "The audio couldn't be fetched from storage. Try again in a few minutes.";
    default:
      return "Something went wrong while transcribing. Try again, or pick another model.";
  }
}

/**
 * The name to show for a speaker: the person or plain name someone gave it,
 * else "Speaker 2" for a model's label, or the track's role for a track label.
 */
export function speakerDisplayName(
  label: string | null,
  speakers: readonly RecordingSpeaker[],
  tracks: readonly RecordingTrack[],
): string {
  if (!label) return "Unknown speaker";
  const speaker = speakers.find((candidate) => candidate.label === label);
  if (speaker && speakerIsNamed(label, speakers) && speaker.name.trim()) return speaker.name;
  return defaultSpeakerName(label, tracks);
}

export function defaultSpeakerName(label: string, tracks: readonly RecordingTrack[]): string {
  return defaultRecordingSpeakerName(label, tracks);
}

/** True when the label has a name of its own: a person, a plain name, or a suggestion. */
export function speakerIsNamed(label: string, speakers: readonly RecordingSpeaker[]): boolean {
  const speaker = speakers.find((candidate) => candidate.label === label);
  return Boolean(speaker && (speaker.personId || speaker.source));
}

/**
 * A stable color slot (1-6, the chart palette) per speaker label, in order of
 * first appearance so the first voice is always the same hue.
 */
export function speakerColorSlots(
  segments: readonly RecordingTranscriptSegment[],
): Map<string, number> {
  const slots = new Map<string, number>();
  for (const segment of segments) {
    const label = segment.speakerLabel;
    if (label && !slots.has(label)) slots.set(label, (slots.size % 6) + 1);
  }
  return slots;
}

export type TranscriptTurn = {
  /** First segment index; stable across edits that keep the order. */
  key: number;
  speakerLabel: string | null;
  startMilliseconds: number;
  endMilliseconds: number;
  segments: RecordingTranscriptSegment[];
};

/**
 * Consecutive segments of one speaker read as one turn, the way a person reads
 * a transcript. A long pause starts a new turn even for the same voice, so a
 * timestamp is never far from the words it marks.
 */
export function groupTranscriptTurns(
  segments: readonly RecordingTranscriptSegment[],
  maxGapMilliseconds = 30_000,
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const segment of segments) {
    const last = turns.at(-1);
    if (
      last &&
      last.speakerLabel === segment.speakerLabel &&
      segment.startMilliseconds - last.endMilliseconds <= maxGapMilliseconds
    ) {
      last.segments.push(segment);
      last.endMilliseconds = Math.max(last.endMilliseconds, segment.endMilliseconds);
      continue;
    }
    turns.push({
      key: segment.index,
      speakerLabel: segment.speakerLabel,
      startMilliseconds: segment.startMilliseconds,
      endMilliseconds: segment.endMilliseconds,
      segments: [segment],
    });
  }
  return turns;
}

/** The segment playing at `milliseconds`, or the last one that started before it. */
export function activeSegmentIndex(
  segments: readonly RecordingTranscriptSegment[],
  milliseconds: number,
): number | null {
  let low = 0;
  let high = segments.length - 1;
  let found: number | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle]!;
    if (segment.startMilliseconds <= milliseconds) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found === null ? null : segments[found]!.index;
}

/** "ElevenLabs Scribe v2 · English · 3 speakers" style facts for a version. */
export function versionSummary(
  version: RecordingTranscriptVersion,
  modelName: string | null,
): string[] {
  const parts = [modelName ?? version.model];
  const languages = version.languages.map(languageName).filter(Boolean);
  if (languages.length > 0) parts.push(languages.join(", "));
  return parts;
}

/** English names for common languages, for runtimes without Intl.DisplayNames (Hermes). */
const LANGUAGE_NAMES: Record<string, string> = {
  ar: "Arabic",
  cs: "Czech",
  da: "Danish",
  de: "German",
  el: "Greek",
  en: "English",
  es: "Spanish",
  fi: "Finnish",
  fr: "French",
  he: "Hebrew",
  hi: "Hindi",
  hu: "Hungarian",
  id: "Indonesian",
  is: "Icelandic",
  it: "Italian",
  ja: "Japanese",
  ko: "Korean",
  nb: "Norwegian Bokmål",
  nl: "Dutch",
  nn: "Norwegian Nynorsk",
  no: "Norwegian",
  pl: "Polish",
  pt: "Portuguese",
  ro: "Romanian",
  ru: "Russian",
  sv: "Swedish",
  th: "Thai",
  tr: "Turkish",
  uk: "Ukrainian",
  vi: "Vietnamese",
  zh: "Chinese",
};

// Providers may report ISO 639-2 codes ("eng"). Hermes, the phone's
// JavaScript engine, does not canonicalize them to "en", so map them here.
const THREE_LETTER_LANGUAGES: Record<string, string> = {
  ara: "ar",
  ces: "cs",
  cze: "cs",
  dan: "da",
  deu: "de",
  ger: "de",
  ell: "el",
  gre: "el",
  eng: "en",
  spa: "es",
  fin: "fi",
  fra: "fr",
  fre: "fr",
  heb: "he",
  hin: "hi",
  hun: "hu",
  ind: "id",
  isl: "is",
  ice: "is",
  ita: "it",
  jpn: "ja",
  kor: "ko",
  nob: "nb",
  nld: "nl",
  dut: "nl",
  nno: "nn",
  nor: "no",
  pol: "pl",
  por: "pt",
  ron: "ro",
  rum: "ro",
  rus: "ru",
  swe: "sv",
  tha: "th",
  tur: "tr",
  ukr: "uk",
  vie: "vi",
  zho: "zh",
  chi: "zh",
};

/** "English" for "en" or a provider's "eng"; the code itself when no name is known. */
export function languageName(code: string): string {
  let tag = code;
  try {
    tag = Intl.getCanonicalLocales(code)[0] ?? code;
  } catch {
    // Not a well-formed tag: show it as given.
  }
  const [primary, ...rest] = tag.split("-");
  const twoLetter = THREE_LETTER_LANGUAGES[primary!.toLowerCase()];
  if (twoLetter) tag = [twoLetter, ...rest].join("-");
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
    if (name && name !== tag) return name;
  } catch {
    // No Intl.DisplayNames here.
  }
  return LANGUAGE_NAMES[tag] ?? LANGUAGE_NAMES[tag.split("-")[0]!] ?? tag;
}

/** A short, readable default title for a new recording: "Meeting, Oct 23, 14:05". */
export function defaultMeetingTitle(now: Date): string {
  const date = now.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `Meeting, ${date}, ${time}`;
}
