import { describe, expect, test } from "bun:test";
import { voiceMatchingVoiceprints } from "../src/recording-voices";

describe("voiceMatchingVoiceprints", () => {
  const known = [{ personId: "me", model: "voices-1", embedding: [1, 0, 0] }];

  test("picks the voice most like the voiceprint", () => {
    expect(
      voiceMatchingVoiceprints({
        model: "voices-1",
        known,
        voices: [
          { speaker: "A", speechMilliseconds: 9_000, embedding: [0.7, 0.7, 0] },
          { speaker: "B", speechMilliseconds: 5_000, embedding: [0.95, 0.1, 0] },
        ],
      }),
    ).toBe("B");
  });

  test("needs the threshold, enough speech and the same voice model", () => {
    const match = (
      voice: { speechMilliseconds: number; embedding: number[] },
      model = "voices-1",
    ) => voiceMatchingVoiceprints({ model, known, voices: [{ speaker: "A", ...voice }] });
    expect(match({ speechMilliseconds: 9_000, embedding: [0.5, 1, 0] })).toBeNull();
    expect(match({ speechMilliseconds: 2_000, embedding: [1, 0, 0] })).toBeNull();
    expect(match({ speechMilliseconds: 9_000, embedding: [1, 0, 0] }, "voices-2")).toBeNull();
    expect(match({ speechMilliseconds: 9_000, embedding: [1, 0, 0] })).toBe("A");
  });
});
