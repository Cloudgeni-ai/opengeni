import { TranscriptionServiceError } from "@opengeni/core";
import { createFfmpegTranscriptionSegmenter, TranscriptionSegmenterError } from "./segmenter";
import { wavDurationSeconds } from "./wav-duration";

/**
 * Decode one uploaded recording to 16 kHz mono PCM WAV with a hard decode
 * ceiling, and measure its duration from the bytes the server produced.
 */
export type TranscriptionAudioNormalizer = (input: {
  audio: Uint8Array;
  mimeType: string;
  /** Longest accepted recording; anything longer is refused, never truncated. */
  maxDurationSeconds: number;
  signal?: AbortSignal | undefined;
}) => Promise<{ bytes: Uint8Array; durationSeconds: number }>;

/**
 * ffmpeg decodes at most `maxDurationSeconds + 1` seconds (`-t`), so a long or
 * hostile upload costs bounded CPU and disk. Output that reaches that ceiling
 * was longer than the limit and is refused as `too_large` before any provider
 * call, so the transcript the user receives is never silently cut short.
 */
export function createFfmpegAudioNormalizer(input: {
  ffmpegPath: string;
}): TranscriptionAudioNormalizer {
  const segmenter = createFfmpegTranscriptionSegmenter({ ffmpegPath: input.ffmpegPath });
  return async ({ audio, mimeType, maxDurationSeconds, signal }) => {
    if (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0) {
      throw new TranscriptionServiceError({
        code: "unavailable",
        message: "Voice input duration limit is not configured.",
      });
    }
    const decodeSeconds = Math.ceil(maxDurationSeconds) + 1;
    // One segment strictly longer than the decode ceiling: never a second file.
    const segmentSeconds = decodeSeconds + 1;
    let normalized: Uint8Array | undefined;
    try {
      for await (const segment of segmenter.segment({
        sourceMimeType: mimeType,
        chunks: (async function* () {
          yield audio;
        })(),
        providerSegmentSeconds: segmentSeconds,
        totalDurationMilliseconds: segmentSeconds * 1_000,
        maxDecodeSeconds: decodeSeconds,
        ...(signal ? { signal } : {}),
      })) {
        if (normalized) {
          throw new TranscriptionServiceError({ code: "too_large", message: "Audio is too long." });
        }
        normalized = segment.bytes;
      }
    } catch (error) {
      if (error instanceof TranscriptionSegmenterError) {
        throw new TranscriptionServiceError({
          code: error.code === "unknown" ? "invalid_audio" : error.code,
          message: "Audio could not be prepared for transcription.",
          retryable: error.retryable,
        });
      }
      throw error;
    }
    const durationSeconds = normalized ? wavDurationSeconds(normalized) : null;
    if (!normalized || durationSeconds === null || !(durationSeconds > 0)) {
      throw new TranscriptionServiceError({
        code: "invalid_audio",
        message: "Audio could not be decoded.",
      });
    }
    // Reaching the decode ceiling (within one 20 ms frame) means the source ran past it.
    if (durationSeconds > decodeSeconds - 0.02) {
      throw new TranscriptionServiceError({ code: "too_large", message: "Audio is too long." });
    }
    return { bytes: normalized, durationSeconds };
  };
}
