import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const ffmpegPath = process.env.OPENGENI_TEST_FFMPEG_PATH ?? "ffmpeg";
export const hasFfmpeg = spawnSync(ffmpegPath, ["-version"]).status === 0;

/** A WebM/Opus tone, the way a browser MediaRecorder would produce it. */
export function opusWebm(seconds: number, frequency = 440): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "recording-audio-test-"));
  try {
    const output = join(directory, "tone.webm");
    const result = spawnSync(ffmpegPath, [
      "-nostdin",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:duration=${seconds}`,
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-ac",
      "1",
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
