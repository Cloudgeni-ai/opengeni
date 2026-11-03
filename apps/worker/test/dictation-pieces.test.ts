import { describe, expect, test } from "bun:test";
import {
  dictationPiecePlan,
  mapConcurrently,
  pcmWavPiece,
  planDictationPieces,
  readPcmWav,
} from "../src/activities/dictation-pieces";

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
  test("reads back the WAV it writes", () => {
    const wav = readPcmWav(speech(2, []));
    expect(wav?.sampleRate).toBe(RATE);
    expect(wav?.data.byteLength).toBe(2 * RATE * 2);
    expect(readPcmWav(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  test("a short dictation is one piece, never cut", () => {
    const wav = readPcmWav(speech(20, [10]))!;
    expect(planDictationPieces(wav)).toEqual([0, 20 * RATE]);
  });

  test("a long dictation is cut in its pauses, near the target length", () => {
    const wav = readPcmWav(speech(70, [6, 14, 31, 47, 60]))!;
    const cuts = planDictationPieces(wav).map((sample) => sample / RATE);
    expect(cuts[0]).toBe(0);
    expect(cuts.at(-1)).toBe(70);
    // Every inner cut is inside a pause.
    for (const cut of cuts.slice(1, -1)) {
      expect([14, 31, 47, 60].some((pause) => cut >= pause && cut <= pause + 0.5)).toBe(true);
    }
    // No piece is longer than the most a model takes, nor shorter than the least.
    for (let index = 1; index < cuts.length; index += 1) {
      const length = cuts[index]! - cuts[index - 1]!;
      expect(length).toBeLessThanOrEqual(50);
      expect(length).toBeGreaterThanOrEqual(8);
    }
    // The rest after the last cut is short enough to be heard whole.
    expect(70 - cuts.at(-2)!).toBeLessThanOrEqual(25);
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
