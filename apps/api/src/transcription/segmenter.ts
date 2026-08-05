import type { PreparedTranscriptionSegment, TranscriptionSegmenter } from "@opengeni/core";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const STDERR_MAX_BYTES = 64 * 1024;

export class TranscriptionSegmenterError extends Error {
  readonly name = "TranscriptionSegmenterError";

  constructor(
    message: string,
    readonly code: "unavailable" | "invalid_audio" | "cancelled" | "too_large" | "unknown",
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function createFfmpegTranscriptionSegmenter(input: {
  ffmpegPath: string;
}): TranscriptionSegmenter {
  let availability: Promise<boolean> | null = null;
  return {
    available() {
      availability ??= commandSucceeds(input.ffmpegPath, ["-version"]);
      return availability;
    },
    async *segment(request): AsyncIterable<PreparedTranscriptionSegment> {
      if (request.signal?.aborted) {
        throw new TranscriptionSegmenterError(
          "Audio segmentation was cancelled",
          "cancelled",
          true,
        );
      }
      if (
        !Number.isSafeInteger(request.providerSegmentSeconds) ||
        request.providerSegmentSeconds <= 0 ||
        !Number.isSafeInteger(request.totalDurationMilliseconds) ||
        request.totalDurationMilliseconds <= 0
      ) {
        throw new TranscriptionSegmenterError(
          "Audio segmentation bounds are invalid",
          "invalid_audio",
          false,
        );
      }
      if (
        Math.ceil(request.totalDurationMilliseconds / (request.providerSegmentSeconds * 1_000)) >
        1_000
      ) {
        throw new TranscriptionSegmenterError(
          "Audio exceeds the bounded segment projection",
          "too_large",
          false,
        );
      }
      const directory = await mkdtemp(join(tmpdir(), "opengeni-transcription-"));
      const inputPath = join(
        directory,
        `recording.${extensionForMimeType(request.sourceMimeType)}`,
      );
      const outputPattern = join(directory, "segment-%06d.wav");
      try {
        await writeChunks(inputPath, request.chunks, request.signal);
        const result = await runCommand(
          input.ffmpegPath,
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            inputPath,
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-f",
            "segment",
            "-segment_time",
            String(request.providerSegmentSeconds),
            "-reset_timestamps",
            "1",
            outputPattern,
          ],
          request.signal,
        );
        if (result.cancelled) {
          throw new TranscriptionSegmenterError(
            "Audio segmentation was cancelled",
            "cancelled",
            true,
          );
        }
        if (result.spawnError) {
          throw new TranscriptionSegmenterError(
            "Audio segmentation is unavailable",
            "unavailable",
            true,
          );
        }
        if (result.exitCode !== 0) {
          throw new TranscriptionSegmenterError(
            result.stderr || "Audio could not be decoded",
            "invalid_audio",
            false,
          );
        }
        const files = (await readdir(directory))
          .filter((file) => /^segment-[0-9]{6}\.wav$/.test(file))
          .sort();
        if (files.length === 0 || files.length > 1_000) {
          throw new TranscriptionSegmenterError(
            "Audio did not produce a bounded segment set",
            "invalid_audio",
            false,
          );
        }
        const segmentMilliseconds = request.providerSegmentSeconds * 1_000;
        for (let segmentNumber = 0; segmentNumber < files.length; segmentNumber += 1) {
          if (request.signal?.aborted) {
            throw new TranscriptionSegmenterError(
              "Audio segmentation was cancelled",
              "cancelled",
              true,
            );
          }
          const bytes = new Uint8Array(await readFile(join(directory, files[segmentNumber]!)));
          if (bytes.byteLength === 0) {
            throw new TranscriptionSegmenterError(
              "Audio produced an empty segment",
              "invalid_audio",
              false,
            );
          }
          const startMilliseconds = segmentNumber * segmentMilliseconds;
          const remaining = request.totalDurationMilliseconds - startMilliseconds;
          if (remaining <= 0) {
            throw new TranscriptionSegmenterError(
              "Audio segment count exceeds the declared duration",
              "invalid_audio",
              false,
            );
          }
          yield {
            segmentNumber,
            startMilliseconds,
            durationMilliseconds: Math.min(segmentMilliseconds, remaining),
            mimeType: "audio/wav",
            bytes,
          };
        }
      } catch (error) {
        if (error instanceof TranscriptionSegmenterError) throw error;
        throw new TranscriptionSegmenterError(
          error instanceof Error ? error.message : "Audio segmentation failed",
          request.signal?.aborted ? "cancelled" : "unknown",
          true,
        );
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

async function writeChunks(
  path: string,
  chunks: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const stream = createWriteStream(path, { flags: "wx" });
  try {
    for await (const chunk of chunks) {
      if (signal?.aborted) {
        throw new TranscriptionSegmenterError(
          "Audio segmentation was cancelled",
          "cancelled",
          true,
        );
      }
      if (!stream.write(chunk)) await once(stream, "drain");
    }
    stream.end();
    await once(stream, "close");
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.trim().toLowerCase().split(";", 1)[0]) {
    case "audio/mp4":
    case "audio/m4a":
      return "mp4";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
    default:
      return "webm";
  }
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  const result = await runCommand(command, args);
  return !result.spawnError && result.exitCode === 0;
}

async function runCommand(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; stderr: string; spawnError: boolean; cancelled: boolean }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = Buffer.alloc(0);
    let spawnError = false;
    let settled = false;
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stderr.on("data", (chunk: Uint8Array) => {
      if (stderr.byteLength >= STDERR_MAX_BYTES) return;
      const remaining = STDERR_MAX_BYTES - stderr.byteLength;
      stderr = Buffer.concat([stderr, Buffer.from(chunk).subarray(0, remaining)]);
    });
    child.once("error", () => {
      spawnError = true;
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stderr: stderr.toString("utf8").trim(),
        spawnError,
        cancelled: signal?.aborted ?? false,
      });
    });
  });
}
