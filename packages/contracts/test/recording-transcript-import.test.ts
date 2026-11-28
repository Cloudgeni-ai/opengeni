import { describe, expect, test } from "bun:test";
import {
  defaultRecordingSpeakerName,
  ImportRecordingTranscriptRequest,
  importedRecordingTranscriptSegments,
  RECORDING_IMPORT_MILLISECONDS_PER_WORD,
  recordingImportedSpeakerLabel,
  recordingTranscriptImported,
} from "../src/recordings";

describe("importedRecordingTranscriptSegments", () => {
  test("orders by start and fills each missing end with the next start", () => {
    expect(
      importedRecordingTranscriptSegments([
        { startMilliseconds: 5_000, speaker: "Ana", text: "Second" },
        { startMilliseconds: 0, text: "First" },
        { startMilliseconds: 5_000, endMilliseconds: 6_000, text: "Same start, given later" },
        { startMilliseconds: 7_500, endMilliseconds: 9_000, text: "Explicit end kept" },
      ]),
    ).toEqual([
      { startMilliseconds: 0, endMilliseconds: 5_000, speaker: null, text: "First" },
      { startMilliseconds: 5_000, endMilliseconds: 5_000, speaker: "Ana", text: "Second" },
      {
        startMilliseconds: 5_000,
        endMilliseconds: 6_000,
        speaker: null,
        text: "Same start, given later",
      },
      {
        startMilliseconds: 7_500,
        endMilliseconds: 9_000,
        speaker: null,
        text: "Explicit end kept",
      },
    ]);
  });

  test("ends the last segment after about as long as its words take", () => {
    const [only] = importedRecordingTranscriptSegments([
      { startMilliseconds: 1_000, text: "We ship it on Friday, all right?" },
    ]);
    expect(only!.endMilliseconds).toBe(1_000 + 7 * RECORDING_IMPORT_MILLISECONDS_PER_WORD);
    // Even without a word, it lasts a moment.
    const [sound] = importedRecordingTranscriptSegments([{ startMilliseconds: 0, text: "…" }]);
    expect(sound!.endMilliseconds).toBe(RECORDING_IMPORT_MILLISECONDS_PER_WORD);
  });
});

describe("ImportRecordingTranscriptRequest", () => {
  const parse = (body: unknown) => ImportRecordingTranscriptRequest.safeParse(body);

  test("trims speakers and text, and checks each segment", () => {
    const parsed = parse({
      language: "nb",
      segments: [{ startMilliseconds: 0, speaker: "  Ana ", text: " Hello " }],
    });
    expect(parsed.success && parsed.data.segments).toEqual([
      { startMilliseconds: 0, speaker: "Ana", text: "Hello" },
    ]);
    for (const segment of [
      { startMilliseconds: 10, endMilliseconds: 9, text: "Ends before it starts" },
      { startMilliseconds: 1.5, text: "Not whole milliseconds" },
      { startMilliseconds: 0, speaker: " ", text: "Blank speaker" },
      { startMilliseconds: 0, speaker: "x".repeat(201), text: "Long speaker" },
      { startMilliseconds: 0, text: "x".repeat(10_001) },
      { startMilliseconds: 0, text: "Unknown field", confidence: 1 },
    ]) {
      expect(parse({ segments: [segment] }).success).toBe(false);
    }
    expect(parse({ segments: [] }).success).toBe(false);
    expect(
      parse({ language: "English", segments: [{ startMilliseconds: 0, text: "Hi" }] }).success,
    ).toBe(false);
  });

  test("refuses more than 2 MB of text, clearly", () => {
    const segment = (index: number) => ({ startMilliseconds: index, text: "å".repeat(10_000) });
    // 20,000 bytes each: 104 is just under 2 MiB, 105 just over.
    expect(parse({ segments: Array.from({ length: 104 }, (_, i) => segment(i)) }).success).toBe(
      true,
    );
    const over = parse({ segments: Array.from({ length: 105 }, (_, i) => segment(i)) });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.message).toContain("larger than 2 MB");
  });
});

test("an imported version and its speakers are told apart", () => {
  expect(recordingTranscriptImported({ providerId: "import", model: "text" })).toBe(true);
  expect(recordingTranscriptImported({ providerId: "elevenlabs", model: "scribe_v2" })).toBe(false);
  expect(recordingTranscriptImported(null)).toBe(false);
  expect(recordingImportedSpeakerLabel(2)).toBe("imported:2");
  expect(defaultRecordingSpeakerName("imported:2", [])).toBe("Speaker 2");
});
