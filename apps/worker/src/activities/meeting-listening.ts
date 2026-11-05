// What a meeting's pieces sounded like to the model while it was still
// being recorded. The worker following a meeting cuts each track at its
// speakers' pauses as the audio arrives and has every finished piece heard
// at once, so when the meeting ends only the minutes after the last cut are
// left to hear. Long quiet stretches become pieces of their own that are
// never sent. The final transcript keeps the pieces whose audio is still
// exactly the same and that were asked the same question.

import type { RecordingTranscribedWord } from "@opengeni/core";
import { FRAME_MILLISECONDS, frameLoudness, quietLevel, type PcmWav } from "./dictation-pieces";
import {
  RECORDING_QUIET_DECIBELS,
  RECORDING_QUIET_MARGIN_MILLISECONDS,
  RECORDING_QUIET_MIN_MILLISECONDS,
} from "./recording-audio";

/** The model and options finalizing would choose for the meeting, as the API chose them. */
export type MeetingListeningChoice = {
  providerId: string;
  model: string;
  options: {
    language?: string | undefined;
    maxSpeakers?: number | undefined;
    speakers?: number | undefined;
    keyterms?: string[] | undefined;
    diarizer?: string | undefined;
  };
};

/** One piece of a track cut while the meeting was recorded. */
export type HeardMeetingPiece = {
  startSample: number;
  endSample: number;
  /** The piece's 16-bit PCM, so the final transcript knows it is the same audio. */
  sha256: string;
  /** A long quiet stretch: nothing in it is sent. */
  quiet: boolean;
  /** When it was cut (epoch milliseconds), to wait briefly for one still being heard. */
  cutAt: number;
  heard?: {
    languages: string[];
    /** Timed from the piece's start. */
    words: RecordingTranscribedWord[];
    /** Audio sent to the model for it, which is what it bills. */
    sentMilliseconds: number;
  };
};

export type HeardMeeting = {
  version: 1;
  purpose: "meeting";
  sampleRate: number;
  /** The question each piece was asked (`meetingQuestion`). */
  question: string;
  pieces: HeardMeetingPiece[];
};

/** The model and request a piece is heard with, as one comparable value. */
export function meetingQuestion(input: {
  providerId: string;
  model: string;
  language: string | undefined;
  diarize: boolean;
  maxSpeakers: number | undefined;
  keyterms: readonly string[] | undefined;
}): string {
  return JSON.stringify([
    1,
    input.providerId,
    input.model,
    input.language ?? null,
    input.diarize,
    input.maxSpeakers ?? null,
    input.keyterms?.length ? input.keyterms : null,
  ]);
}

/** A record read back; anything else is treated as none. */
export function readHeardMeeting(bytes: Uint8Array | null | undefined): HeardMeeting | null {
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<HeardMeeting>;
    if (
      value.version !== 1 ||
      value.purpose !== "meeting" ||
      typeof value.sampleRate !== "number" ||
      typeof value.question !== "string" ||
      !Array.isArray(value.pieces)
    ) {
      return null;
    }
    return value as HeardMeeting;
  } catch {
    return null;
  }
}

export function writeHeardMeeting(record: HeardMeeting): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(record));
}

/** How a meeting's tracks are cut while they are recorded. */
export type MeetingListeningPlan = {
  /** A piece is at least this long before a pause may end it. */
  minMilliseconds: number;
  /** A pause at least this long ends a piece. */
  pauseMilliseconds: number;
  /**
   * With no such pause, a piece is cut at its quietest moment once this
   * long. It is also what is left to hear, at most, when the meeting ends.
   */
  maxMilliseconds: number;
  /** The newest audio is this long, and is never cut into. */
  settleMilliseconds: number;
};

export const MEETING_LISTENING: MeetingListeningPlan = {
  minMilliseconds: 45_000,
  pauseMilliseconds: 500,
  maxMilliseconds: 150_000,
  settleMilliseconds: 2_000,
};

/** The plan for a model that takes at most `maxMilliseconds` in one request. */
export function meetingListeningPlan(maxMilliseconds: number | null): MeetingListeningPlan {
  if (maxMilliseconds === null || maxMilliseconds >= MEETING_LISTENING.maxMilliseconds) {
    return MEETING_LISTENING;
  }
  return {
    ...MEETING_LISTENING,
    maxMilliseconds,
    minMilliseconds: Math.min(MEETING_LISTENING.minMilliseconds, Math.round(maxMilliseconds * 0.3)),
  };
}

/** A frame's loudness (root mean square of 16-bit samples) at the quiet level in dBFS. */
const LONG_QUIET_LOUDNESS = 32_768 * 10 ** (RECORDING_QUIET_DECIBELS / 20);

/**
 * The track's loudness, frame by frame, up to its settled end: computed
 * once for each look at the audio so far.
 */
