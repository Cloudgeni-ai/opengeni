import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRecordingSound,
  ffmpegReportedMilliseconds,
  parseSilences,
  prepareRecordingTrackAudio,
  readChunksInOrder,
  recordingAudioContainer,
  RecordingAudioError,
  RECORDING_TIMELINE_MAX_HOLE_MILLISECONDS,
  renderRecordingAudioPiece,
  soundBetweenSilences,
  startsAdtsFrame,
  startsContainer,
} from "../src/activities/recording-audio";

import {
  adtsAac,
  adtsFrames,
  ffmpegPath,
  gatedOpusWebm,
  gappedOpusWebm,
  hasFfmpeg,
  jumpedOpusWebm,
  opusWebm,
} from "./recording-audio-fixtures";

function split(bytes: Uint8Array, parts: number): Uint8Array[] {
  const size = Math.ceil(bytes.length / parts);
  return Array.from({ length: parts }, (_, index) => bytes.slice(index * size, (index + 1) * size));
}

describe("recording audio", () => {
  test("reads chunks ahead in parallel and yields them in order", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const chunks = Array.from({ length: 10 }, (_, index) => index);
    const read = async (chunk: number) => {
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      // Later chunks finish first, so ordering cannot come from completion order.
      await new Promise((resolve) => setTimeout(resolve, (10 - chunk) * 2));
      inFlight -= 1;
      return new Uint8Array([chunk]);
    };
    const seen: number[] = [];
    for await (const { chunk, bytes } of readChunksInOrder(chunks, read, 4)) {
      expect(bytes?.[0]).toBe(chunk);
      seen.push(chunk);
    }
    expect(seen).toEqual(chunks);
    expect(mostInFlight).toBe(4);
  });

  test("an early stop leaves no unhandled read failure", async () => {
    const read = async (chunk: number) => {
      if (chunk > 0) throw new Error(`read ${chunk} failed`);
      return new Uint8Array([chunk]);
    };
    for await (const { chunk } of readChunksInOrder([0, 1, 2, 3], read, 4)) {
      expect(chunk).toBe(0);
      break;
    }
    let caught: unknown;
    try {
      for await (const _ of readChunksInOrder([0, 1], read, 2)) void _;
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("read 1 failed");
  });

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

  test.skipIf(!hasFfmpeg)("one capture session is joined into one seekable file", async () => {
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

  test.skipIf(!hasFfmpeg)(
    "a header split across the first chunks still starts the track",
    async () => {
      // Chromium can hand out a session's first byte on its own before any audio arrives.
      const bytes = opusWebm(3);
      const parts = [bytes.slice(0, 1), ...split(bytes.slice(1), 3)];
      let progress = 0;
      const prepared = await prepareRecordingTrackAudio({
        chunks: parts.map((_, index) => ({
          chunkNumber: index,
          startMilliseconds: index * 1_000,
          durationMilliseconds: 1_000,
          objectKey: `k${index}`,
        })),
        mimeType: "audio/webm;codecs=opus",
        ffmpegPath,
        readChunk: async (chunk) => parts[chunk.chunkNumber]!,
        onProgress: () => {
          progress += 1;
        },
      });
      expect(prepared.offsetMilliseconds).toBe(0);
      expect(Math.abs(prepared.durationMilliseconds - 3_000)).toBeLessThan(150);
      expect(startsContainer(prepared.bytes)).toBe(true);
      expect(progress).toBe(parts.length + 1);
    },
  );

  test.skipIf(!hasFfmpeg)(
    "a later session whose header is split over short chunks lands at its own start time",
    async () => {
      const first = split(opusWebm(2), 2);
      const second = opusWebm(2, 880);
      const parts = [
        ...first,
        second.slice(0, 1),
        second.slice(1, 3),
        ...split(second.slice(3), 2),
      ];
      const starts = [0, 1_000, 5_000, 5_000, 5_000, 6_000];
      const prepared = await prepareRecordingTrackAudio({
        chunks: parts.map((_, index) => ({
          chunkNumber: index,
          startMilliseconds: starts[index]!,
          durationMilliseconds: index === 2 || index === 3 ? 0 : 1_000,
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

  test("a track of only the start of a header is invalid", async () => {
    await expect(
      prepareRecordingTrackAudio({
        chunks: [{ chunkNumber: 0, startMilliseconds: 0, durationMilliseconds: 1, objectKey: "k" }],
        mimeType: "audio/webm",
        ffmpegPath,
        readChunk: async () => new Uint8Array([0x1a]),
      }),
    ).rejects.toBeInstanceOf(RecordingAudioError);
  });

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

  test.skipIf(!hasFfmpeg)("a phone's ADTS chunks are joined into one m4a", async () => {
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

  test.skipIf(!hasFfmpeg)(
    "ffmpeg stopped from outside is an interruption, not bad audio",
    async () => {
      // A deploy stops the worker mid-prepare: ffmpeg is killed by a signal,
      // or exits saying it received one. The attempt is retried; only ffmpeg
      // failing on its own means the audio can't be prepared.
      const directory = await mkdtemp(join(tmpdir(), "fake-ffmpeg-"));
      try {
        const fakes = {
          killed: "kill -TERM $$",
          signalled: "echo 'Exiting normally, received signal 15.' >&2; exit 255",
          broken: "echo 'Invalid data found when processing input' >&2; exit 1",
        };
        const codes: Record<string, string> = {};
        for (const [name, body] of Object.entries(fakes)) {
          const path = join(directory, name);
          await writeFile(path, `#!/bin/sh\n${body}\n`);
          await chmod(path, 0o755);
          const bytes = opusWebm(1);
          const error = await prepareRecordingTrackAudio({
            chunks: [
              {
                chunkNumber: 0,
                startMilliseconds: 0,
                durationMilliseconds: 1_000,
                objectKey: "k0",
              },
            ],
            mimeType: "audio/webm",
            ffmpegPath: path,
            readChunk: async () => bytes,
          }).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(RecordingAudioError);
          codes[name] = (error as RecordingAudioError).code;
        }
        expect(codes).toEqual({
          killed: "interrupted",
          signalled: "interrupted",
          broken: "ffmpeg_failed",
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(!hasFfmpeg)(
    "a capture with holes in its timestamps is prepared on its own timeline",
    async () => {
      // Ten seconds on the timeline, seven of audio. A model that decodes the
      // prepared file itself must hear all ten, as our aligner, our diarizer
      // and the player do, or its words and our speaker turns drift apart.
      const parts = split(
        gappedOpusWebm(10, [
          [2, 4],
          [6, 7],
        ]),
        4,
      );
      const prepared = await prepareRecordingTrackAudio({
        chunks: parts.map((_, index) => ({
          chunkNumber: index,
          startMilliseconds: index * 2_500,
          durationMilliseconds: 2_500,
          objectKey: `k${index}`,
        })),
        mimeType: "audio/webm",
        ffmpegPath,
        readChunk: async (chunk) => parts[chunk.chunkNumber]!,
      });
      expect(Math.abs(prepared.durationMilliseconds - 10_000)).toBeLessThan(150);
      const plain = spawnSync(
        ffmpegPath,
        [
          "-nostdin",
          "-loglevel",
          "error",
          "-i",
          "pipe:0",
          "-f",
          "f32le",
          "-ac",
          "1",
          "-ar",
          "16000",
          "pipe:1",
        ],
        { input: prepared.bytes, maxBuffer: 1 << 26 },
      );
      const heard = (plain.stdout as Buffer).byteLength / 4 / 16_000;
      expect(Math.abs(heard - 10)).toBeLessThan(0.1);
    },
  );

  test.skipIf(!hasFfmpeg)(
    "a converted piece keeps the track's timeline across holes in its timestamps",
    async () => {
      // Ten seconds on the timeline, but only seven of audio: a plain decode
      // would close the holes up and time every later word too early.
      const audio = {
        bytes: gappedOpusWebm(10, [
          [2, 4],
          [6, 7],
        ]),
        extension: "webm",
      };
      const seconds = (wav: Uint8Array) => (wav.byteLength - 44) / 32_000;
      const whole = await renderRecordingAudioPiece({
        audio,
        startMilliseconds: 0,
        endMilliseconds: 10_000,
        whole: true,
        format: "wav",
        ffmpegPath,
      });
      expect(Math.abs(seconds(whole.bytes) - 10)).toBeLessThan(0.1);
      // A cut across a hole is as long as the stretch of timeline it covers.
      const piece = await renderRecordingAudioPiece({
        audio,
        startMilliseconds: 5_000,
        endMilliseconds: 9_000,
        whole: false,
        format: "wav",
        ffmpegPath,
      });
      expect(Math.abs(seconds(piece.bytes) - 4)).toBeLessThan(0.1);
    },
  );

  test.skipIf(!hasFfmpeg)(
    "a hole too long to fill, or audio past its declared length, is refused before decoding",
    async () => {
      // A second of audio, a few kilobytes, whose timestamps claim far more:
      // the timeline filter would hold every second of each hole in memory.
      const overHole = (RECORDING_TIMELINE_MAX_HOLE_MILLISECONDS + 60_000) / 1_000;
      const prepare = (
        bytes: readonly Uint8Array[],
        chunks: ReadonlyArray<{ startMilliseconds: number; durationMilliseconds: number }>,
      ) =>
        prepareRecordingTrackAudio({
          chunks: chunks.map((chunk, index) => ({
            ...chunk,
            chunkNumber: index,
            objectKey: `k${index}`,
          })),
          mimeType: "audio/webm",
          ffmpegPath,
          readChunk: async (chunk) => bytes[chunk.chunkNumber]!,
        });
      const refused = async (attempt: Promise<unknown>, message: RegExp) => {
        const error = await attempt.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RecordingAudioError);
        expect((error as RecordingAudioError).code).toBe("invalid_audio");
        expect((error as RecordingAudioError).message).toMatch(message);
      };
      // A hole between packets, however long the chunks claim to be.
      const declaredLong = [{ startMilliseconds: 0, durationMilliseconds: 10 * 3_600_000 }];
      await refused(prepare([jumpedOpusWebm(1, 25, overHole)], declaredLong), /gap/u);
      // A first packet stamped long after time zero.
      await refused(prepare([jumpedOpusWebm(1, 0, overHole)], declaredLong), /gap/u);
      // A hole short enough to fill, but past what the chunks declared.
      await refused(
        prepare(
          [jumpedOpusWebm(1, 25, 30)],
          [{ startMilliseconds: 0, durationMilliseconds: 2_000 }],
        ),
        /declared length/u,
      );
      // Each run of a track is checked on its own.
      await refused(
        prepare(
          [opusWebm(1), jumpedOpusWebm(1, 25, overHole)],
          [
            { startMilliseconds: 0, durationMilliseconds: 1_000 },
            { startMilliseconds: 5_000, durationMilliseconds: 10 * 3_600_000 },
          ],
        ),
        /gap/u,
      );
      // A hole within the limit, inside the declared length, is still filled.
      const filled = await prepare(
        [jumpedOpusWebm(1, 25, 3)],
        [{ startMilliseconds: 0, durationMilliseconds: 4_000 }],
      );
      expect(Math.abs(filled.durationMilliseconds - 4_000)).toBeLessThan(150);
    },
  );

  test("audio that comes out far longer than declared is not kept", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fake-ffmpeg-"));
    try {
      // Prints no packets for the timestamp check, then claims an hour of output.
      const path = join(directory, "ffmpeg");
      await writeFile(
        path,
        [
          "#!/bin/sh",
          "for last; do :; done",
          '[ "$last" = "-" ] || printf x > "$last"',
          "echo 'size=1kB time=01:00:00.00 bitrate=1kbits/s' >&2",
        ].join("\n"),
      );
      await chmod(path, 0o755);
      const header = new Uint8Array(64);
      header.set([0x1a, 0x45, 0xdf, 0xa3]);
      const error = await prepareRecordingTrackAudio({
        chunks: [
          { chunkNumber: 0, startMilliseconds: 0, durationMilliseconds: 1_000, objectKey: "k" },
        ],
        mimeType: "audio/webm",
        ffmpegPath: path,
        readChunk: async () => header,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RecordingAudioError);
      expect((error as RecordingAudioError).code).toBe("invalid_audio");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

  test("long quiet stretches are left out, with a margin of sound kept around them", () => {
    const stderr = [
      "[silencedetect @ 0x1] silence_start: 0",
      "[silencedetect @ 0x1] silence_end: 30.5 | silence_duration: 30.5",
      "[silencedetect @ 0x1] silence_start: 40.25",
      "[silencedetect @ 0x1] silence_end: 70 | silence_duration: 29.75",
      "[silencedetect @ 0x1] silence_start: 95",
    ].join("\n");
    const silences = parseSilences(stderr, 120_000);
    expect(silences).toEqual([
      { startMilliseconds: 0, endMilliseconds: 30_500 },
      { startMilliseconds: 40_250, endMilliseconds: 70_000 },
      { startMilliseconds: 95_000, endMilliseconds: 120_000 },
    ]);
    expect(soundBetweenSilences(silences, 120_000)).toEqual([
      { startMilliseconds: 29_500, endMilliseconds: 41_250 },
      { startMilliseconds: 69_000, endMilliseconds: 96_000 },
    ]);
    // A short sound between two silences keeps its margins; margins that meet
    // across a short silence join; no silence is all sound; all silence is none.
    expect(
      soundBetweenSilences(
        [
          { startMilliseconds: 10_000, endMilliseconds: 30_000 },
          { startMilliseconds: 31_000, endMilliseconds: 60_000 },
        ],
        60_000,
      ),
    ).toEqual([
      { startMilliseconds: 0, endMilliseconds: 11_000 },
      { startMilliseconds: 29_000, endMilliseconds: 32_000 },
    ]);
    expect(
      soundBetweenSilences([{ startMilliseconds: 10_000, endMilliseconds: 11_500 }], 60_000),
    ).toEqual([{ startMilliseconds: 0, endMilliseconds: 60_000 }]);
    expect(soundBetweenSilences([], 60_000)).toEqual([
      { startMilliseconds: 0, endMilliseconds: 60_000 },
    ]);
    expect(
      soundBetweenSilences([{ startMilliseconds: 0, endMilliseconds: 60_000 }], 60_000),
    ).toEqual([]);
  });

  test.skipIf(!hasFfmpeg)("finds the sound in a track, and none in a silent one", async () => {
    // However short a silent track is, it has no sound; a short tone is all sound.
    expect(
      await detectRecordingSound({
        audio: { bytes: gatedOpusWebm(2, []), extension: "webm" },
        durationMilliseconds: 2_000,
        ffmpegPath,
      }),
    ).toEqual([]);
    expect(
      await detectRecordingSound({
        audio: { bytes: opusWebm(2), extension: "webm" },
        durationMilliseconds: 2_000,
        ffmpegPath,
      }),
    ).toEqual([{ startMilliseconds: 0, endMilliseconds: 2_000 }]);
    const near = (actual: number, expected: number) =>
      expect(Math.abs(actual - expected)).toBeLessThan(300);
    const sound = await detectRecordingSound({
      audio: {
        bytes: gatedOpusWebm(80, [
          [0, 5],
          [40, 45],
        ]),
        extension: "webm",
      },
      durationMilliseconds: 80_000,
      ffmpegPath,
    });
    expect(sound).toHaveLength(2);
    near(sound[0]!.startMilliseconds, 0);
    near(sound[0]!.endMilliseconds, 6_000);
    near(sound[1]!.startMilliseconds, 39_000);
    near(sound[1]!.endMilliseconds, 46_000);
    expect(
      await detectRecordingSound({
        audio: { bytes: gatedOpusWebm(30, []), extension: "webm" },
        durationMilliseconds: 30_000,
        ffmpegPath,
      }),
    ).toEqual([]);
    // A short pause stays in.
    expect(
      await detectRecordingSound({
        audio: {
          bytes: gatedOpusWebm(30, [
            [0, 10],
            [20, 30],
          ]),
          extension: "webm",
        },
        durationMilliseconds: 30_000,
        ffmpegPath,
      }),
    ).toEqual([{ startMilliseconds: 0, endMilliseconds: 30_000 }]);
  });
});
