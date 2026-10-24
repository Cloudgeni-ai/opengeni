import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalDiarizer,
  parseDiarization,
  recordingSpeakersConfig,
} from "../src/activities/recording-speakers";
import { ffmpegPath, hasFfmpeg, opusWebm } from "./recording-audio-fixtures";

let directory = "";

// Stands in for opengeni-speakers: reports how much PCM arrived, or fails
// the way the real one does.
const FAKE_SPEAKERS = [
  "#!/bin/sh",
  "bytes=$(wc -c | tr -d ' ')",
  `case "$*" in *"--max-speakers 1"*) echo '{"error":"no voices"}' >&2; exit 1;; esac`,
  `printf '{"turns":[{"startMs":0,"endMs":%d,"speaker":0}],"speakers":[{"speaker":0,"speechMs":5,"embedding":[1,0]}]}\\n' $((bytes / 64))`,
  "",
].join("\n");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "speakers-test-"));
  await writeFile(join(directory, "speakers"), FAKE_SPEAKERS);
  await chmod(join(directory, "speakers"), 0o755);
  await writeFile(join(directory, "segmentation.onnx"), "");
  await writeFile(join(directory, "embedding.onnx"), "");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("recording speaker models", () => {
  test("are configured only when the executable and both models exist", () => {
    const base = { voiceInputFfmpegPath: "ffmpeg" };
    expect(recordingSpeakersConfig(base)).toBeNull();
    expect(
      recordingSpeakersConfig({
        ...base,
        recordingSpeakersBinaryPath: join(directory, "speakers"),
        recordingSpeakerModelsDir: join(directory, "missing"),
      }),
    ).toBeNull();
    expect(
      recordingSpeakersConfig({
        ...base,
        recordingSpeakersBinaryPath: join(directory, "speakers"),
        recordingSpeakerModelsDir: directory,
      }),
    ).toEqual({
      binaryPath: join(directory, "speakers"),
      modelsDir: directory,
      ffmpegPath: "ffmpeg",
    });
  });

  test("parse turns and voices with string speaker ids", () => {
    expect(
      parseDiarization(
        '{"turns":[{"startMs":10,"endMs":20,"speaker":1}],"speakers":[{"speaker":1,"speechMs":10,"embedding":[0.6,0.8]}]}',
        "model-a",
      ),
    ).toEqual({
      voiceModel: "model-a",
      turns: [{ startMilliseconds: 10, endMilliseconds: 20, speaker: "S1" }],
      voices: [{ speaker: "S1", speechMilliseconds: 10, embedding: [0.6, 0.8] }],
    });
  });

  test.skipIf(!hasFfmpeg)("decode the track to 16 kHz float PCM for the executable", async () => {
    const diarizer = createLocalDiarizer({
      binaryPath: join(directory, "speakers"),
      modelsDir: directory,
      ffmpegPath,
    });
    const audio = { bytes: opusWebm(2), mimeType: "audio/webm", fileName: "track-1.webm" };
    const result = await diarizer.diarize(audio, { maxSpeakers: 3 });
    // Two seconds at 16 kHz and four bytes a sample, reported as bytes / 64.
    expect(result.turns[0]!.endMilliseconds).toBeGreaterThan(1_900);
    expect(result.turns[0]!.endMilliseconds).toBeLessThan(2_100);
    expect(result.voices).toEqual([{ speaker: "S0", speechMilliseconds: 5, embedding: [1, 0] }]);
    expect(result.voiceModel).toMatch(/^opengeni-cpu:[0-9a-f]{16}$/u);
    await expect(diarizer.diarize(audio, { maxSpeakers: 1 })).rejects.toThrow(
      "speaker models failed: no voices",
    );
  });
});
