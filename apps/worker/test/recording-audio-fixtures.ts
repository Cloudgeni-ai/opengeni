import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ffmpegPath = process.env.OPENGENI_TEST_FFMPEG_PATH ?? "ffmpeg";
export const hasFfmpeg = spawnSync(ffmpegPath, ["-version"]).status === 0;

/**
 * Captures a browser made, as the web recorder records: Chromium's
 * MediaRecorder, `audio/webm;codecs=opus` at 32 kbit/s, cut every 5 s, with
 * each chunk's start and duration measured as the recorder does (pauses
 * left out). `bytes` are the lengths of the chunks the browser handed out.
 *
 * - `suspended`: 2 s of tone from an AudioContext's MediaStreamDestination,
 *   the context suspended for 130 s, then 2 s more. The track delivers no
 *   audio while suspended, so its timestamps jump 130 s.
 * - `paused`: 2 s of a microphone, the recorder paused for 130 s, then 2 s
 *   more. The recorder leaves the pause out of its timestamps, as the
 *   chunks' durations do.
 */
export const BROWSER_CAPTURES = {
  suspended: {
    file: "recording-capture-suspended-130s.webm",
    chunks: [
      { bytes: 8_280, startMilliseconds: 0, durationMilliseconds: 132_024 },
      { bytes: 8_134, startMilliseconds: 132_024, durationMilliseconds: 1_980 },
    ],
  },
  paused: {
    file: "recording-capture-paused-130s.webm",
    chunks: [
      { bytes: 5_622, startMilliseconds: 0, durationMilliseconds: 2_031 },
      { bytes: 8_117, startMilliseconds: 2_031, durationMilliseconds: 1_971 },
    ],
  },
} as const;

/** A browser capture's chunks as they were uploaded. */
export function browserCaptureChunks(capture: keyof typeof BROWSER_CAPTURES) {
  const { file, chunks } = BROWSER_CAPTURES[capture];
  const bytes = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", file)));
  let offset = 0;
  return chunks.map((chunk, chunkNumber) => {
    const piece = bytes.slice(offset, offset + chunk.bytes);
    offset += chunk.bytes;
    return {
      chunkNumber,
      startMilliseconds: chunk.startMilliseconds,
      durationMilliseconds: chunk.durationMilliseconds,
      objectKey: `k${chunkNumber}`,
      bytes: piece,
    };
  });
}

/** How loud 16 kHz mono PCM is around a second of it, as RMS of full scale. */
export function loudnessAt(samples: Int16Array, second: number): number {
  const from = Math.max(0, Math.round((second - 0.25) * 16_000));
  const to = Math.min(samples.length, Math.round((second + 0.25) * 16_000));
  let sum = 0;
  for (let index = from; index < to; index += 1) sum += (samples[index]! / 32_768) ** 2;
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
}

/** A WebM/Opus tone, the way a browser MediaRecorder would produce it. */
export function opusWebm(seconds: number, frequency = 440): Uint8Array {
  return tone(
    seconds,
    frequency,
    ["-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-f", "webm"],
    "webm",
  );
}

/** An ADTS AAC tone, the stream a phone recorder writes. */
export function adtsAac(seconds: number, frequency = 440): Uint8Array {
  return tone(
    seconds,
    frequency,
    ["-c:a", "aac", "-b:a", "64k", "-ar", "48000", "-ac", "1", "-f", "adts"],
    "aac",
  );
}

/**
 * A WebM/Opus tone whose timestamps skip each `[from, to)` second range, like
 * a capture that drops packets: it lasts `seconds` on its timeline but holds
 * less audio.
 */
export function gappedOpusWebm(seconds: number, holes: Array<[number, number]>): Uint8Array {
  const keep = holes.map(([from, to]) => `not(between(t,${from},${to}))`).join("*");
  return tone(
    seconds,
    440,
    ["-af", `aselect='${keep}'`, "-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-f", "webm"],
    "webm",
  );
}

/**
 * A WebM/Opus tone whose packets from `fromPacket` on are stamped `jumpSeconds`
 * later: a few kilobytes that claim a far longer timeline than they hold.
 */
export function jumpedOpusWebm(seconds: number, fromPacket: number, jumpSeconds: number) {
  const directory = mkdtempSync(join(tmpdir(), "recording-audio-test-"));
  try {
    const source = join(directory, "tone.webm");
    const output = join(directory, "jumped.webm");
    writeFileSync(source, opusWebm(seconds));
    const result = spawnSync(ffmpegPath, [
      "-nostdin",
      "-loglevel",
      "error",
      "-i",
      source,
      "-c",
      "copy",
      "-bsf:a",
      `setts=ts=if(gte(N\\,${fromPacket})\\,TS+${jumpSeconds * 1_000}\\,TS)`,
      "-f",
      "webm",
      output,
    ]);
    if (result.status !== 0) throw new Error(String(result.stderr));
    return new Uint8Array(readFileSync(output));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Split an ADTS stream at frame boundaries into pieces of about `frames` frames. */
export function adtsFrames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset + 7 <= bytes.length) {
    const length =
      ((bytes[offset + 3]! & 0x03) << 11) | (bytes[offset + 4]! << 3) | (bytes[offset + 5]! >> 5);
    if (length < 7) throw new Error("bad ADTS frame");
    frames.push(bytes.slice(offset, offset + length));
    offset += length;
  }
  return frames;
}

/**
 * A WebM/Opus recording `seconds` long that is a tone during each
 * `[from, to)` second range and digital silence the rest of the time.
 */
export function gatedOpusWebm(seconds: number, loud: Array<[number, number]>): Uint8Array {
  const gate = loud.map(([from, to]) => `between(t,${from},${to})`).join("+") || "0";
  return lavfi(
    `aevalsrc=exprs='0.5*sin(2*PI*440*t)*(${gate})':s=48000:d=${seconds}`,
    ["-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-f", "webm"],
    "webm",
  );
}

function tone(seconds: number, frequency: number, codec: string[], extension: string): Uint8Array {
  return lavfi(`sine=frequency=${frequency}:duration=${seconds}`, codec, extension);
}

function lavfi(source: string, codec: string[], extension: string): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "recording-audio-test-"));
  try {
    const output = join(directory, `tone.${extension}`);
    const result = spawnSync(ffmpegPath, [
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      source,
      ...codec,
      output,
    ]);
    if (result.status !== 0) throw new Error(String(result.stderr));
    return new Uint8Array(readFileSync(output));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