export function settledLoudness(wav: PcmWav, plan: MeetingListeningPlan): Float64Array {
  const frame = Math.max(1, Math.round((FRAME_MILLISECONDS * wav.sampleRate) / 1_000));
  const samples = wav.data.byteLength / 2;
  const settled = Math.floor(
    (samples - (plan.settleMilliseconds * wav.sampleRate) / 1_000) / frame,
  );
  return settled > 0 ? frameLoudness(wav, settled * frame) : new Float64Array();
}

/**
 * The next piece of a track still being recorded, after the cut at
 * `fromSample`; null while there is none yet. A long quiet stretch (as quiet
 * as the final transcript leaves unsent, for as long) is a quiet piece of
 * its own, ending a second before the sound after it. A piece with sound
 * ends a second into the next long quiet stretch, else at the middle of the
 * first pause after the shortest piece, else, when nobody paused by the
 * longest piece, at its quietest moment.
 */
export function nextMeetingPiece(
  wav: PcmWav,
  loudness: Float64Array,
  fromSample: number,
  plan: MeetingListeningPlan,
): { endSample: number; quiet: boolean } | null {
  const frame = Math.max(1, Math.round((FRAME_MILLISECONDS * wav.sampleRate) / 1_000));
  const toFrames = (milliseconds: number) => Math.round(milliseconds / FRAME_MILLISECONDS);
  const settled = loudness.length;
  const start = Math.ceil(fromSample / frame);
  if (start >= settled) return null;
  const longQuiet = toFrames(RECORDING_QUIET_MIN_MILLISECONDS);
  const margin = toFrames(RECORDING_QUIET_MARGIN_MILLISECONDS);
  const longest = toFrames(plan.maxMilliseconds);
  // Already in a long quiet stretch (the margin before it went to the
  // piece that ended it): it runs until the sound after it.
  let quietEnd = start;
  while (quietEnd < settled && loudness[quietEnd]! < LONG_QUIET_LOUDNESS) quietEnd += 1;
  if (quietEnd - start >= longQuiet - 2 * margin) {
    if (quietEnd < settled) {
      const end = quietEnd - margin;
      if (end > start) return { endSample: end * frame, quiet: true };
    } else if (settled - start >= longest) {
      return { endSample: (start + longest) * frame, quiet: true };
    } else {
      return null;
    }
  }
  // The next long quiet stretch, if it begins before the longest piece ends.
  let run = 0;
  for (let index = start; index < settled && index - run <= start + longest; index += 1) {
    if (loudness[index]! >= LONG_QUIET_LOUDNESS) {
      run = 0;
      continue;
    }
    run += 1;
    if (run >= longQuiet) {
      const end = index - run + 1 + margin;
      if (end - start <= longest) return { endSample: end * frame, quiet: false };
      break;
    }
  }
  // A pause between the shortest and the longest piece.
  const first = start + toFrames(plan.minMilliseconds);
  if (settled <= first) return null;
  const last = Math.min(settled - 1, start + longest);
  const quiet = quietLevel(loudness.subarray(start, Math.min(settled, start + longest + 1)));
  const pause = toFrames(plan.pauseMilliseconds);
  run = 0;
  for (let index = start + 1; index < settled; index += 1) {
    if (loudness[index]! < quiet) {
      run += 1;
      continue;
    }
    if (run >= pause) {
      const middle = index - Math.ceil(run / 2);
      if (middle >= first && middle <= last) return { endSample: middle * frame, quiet: false };
      if (middle > last) break;
    }
    run = 0;
    if (index > last) break;
  }
  if (settled < start + longest) return null;
  let cut = first;
  for (let index = first; index <= last; index += 1) {
    if (loudness[index]! < loudness[cut]!) cut = index;
  }
  return { endSample: cut * frame, quiet: false };
}

/** A look that found no cut waits for this much more audio before the next. */
export const MEETING_LOOK_AGAIN_MILLISECONDS = 15_000;

/**
 * Whether a track has enough new audio that the next piece could be cut:
 * the shortest piece (or the shortest long quiet stretch) has settled past
 * the last cut, and, after a look that could cut nothing, more has arrived.
 */
export function meetingCutDue(input: {
  audioMilliseconds: number;
  heardMilliseconds: number;
  lookedMilliseconds: number;
  plan: MeetingListeningPlan;
}): boolean {
  const shortest = Math.min(input.plan.minMilliseconds, RECORDING_QUIET_MIN_MILLISECONDS);
  if (
    input.audioMilliseconds - input.heardMilliseconds <
    shortest + input.plan.settleMilliseconds
  ) {
    return false;
  }
  return input.audioMilliseconds - input.lookedMilliseconds >= MEETING_LOOK_AGAIN_MILLISECONDS;
}

/** At most this many pieces of one meeting are heard at once. */
export const MEETING_LISTENING_CONCURRENCY = 4;
