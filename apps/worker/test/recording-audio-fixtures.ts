import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ffmpegPath = process.env.OPENGENI_TEST_FFMPEG_PATH ?? "ffmpeg";
export const hasFfmpeg = spawnSync(ffmpegPath, ["-version"]).status === 0;

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

function tone(seconds: number, frequency: number, codec: string[], extension: string): Uint8Array {
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
      `sine=frequency=${frequency}:duration=${seconds}`,
      ...codec,
      output,
    ]);
    if (result.status !== 0) throw new Error(String(result.stderr));
    return new Uint8Array(readFileSync(output));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
