import { describe, expect, test } from "bun:test";
import {
  dictationPiecePlan,
  pcmWavPiece,
  planDictationPieces,
  readPcmWav,
} from "../src/activities/dictation-pieces";
import { mapConcurrently } from "../src/activities/concurrently";
import { dictationPieceLimitMilliseconds } from "../src/activities/recordings";
import type { DictationProvider } from "@opengeni/core/transcription-service";

const RATE = 16_000;

/** Speech-like noise with silent pauses at the given seconds (each 0.5 s long). */
function speech(seconds: number, pauses: number[]): Uint8Array {
  const samples = new Int16Array(seconds * RATE);
  let seed = 7;
  for (let index = 0; index < samples.length; index += 1) {
    const second = index / RATE;
    const paused = pauses.some((pause) => second >= pause && second < pause + 0.5);
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    samples[index] = paused ? 0 : ((seed % 16_000) - 8_000) | 0;
  }
  return pcmWavPiece({ sampleRate: RATE, data: new Uint8Array(samples.buffer) }, 0, samples.length);
}

describe("dictation pieces", () => {
  test("a piece is no longer than every model that may hear it takes in one request", () => {
    const model = (maxDurationSeconds: number | null, maxFileBytes: number | null) =>
      ({
        id: "voice",
        model: { capabilities: { maxDurationSeconds, maxFileBytes } },
      }) as unknown as DictationProvider;
    const service = { maxDurationSeconds: 120, maxSizeBytes: 25 * 1024 * 1024 };
    // The service's own limit when every model takes more.
    expect(dictationPieceLimitMilliseconds([model(600, null)], service)).toBe(120_000);
    // The shortest model's length.
    expect(dictationPieceLimitMilliseconds([model(600, null), model(45, null)], service)).toBe(
      45_000,
    );
    // A file limit, with a tenth spare, for a 16 kHz WAV piece (32 kB a second).
    expect(dictationPieceLimitMilliseconds([model(null, 1_600_000)], service)).toBe(45_000);
    // A short dictation is then still one piece, a long one is cut to fit.
    expect(dictationPiecePlan(45_000)).toMatchObject({
      wholeMilliseconds: 45_000,
      maxMilliseconds: 45_000,
    });
  });

  test("reads back the WAV it writes", () => {
    const wav = readPcmWav(speech(2, []));
    expect(wav?.sampleRate).toBe(RATE);
    expect(wav?.data.byteLength).toBe(2 * RATE * 2);
    expect(readPcmWav(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("a dictation up to two minutes is one piece, never cut", () => {
    const wav = readPcmWav(speech(115, [10, 60]))!;
    expect(planDictationPieces(wav)).toEqual([0, 115 * RATE]);
  });

  test("a long dictation is cut in its pauses, near the target length", () => {
    const pauses = [20, 70, 88, 140, 175, 230, 262];
    const wav = readPcmWav(speech(300, pauses))!;
    const cuts = planDictationPieces(wav).map((sample) => sample / RATE);
    expect(cuts[0]).toBe(0);
    expect(cuts.at(-1)).toBe(300);
    expect(cuts.length).toBeGreaterThan(2);
    // Every inner cut is inside a pause.
    for (const cut of cuts.slice(1, -1)) {
      expect(pauses.some((pause) => cut >= pause && cut <= pause + 0.5)).toBe(true);
    }
    // No piece is longer than the most a model takes, nor shorter than the least.
    for (let index = 1; index < cuts.length; index += 1) {
      const length = cuts[index]! - cuts[index - 1]!;
      expect(length).toBeLessThanOrEqual(120);
      expect(length).toBeGreaterThanOrEqual(30);
    }
    // The rest after the last cut is short enough to be heard whole.
    expect(300 - cuts.at(-2)!).toBeLessThanOrEqual(120);
  });

  test("with no pause at all, pieces still fit the model", () => {
    const wav = readPcmWav(speech(130, []))!;
    const cuts = planDictationPieces(wav, dictationPiecePlan(30_000));
    for (let index = 1; index < cuts.length; index += 1) {
      expect((cuts[index]! - cuts[index - 1]!) / RATE).toBeLessThanOrEqual(30);
    }
    expect(cuts.at(-1)).toBe(130 * RATE);
  });

  test("hears pieces at once, keeping their order", async () => {
    let running = 0;
    let most = 0;
    const results = await mapConcurrently([30, 10, 20, 5], 3, async (wait, index) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, wait));
      running -= 1;
      return index;
    });
    expect(results).toEqual([0, 1, 2, 3]);
    expect(most).toBe(3);
    await expect(
      mapConcurrently([1, 2], 2, async (value) => {
        if (value === 2) throw new Error("piece failed");
        return value;
      }),
    ).rejects.toThrow("piece failed");
  });
});
