import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createFfmpegTranscriptionSegmenter,
  TranscriptionSegmenterError,
} from "@opengeni/core/transcription-service";

async function* chunks(): AsyncIterable<Uint8Array> {
  yield new Uint8Array([1]);
  yield new Uint8Array([2]);
}

describe("ffmpeg transcription segmenter", () => {
  test("normalizes chunks into deterministic bounded PCM WAV segments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opengeni-fake-ffmpeg-"));
    const ffmpegPath = join(directory, "ffmpeg");
    await writeFile(
      ffmpegPath,
      `#!/bin/sh
if [ "$1" = "-version" ]; then
  exit 0
fi
for argument in "$@"; do
  output="$argument"
done
output_directory="\${output%/*}"
printf '\\001' > "$output_directory/segment-000000.wav"
printf '\\002' > "$output_directory/segment-000001.wav"
`,
    );
    await chmod(ffmpegPath, 0o755);

    try {
      const segmenter = createFfmpegTranscriptionSegmenter({ ffmpegPath });
      expect(await segmenter.available()).toBe(true);
      const segments = [];
      for await (const segment of segmenter.segment({
        sourceMimeType: "audio/webm;codecs=opus",
        totalDurationMilliseconds: 70_000,
        providerSegmentSeconds: 50,
        chunks: chunks(),
      })) {
        segments.push(segment);
      }
      expect(segments).toEqual([
        {
          segmentNumber: 0,
          startMilliseconds: 0,
          durationMilliseconds: 50_000,
          mimeType: "audio/wav",
          bytes: new Uint8Array([1]),
        },
        {
          segmentNumber: 1,
          startMilliseconds: 50_000,
          durationMilliseconds: 20_000,
          mimeType: "audio/wav",
          bytes: new Uint8Array([2]),
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects more than 1,000 projected segments before invoking ffmpeg", async () => {
    const segmenter = createFfmpegTranscriptionSegmenter({
      ffmpegPath: "/does/not/exist",
    });
    let caught: unknown;
    try {
      for await (const _segment of segmenter.segment({
        sourceMimeType: "audio/webm",
        totalDurationMilliseconds: 1_001_000,
        providerSegmentSeconds: 1,
        chunks: chunks(),
      })) {
        // The bounds check must fail before yielding or spawning.
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TranscriptionSegmenterError);
    expect(caught).toMatchObject({ code: "too_large", retryable: false });
  });

  test("ffmpeg stopped from outside is retried; ffmpeg failing on its own is bad audio", async () => {
    const segment = async (
      runCommand: () => Promise<{ exitCode: number | null; stderr: string }>,
    ) => {
      const segmenter = createFfmpegTranscriptionSegmenter({
        ffmpegPath: "ffmpeg",
        runCommand: async () => ({ ...(await runCommand()), spawnError: false, cancelled: false }),
      });
      try {
        for await (const _segment of segmenter.segment({
          sourceMimeType: "audio/webm",
          totalDurationMilliseconds: 10_000,
          providerSegmentSeconds: 50,
          chunks: chunks(),
        })) {
          // Fails before a segment is read.
        }
      } catch (error) {
        return error;
      }
      return null;
    };
    // Killed with the worker, or ffmpeg's own exit after a signal.
    expect(await segment(async () => ({ exitCode: null, stderr: "" }))).toMatchObject({
      code: "cancelled",
      retryable: true,
    });
    expect(
      await segment(async () => ({
        exitCode: 255,
        stderr: "Exiting normally, received signal 15.",
      })),
    ).toMatchObject({ code: "cancelled", retryable: true });
    expect(
      await segment(async () => ({
        exitCode: 1,
        stderr: "Invalid data found when processing input",
      })),
    ).toMatchObject({ code: "invalid_audio", retryable: false });
  });
});
