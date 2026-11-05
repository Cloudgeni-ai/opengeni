// A dictation is heard in pieces at once rather than one after another, so
// a long one is ready about as soon as a short one. The pieces are cut at
// the speaker's pauses, found in the decoded 16-bit PCM itself, so no word
// is split between two requests.

/** The PCM of a 16-bit mono WAV file and where it sits in the file. */
export type PcmWav = {
  sampleRate: number;
  /** The 16-bit samples, little-endian, as bytes. */
  data: Uint8Array;
};

/** Read a 16-bit PCM mono WAV file; null when it is anything else. */
export function readPcmWav(bytes: Uint8Array): PcmWav | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) =>
    String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let sampleRate = 0;
  let format = false;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      if (body + 16 > bytes.byteLength) return null;
      const audioFormat = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      const bits = view.getUint16(body + 14, true);
      // 1 is PCM; 0xfffe (extensible) carries PCM too.
      if ((audioFormat !== 1 && audioFormat !== 0xfffe) || channels !== 1 || bits !== 16) {
        return null;
      }
      format = true;
    } else if (id === "data") {
      if (!format || sampleRate <= 0) return null;
      // A streamed header may leave the size unset: the data runs to the end.
      const end = size === 0 || size === 0xffffffff ? bytes.byteLength : body + size;
      const length = Math.min(end, bytes.byteLength) - body;
      return { sampleRate, data: bytes.subarray(body, body + (length - (length % 2))) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** A WAV file of the samples from `start` up to `end`. */
export function pcmWavPiece(wav: PcmWav, startSample: number, endSample: number): Uint8Array {
  const data = wav.data.subarray(startSample * 2, endSample * 2);
  const bytes = new Uint8Array(44 + data.byteLength);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      bytes[offset + index] = text.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + data.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, wav.sampleRate, true);
  view.setUint32(28, wav.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, data.byteLength, true);
  bytes.set(data, 44);
  return bytes;
}

export type DictationPiecePlan = {
  /** A dictation up to this long is one piece: it is never cut. */
  wholeMilliseconds: number;
  /** Pieces aim for about this length, cut at the clearest pause near it. */
  targetMilliseconds: number;
  /** No piece is shorter, except the last. */
  minMilliseconds: number;
  /** No piece is longer: the most a model takes in one request. */
  maxMilliseconds: number;
};

export const DICTATION_PIECES: DictationPiecePlan = {
  wholeMilliseconds: 25_000,
  targetMilliseconds: 15_000,
  minMilliseconds: 8_000,
  maxMilliseconds: 50_000,
};

/** Loudness is measured in frames this long. */
const FRAME_MILLISECONDS = 20;

/** Each 20 ms frame's loudness (root mean square of its samples). */
function frameLoudness(wav: PcmWav, endSample = wav.data.byteLength / 2): Float64Array {
  const perMillisecond = wav.sampleRate / 1_000;
  const frame = Math.max(1, Math.round(FRAME_MILLISECONDS * perMillisecond));
  const frames = Math.floor(endSample / frame);
  const view = new DataView(wav.data.buffer, wav.data.byteOffset, wav.data.byteLength);
  const loudness = new Float64Array(frames);
  for (let index = 0; index < frames; index += 1) {
    let sum = 0;
    for (let sample = index * frame; sample < (index + 1) * frame; sample += 1) {
      const value = view.getInt16(sample * 2, true);
      sum += value * value;
    }
    loudness[index] = Math.sqrt(sum / frame);
  }
  return loudness;
}

/**
 * Quiet is relative to the recording: a tenth of the way from its floor to
 * its speech. Audio with no clear floor has no pauses (0).
 */
function quietLevel(loudness: Float64Array): number {
  const sorted = Float64Array.from(loudness).sort();
  const floor = sorted[Math.floor(sorted.length * 0.02)] ?? 0;
  const voice = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  return voice > Math.max(floor * 3, 32) ? floor + (voice - floor) * 0.1 : 0;
}

/**
 * Where to cut a dictation, as sample positions: the pieces run between
 * consecutive positions, from 0 to the last sample. Each cut is the middle
 * of the longest stretch of quiet frames between the shortest and longest
 * allowed piece, preferring one near the target length; with no quiet at
 * all, the quietest frame.
 */
export function planDictationPieces(
  wav: PcmWav,
  plan: DictationPiecePlan = DICTATION_PIECES,
): number[] {
  const samples = wav.data.byteLength / 2;
  const perMillisecond = wav.sampleRate / 1_000;
  const total = samples / perMillisecond;
  if (total <= Math.max(plan.wholeMilliseconds, plan.minMilliseconds)) return [0, samples];
  const frame = Math.max(1, Math.round(FRAME_MILLISECONDS * perMillisecond));
  const loudness = frameLoudness(wav);
  const frames = loudness.length;
  // Audio with no clear floor has no pauses to find, and is cut at its
  // quietest moments instead.
  const quiet = quietLevel(loudness);
  const cuts = [0];
  let start = 0;
  const toFrame = (milliseconds: number) => Math.floor(milliseconds / FRAME_MILLISECONDS);
  for (;;) {
    const remaining = frames - start;
    // What is left after the last cut is short enough to be heard whole.
    if (remaining * FRAME_MILLISECONDS <= plan.wholeMilliseconds) break;
    const first = start + toFrame(plan.minMilliseconds);
    // Never leave a last piece shorter than the shortest allowed.
    const last = Math.min(
      frames - toFrame(plan.minMilliseconds),
      start + toFrame(plan.maxMilliseconds),
    );
    const target = start + toFrame(plan.targetMilliseconds);
    let best: { frame: number; score: number } | null = null;
    let run = 0;
    for (let index = first; index <= last + 1; index += 1) {
      if (index <= last && loudness[index]! < quiet) {
        run += 1;
        continue;
      }
      if (run > 0) {
        const middle = index - Math.ceil(run / 2);
        // A longer pause is a surer sentence break; nearer the target keeps pieces even.
        const distance = Math.abs(middle - target) / toFrame(plan.maxMilliseconds);
        const score = run - distance * 10;
        if (!best || score > best.score) best = { frame: middle, score };
      }
      run = 0;
    }
    let cut = best?.frame;
    if (cut === undefined) {
      cut = first;
      for (let index = first; index <= last; index += 1) {
        if (loudness[index]! < loudness[cut]!) cut = index;
      }
    }
    cuts.push(cut * frame);
    start = cut;
  }
  cuts.push(samples);
  return cuts;
}

/** At most this many pieces of one dictation are heard at once. */
export const DICTATION_PIECE_CONCURRENCY = 8;

/**
 * How a dictation is cut while it is still being spoken, so only the words
 * after the last cut are left when it stops.
 */
export type DictationListeningPlan = {
  /** A piece is at least this long before a pause may end it. */
  minMilliseconds: number;
  /** A pause at least this long ends a piece. */
  pauseMilliseconds: number;
  /** With no such pause, a piece is cut at its quietest moment once this long. */
  maxMilliseconds: number;
  /**
   * The newest audio is this long, and is never cut into: decoding more of
   * the recording later may still change its last moments.
   */
  settleMilliseconds: number;
};

export const DICTATION_LISTENING: DictationListeningPlan = {
  minMilliseconds: 6_000,
  pauseMilliseconds: 300,
  maxMilliseconds: 30_000,
  settleMilliseconds: 600,
};

/**
 * The next place to cut a dictation that is still being spoken, after the
 * cut at `fromSample`; null while there is none yet. It is the middle of the
 * first pause after the shortest piece, or, when the speaker hasn't paused
 * by the longest piece, its quietest moment. Only settled audio is
 * considered, so the same cut is found again in the whole recording.
 */
export function nextDictationCut(
  wav: PcmWav,
  fromSample: number,
  plan: DictationListeningPlan = DICTATION_LISTENING,
): number | null {
  const perMillisecond = wav.sampleRate / 1_000;
  const frame = Math.max(1, Math.round(FRAME_MILLISECONDS * perMillisecond));
  const samples = wav.data.byteLength / 2;
  const settled = Math.floor((samples - plan.settleMilliseconds * perMillisecond) / frame);
  const start = Math.ceil(fromSample / frame);
  const toFrames = (milliseconds: number) => Math.round(milliseconds / FRAME_MILLISECONDS);
  const first = start + toFrames(plan.minMilliseconds);
  if (settled <= first) return null;
  const loudness = frameLoudness(wav, settled * frame);
  const quiet = quietLevel(loudness);
  const last = Math.min(settled, start + toFrames(plan.maxMilliseconds));
  const pause = toFrames(plan.pauseMilliseconds);
  let run = 0;
  // A pause may begin before the shortest piece is reached, as long as its
  // middle comes after it; it must have ended within the settled audio.
  for (let index = start + 1; index < settled; index += 1) {
    if (loudness[index]! < quiet) {
      run += 1;
      continue;
    }
    if (run >= pause) {
      const middle = index - Math.ceil(run / 2);
      if (middle >= first && middle <= last) return middle * frame;
      if (middle > last) break;
    }
    run = 0;
    if (index > last) break;
  }
  if (settled < start + toFrames(plan.maxMilliseconds)) return null;
  let cut = first;
  for (let index = first; index <= last; index += 1) {
    if (loudness[index]! < loudness[cut]!) cut = index;
  }
  return cut * frame;
}

/** At most this many pieces of a dictation still being spoken are heard at once. */
export const DICTATION_LISTENING_CONCURRENCY = 4;

/** The piece plan for a model that takes at most `maxMilliseconds` in one request. */
export function dictationPiecePlan(maxMilliseconds: number): DictationPiecePlan {
  const max = Math.min(DICTATION_PIECES.maxMilliseconds, maxMilliseconds);
  return {
    maxMilliseconds: max,
    wholeMilliseconds: Math.min(DICTATION_PIECES.wholeMilliseconds, max),
    targetMilliseconds: Math.min(DICTATION_PIECES.targetMilliseconds, Math.round(max * 0.6)),
    minMilliseconds: Math.min(DICTATION_PIECES.minMilliseconds, Math.round(max * 0.3)),
  };
}
