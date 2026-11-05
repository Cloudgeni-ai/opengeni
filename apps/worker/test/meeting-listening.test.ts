import { describe, expect, test } from "bun:test";
import type { PcmWav } from "../src/activities/dictation-pieces";
import {
  MEETING_LISTENING,
  meetingCutDue,
  meetingListeningPlan,
  meetingQuestion,
  nextMeetingPiece,
  readHeardMeeting,
  settledLoudness,
  writeHeardMeeting,
  type HeardMeeting,
} from "../src/activities/meeting-listening";

const RATE = 16_000;

/** Speech-like noise, silent in the given [from, to) second ranges. */
function track(seconds: number, quiet: Array<[number, number]>): PcmWav {
  const samples = new Int16Array(Math.round(seconds * RATE));
  let seed = 11;
  for (let index = 0; index < samples.length; index += 1) {
    const second = index / RATE;
    const silent = quiet.some(([from, to]) => second >= from && second < to);
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    samples[index] = silent ? 0 : ((seed % 16_000) - 8_000) | 0;
  }
  return { sampleRate: RATE, data: new Uint8Array(samples.buffer) };
}

function cut(wav: PcmWav, fromSeconds: number) {
  const found = nextMeetingPiece(
    wav,
    settledLoudness(wav, MEETING_LISTENING),
    fromSeconds * RATE,
    MEETING_LISTENING,
  );
  return found ? { seconds: found.endSample / RATE, quiet: found.quiet } : null;
}

describe("meeting pieces", () => {
  test("a piece ends at the first pause after the shortest piece, never before", () => {
    // Short breaths every few seconds, too short to cut at, as people talk.
    const breaths = Array.from({ length: 19 }, (_, index): [number, number] => [
      5 * (index + 1) + 0.1,
      5 * (index + 1) + 0.35,
    ]);
    const wav = track(100, [...breaths, [20, 20.6], [50, 50.8]]);
    const found = cut(wav, 0)!;
    expect(found.quiet).toBe(false);
    // The pause at 20 s is too early; the one at 50 s ends it, in its middle.
    expect(found.seconds).toBeGreaterThan(50.2);
    expect(found.seconds).toBeLessThan(50.6);
  });

  test("nothing is cut until a pause has settled, or the longest piece is reached", () => {
    // Talking for a minute with no pause: wait for one.
    expect(cut(track(60, []), 0)).toBeNull();
    // Nobody paused for the longest piece: cut at its quietest moment.
    const long = cut(track(160, []), 0)!;
    expect(long.seconds).toBeGreaterThanOrEqual(45);
    expect(long.seconds).toBeLessThanOrEqual(150);
    // A pause in the newest, unsettled two seconds is not cut into yet.
    expect(cut(track(50.5, [[49.5, 50.5]]), 0)).toBeNull();
  });

  test("a long quiet stretch becomes a piece of its own, never sent", () => {
    const wav = track(120, [[30, 70]]);
    // The talking before it ends a second into the quiet.
    const before = cut(wav, 0)!;
    expect(before).toEqual({ seconds: 31, quiet: false });
    // The quiet runs to a second before the talking after it.
    expect(cut(wav, before.seconds)).toEqual({ seconds: 69, quiet: true });
    // Still quiet when the audio so far ends: wait for the talking.
    expect(cut(track(60, [[30, 60]]), 31)).toBeNull();
  });

  test("a model with a shorter request limit gets shorter pieces", () => {
    expect(meetingListeningPlan(null)).toBe(MEETING_LISTENING);
    expect(meetingListeningPlan(600_000)).toBe(MEETING_LISTENING);
    expect(meetingListeningPlan(60_000)).toMatchObject({
      maxMilliseconds: 60_000,
      minMilliseconds: 18_000,
    });
  });

  test("a track is decoded again only once a piece could be cut", () => {
    const plan = MEETING_LISTENING;
    const at = (audio: number, heard: number, looked = 0) =>
      meetingCutDue({
        audioMilliseconds: audio * 1_000,
        heardMilliseconds: heard * 1_000,
        lookedMilliseconds: looked * 1_000,
        plan,
      });
    // The shortest long quiet stretch (20 s) has to have settled.
    expect(at(21, 0)).toBe(false);
    expect(at(22, 0)).toBe(true);
    // A look that cut nothing waits for 15 s more audio.
    expect(at(30, 0, 22)).toBe(false);
    expect(at(37, 0, 22)).toBe(true);
    expect(at(60, 50)).toBe(false);
  });

  test("a piece answers only the same question, and a record reads back", () => {
    const asked = {
      providerId: "elevenlabs",
      model: "scribe_v2",
      language: "en",
      diarize: false,
      maxSpeakers: undefined,
      keyterms: ["Vista"],
    };
    const question = meetingQuestion(asked);
    expect(meetingQuestion({ ...asked })).toBe(question);
    for (const changed of [
      { ...asked, model: "scribe_v1" },
      { ...asked, language: "nb" },
      { ...asked, diarize: true },
      { ...asked, maxSpeakers: 3 },
      { ...asked, keyterms: [] },
    ]) {
      expect(meetingQuestion(changed)).not.toBe(question);
    }
    const record: HeardMeeting = {
      version: 1,
      purpose: "meeting",
      sampleRate: RATE,
      question,
      pieces: [
        {
          startSample: 0,
          endSample: RATE,
          sha256: "a".repeat(64),
          quiet: false,
          cutAt: 1,
          heard: { languages: ["en"], words: [], sentMilliseconds: 1_000 },
        },
      ],
    };
    expect(readHeardMeeting(writeHeardMeeting(record))).toEqual(record);
    expect(readHeardMeeting(new TextEncoder().encode('{"version":1,"purpose":"dictation"}'))).toBe(
      null,
    );
    expect(readHeardMeeting(new Uint8Array([1, 2]))).toBeNull();
  });
});
