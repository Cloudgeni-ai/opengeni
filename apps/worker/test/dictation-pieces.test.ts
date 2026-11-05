import { describe, expect, test } from "bun:test";
import {
  dictationPiecePlan,
  nextDictationCut,
  pcmWavPiece,
  planDictationPieces,
  readPcmWav,
  type PcmWav,
} from "../src/activities/dictation-pieces";
import {
  dictationQuestion,
  keptHeardPieces,
  pcmSha256,
  readHeardDictation,
  writeHeardDictation,
  type HeardDictation,
} from "../src/activities/dictation-listening";
import { mapConcurrently } from "../src/activities/concurrently";

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

  test("while it is spoken, a piece ends in the first pause after six seconds", () => {
    const whole = readPcmWav(speech(20, [3, 9, 15]))!;
    const upTo = (seconds: number): PcmWav => ({
      sampleRate: RATE,
      data: whole.data.subarray(0, seconds * RATE * 2),
    });
    // The pause at 3 s is too early; the one at 9 s hasn't settled yet.
    expect(nextDictationCut(upTo(9.8), 0)).toBeNull();
    const cut = nextDictationCut(upTo(10.4), 0)!;
    expect(cut / RATE).toBeGreaterThanOrEqual(9);
    expect(cut / RATE).toBeLessThanOrEqual(9.5);
    // More audio finds the same cut, and the next one after it.
    expect(nextDictationCut(upTo(20), 0)).toBe(cut);
    const second = nextDictationCut(upTo(20), cut)!;
    expect(second / RATE).toBeGreaterThanOrEqual(15);
    expect(second / RATE).toBeLessThanOrEqual(15.5);
    expect(nextDictationCut(upTo(20), second)).toBeNull();
  });

  test("a speaker who never pauses is cut at the longest piece", () => {
    const wav = readPcmWav(speech(40, []))!;
    const plan = {
      minMilliseconds: 6_000,
      pauseMilliseconds: 300,
      maxMilliseconds: 20_000,
      settleMilliseconds: 600,
    };
    const short: PcmWav = { sampleRate: RATE, data: wav.data.subarray(0, 19 * RATE * 2) };
    expect(nextDictationCut(short, 0, plan)).toBeNull();
    const cut = nextDictationCut(wav, 0, plan)!;
    expect(cut / RATE).toBeGreaterThanOrEqual(6);
    expect(cut / RATE).toBeLessThanOrEqual(20);
  });

  test("the final transcript keeps heard pieces only while the audio and question are the same", () => {
    const wav = readPcmWav(speech(30, [9, 18]))!;
    const question = dictationQuestion({
      providerId: "voice-one",
      model: "voice-input",
      options: { language: "en" },
    });
    const cuts = [0, 9.25 * RATE, 18.25 * RATE];
    const record: HeardDictation = {
      version: 1,
      sampleRate: RATE,
      question,
      pieces: [0, 1].map((index) => ({
        startSample: cuts[index]!,
        endSample: cuts[index + 1]!,
        sha256: pcmSha256(wav, cuts[index]!, cuts[index + 1]!),
        heard: {
          text: `piece ${index}`,
          languages: ["en"],
          providerId: "voice-one",
          creditCostMicros: 5,
        },
      })),
    };
    const read = readHeardDictation(writeHeardDictation(record));
    expect(keptHeardPieces(read, wav, question)).toEqual(record.pieces);
    // Another model or language: heard afresh.
    expect(
      keptHeardPieces(
        read,
        wav,
        dictationQuestion({ providerId: "voice-one", model: "voice-input", options: {} }),
      ),
    ).toEqual([]);
    // The second piece's audio changed: only the first stands.
    const changed = new Uint8Array(wav.data);
    changed[Math.round(12 * RATE) * 2] ^= 0xff;
    expect(keptHeardPieces(read, { sampleRate: RATE, data: changed }, question)).toEqual([
      record.pieces[0],
    ]);
    // A piece past the end of the recording isn't kept.
    expect(
      keptHeardPieces(
        read,
        { sampleRate: RATE, data: wav.data.subarray(0, 15 * RATE * 2) },
        question,
      ),
    ).toEqual([record.pieces[0]]);
    expect(readHeardDictation(new TextEncoder().encode("{"))).toBeNull();
  });
});
