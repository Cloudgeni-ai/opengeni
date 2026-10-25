import { beforeAll, describe, expect, test } from "bun:test";
import type { RecordingTranscriptionProvider } from "@opengeni/core";
import { transcribeTrack } from "../src/activities/recordings";
import { ffmpegPath, hasFfmpeg, opusWebm } from "./recording-audio-fixtures";

const capabilities = {
  batch: true,
  live: false,
  diarization: false,
  liveDiarization: false,
  multichannel: false,
  maxSpeakers: null,
  wordTimestamps: true,
  languages: [],
  languageDetection: true,
  keyterms: false,
  speakerLibrary: false,
  maxDurationSeconds: null as number | null,
  maxFileBytes: null as number | null,
};

/** A model that hears one word per second of whatever it is sent. */
function countingProvider(sent: Array<{ mimeType: string; fileName: string; head: string }>) {
  return {
    id: "fake",
    name: "Fake",
    models: [],
    async transcribe(input) {
      sent.push({
        mimeType: input.audio.mimeType,
        fileName: input.audio.fileName,
        head: new TextDecoder().decode(input.audio.bytes.slice(0, 4)),
      });
      const seconds = await probeSeconds(input.audio.bytes, input.audio.fileName);
      return {
        languages: ["en"],
        audioMilliseconds: Math.round(seconds * 1_000),
        diarized: false,
        words: Array.from({ length: Math.floor(seconds) }, (_, index) => ({
          text: `w`,
          startMilliseconds: index * 1_000 + 100,
          endMilliseconds: index * 1_000 + 400,
          speaker: null,
          spaceBefore: index > 0,
        })),
      };
    },
  } satisfies RecordingTranscriptionProvider;
}

async function probeSeconds(bytes: Uint8Array, fileName: string): Promise<number> {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "transcribe-track-test-"));
  try {
    const path = join(directory, fileName);
    await writeFile(path, bytes);
    const result = spawnSync(ffmpegPath, ["-nostdin", "-i", path, "-f", "null", "-"], {
      encoding: "utf8",
    });
    const matches = [...String(result.stderr).matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/gu)];
    const last = matches.at(-1)!;
    return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!hasFfmpeg)("transcribeTrack", () => {
  // A skipped describe still runs its body, so the tone is made only when the tests run.
  const audio = {
    bytes: new Uint8Array(),
    mimeType: "audio/webm",
    fileName: "track-1.webm",
    extension: "webm",
  };
  beforeAll(() => {
    audio.bytes = opusWebm(25);
  });
  const request = { model: "m", diarize: false };

  test("sends a track the model takes as it is, untouched", async () => {
    const sent: Array<{ mimeType: string; fileName: string; head: string }> = [];
    const result = await transcribeTrack({
      provider: countingProvider(sent),
      spec: { model: "m", name: "M", capabilities, usdPerHour: null },
      audio,
      durationMilliseconds: 25_000,
      ffmpegPath,
      credentials: { apiKey: "k" },
      request,
    });
    expect(sent).toEqual([
      { mimeType: "audio/webm", fileName: "track-1.webm", head: "\u001aE\u07e3" },
    ]);
    expect(result.words).toHaveLength(25);
  });

  test("converts to the model's format and sends a long track in overlapping pieces", async () => {
    const sent: Array<{ mimeType: string; fileName: string; head: string }> = [];
    const pieces: number[] = [];
    const result = await transcribeTrack({
      provider: countingProvider(sent),
      spec: {
        model: "m",
        name: "M",
        capabilities: { ...capabilities, maxDurationSeconds: 12 },
        usdPerHour: null,
        audioFormats: ["flac", "mp3"],
      },
      audio,
      durationMilliseconds: 25_000,
      ffmpegPath,
      credentials: { apiKey: "k" },
      request,
      onPiece: (index) => pieces.push(index),
    });
    // 12 s pieces with 3 s overlap: windows of 6 s.
    expect(pieces).toEqual([0, 1, 2, 3, 4]);
    expect(sent.every((item) => item.mimeType === "audio/flac" && item.head === "fLaC")).toBe(true);
    expect(sent.map((item) => item.fileName)).toEqual([
      "track-1-0.flac",
      "track-1-1.flac",
      "track-1-2.flac",
      "track-1-3.flac",
      "track-1-4.flac",
    ]);
    // One word a second, each kept once on the track's own timeline.
    expect(result.words.map((word) => Math.round(word.startMilliseconds / 1_000))).toEqual(
      Array.from({ length: 25 }, (_, index) => index),
    );
  });
});
