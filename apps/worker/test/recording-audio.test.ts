import { describe, expect, test } from "bun:test";
import {
  ffmpegReportedMilliseconds,
  prepareRecordingTrackAudio,
  recordingAudioContainer,
  RecordingAudioError,
  startsContainer,
} from "../src/activities/recording-audio";

import { ffmpegPath, hasFfmpeg, opusWebm } from "./recording-audio-fixtures";

function split(bytes: Uint8Array, parts: number): Uint8Array[] {
  const size = Math.ceil(bytes.length / parts);
  return Array.from({ length: parts }, (_, index) => bytes.slice(index * size, (index + 1) * size));
}

describe("recording audio", () => {
  test("recognises container headers and types", () => {
    expect(startsContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0]))).toBe(true);
    expect(startsContainer(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))).toBe(true);
    expect(startsContainer(new Uint8Array([0x1f, 0x43, 0xb6, 0x75]))).toBe(false);
    expect(recordingAudioContainer("audio/webm;codecs=opus")).toBe("webm");
    expect(recordingAudioContainer("audio/mp4")).toBe("mp4");
    expect(recordingAudioContainer("audio/wav")).toBeNull();
    expect(
      ffmpegReportedMilliseconds("size= 1kB time=00:00:01.50 x\nsize= 2kB time=00:01:02.25"),
    ).toBe(62_250);
  });

  test.skipIf(!hasFfmpeg)("one capture session is remuxed into one seekable file", async () => {
    const parts = split(opusWebm(3), 3);
    const chunks = parts.map((_, index) => ({
      chunkNumber: index,
      startMilliseconds: index * 1_000,
      durationMilliseconds: 1_000,
      objectKey: `k${index}`,
    }));
    let progress = 0;
    const prepared = await prepareRecordingTrackAudio({
      chunks,
      mimeType: "audio/webm;codecs=opus",
      ffmpegPath,
      readChunk: async (chunk) => parts[chunk.chunkNumber]!,
      onProgress: () => {
        progress += 1;
      },
    });
    expect(prepared.mimeType).toBe("audio/webm");
    expect(prepared.offsetMilliseconds).toBe(0);
    expect(Math.abs(prepared.durationMilliseconds - 3_000)).toBeLessThan(150);
    expect(startsContainer(prepared.bytes)).toBe(true);
    expect(progress).toBe(4);
  });

  test.skipIf(!hasFfmpeg)(
    "a second session after a reload lands at its own start time",
    async () => {
      const first = split(opusWebm(2), 2);
      const second = split(opusWebm(2, 880), 2);
      const parts = [...first, ...second];
      const starts = [0, 1_000, 5_000, 6_000];
      const prepared = await prepareRecordingTrackAudio({
        chunks: parts.map((_, index) => ({
          chunkNumber: index,
          startMilliseconds: starts[index]!,
          durationMilliseconds: 1_000,
          objectKey: `k${index}`,
        })),
        mimeType: "audio/webm",
        ffmpegPath,
        readChunk: async (chunk) => parts[chunk.chunkNumber]!,
      });
      // Two seconds, a three-second gap of silence, then two more seconds.
      expect(Math.abs(prepared.durationMilliseconds - 7_000)).toBeLessThan(200);
    },
  );

  test.skipIf(!hasFfmpeg)("a missing chunk is reported as such", async () => {
    const parts = split(opusWebm(1), 2);
    await expect(
      prepareRecordingTrackAudio({
        chunks: [0, 1].map((index) => ({
          chunkNumber: index,
          startMilliseconds: index * 500,
          durationMilliseconds: 500,
          objectKey: `k${index}`,
        })),
        mimeType: "audio/webm",
        ffmpegPath,
        readChunk: async (chunk) => (chunk.chunkNumber === 0 ? parts[0]! : null),
      }),
    ).rejects.toMatchObject({ code: "missing_chunk" });
  });

  test("a track that does not start with a header is invalid", async () => {
    await expect(
      prepareRecordingTrackAudio({
        chunks: [{ chunkNumber: 0, startMilliseconds: 0, durationMilliseconds: 1, objectKey: "k" }],
        mimeType: "audio/webm",
        ffmpegPath,
        readChunk: async () => new Uint8Array([1, 2, 3, 4]),
      }),
    ).rejects.toBeInstanceOf(RecordingAudioError);
  });
});
