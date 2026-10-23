import { describe, expect, test } from "bun:test";
import {
  ffmpegReportedMilliseconds,
  prepareRecordingTrackAudio,
  recordingAudioContainer,
  RecordingAudioError,
  startsAdtsFrame,
  startsContainer,
} from "../src/activities/recording-audio";

import { adtsAac, adtsFrames, ffmpegPath, hasFfmpeg, opusWebm } from "./recording-audio-fixtures";

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
    expect(recordingAudioContainer("audio/aac")).toBe("aac");
    expect(recordingAudioContainer("audio/wav")).toBeNull();
    expect(startsAdtsFrame(new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]))).toBe(true);
    expect(startsAdtsFrame(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0]))).toBe(false);
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

  /** A phone's ADTS stream cut into chunks of whole frames, about a second each. */
  function adtsChunks(seconds: number, startMilliseconds: number, frequency = 440) {
    const frames = adtsFrames(adtsAac(seconds, frequency));
    // 48 kHz, 1024 samples a frame: about 47 frames a second.
    const perChunk = 47;
    const parts: Uint8Array[] = [];
    for (let index = 0; index < frames.length; index += perChunk) {
      const slice = frames.slice(index, index + perChunk);
      const bytes = new Uint8Array(slice.reduce((sum, frame) => sum + frame.length, 0));
      let offset = 0;
      for (const frame of slice) {
        bytes.set(frame, offset);
        offset += frame.length;
      }
      parts.push(bytes);
    }
    return parts.map((bytes, index) => ({
      bytes,
      startMilliseconds: startMilliseconds + Math.round((index * perChunk * 1024 * 1000) / 48_000),
      durationMilliseconds: Math.round(
        ((Math.min(frames.length, (index + 1) * perChunk) - index * perChunk) * 1024 * 1000) /
          48_000,
      ),
    }));
  }

  test.skipIf(!hasFfmpeg)("a phone's ADTS chunks are joined and remuxed into one m4a", async () => {
    const parts = adtsChunks(3, 0);
    expect(parts.every((part) => startsAdtsFrame(part.bytes))).toBe(true);
    const prepared = await prepareRecordingTrackAudio({
      chunks: parts.map((part, index) => ({ ...part, chunkNumber: index, objectKey: `k${index}` })),
      mimeType: "audio/aac",
      ffmpegPath,
      readChunk: async (chunk) => parts[chunk.chunkNumber]!.bytes,
    });
    expect(prepared.mimeType).toBe("audio/mp4");
    expect(prepared.extension).toBe("m4a");
    expect(startsContainer(prepared.bytes)).toBe(true);
    expect(Math.abs(prepared.durationMilliseconds - 3_000)).toBeLessThan(150);
  });

  test.skipIf(!hasFfmpeg)(
    "an ADTS capture that started again lands at its own start time",
    async () => {
      const parts = [...adtsChunks(2, 0), ...adtsChunks(2, 5_000, 880)];
      const prepared = await prepareRecordingTrackAudio({
        chunks: parts.map((part, index) => ({
          ...part,
          chunkNumber: index,
          objectKey: `k${index}`,
        })),
        mimeType: "audio/aac",
        ffmpegPath,
        readChunk: async (chunk) => parts[chunk.chunkNumber]!.bytes,
      });
      expect(Math.abs(prepared.durationMilliseconds - 7_000)).toBeLessThan(200);
    },
  );

  test("an ADTS chunk after a gap must start with a frame", async () => {
    const frame = new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0x01, 0x1f, 0xfc, 0, 0]);
    await expect(
      prepareRecordingTrackAudio({
        chunks: [
          { chunkNumber: 0, startMilliseconds: 0, durationMilliseconds: 1_000, objectKey: "a" },
          { chunkNumber: 1, startMilliseconds: 9_000, durationMilliseconds: 1_000, objectKey: "b" },
        ],
        mimeType: "audio/aac",
        ffmpegPath,
        readChunk: async (chunk) => (chunk.chunkNumber === 0 ? frame : new Uint8Array(9)),
      }),
    ).rejects.toMatchObject({ code: "invalid_audio" });
  });

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
