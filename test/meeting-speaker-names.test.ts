// The meeting tools and the meeting page name the same voice: a name someone
// gave reads the same in both, and an unnamed voice is the same number or
// source, which the page words in its reader's language and the tools give
// in parentheses so the model words it in the language it writes in.
import { describe, expect, test } from "bun:test";
import type { RecordingSpeaker, RecordingTrack } from "@opengeni/contracts";
import { createOpenGeniText } from "@opengeni/react/messages";
import { speakerDisplayName } from "@opengeni/react/recordings";
import { meetingSpeakerName, UNNAMED_SPEAKERS_NOTE } from "../apps/api/src/mcp/meeting-tools";

const tracks: RecordingTrack[] = [
  { trackNumber: 0, source: "microphone", mimeType: "audio/webm" },
  { trackNumber: 1, source: "system", mimeType: "audio/webm" },
  { trackNumber: 2, source: "upload", mimeType: "audio/mpeg" },
] as RecordingTrack[];

function speaker(
  label: string,
  name: string,
  named: Partial<Pick<RecordingSpeaker, "personId" | "source">> = {},
): RecordingSpeaker {
  return {
    label,
    name,
    personId: named.personId ?? null,
    source: named.source ?? null,
    confidence: null,
  };
}

// As the server lists them: unnamed voices carry their English default.
const speakers = [
  speaker("speaker_0", "Ingrid Solberg", {
    personId: "4d0f1b52-3a39-4f4e-9d0e-6f1c2b7a8e10",
    source: "confirmed",
  }),
  speaker("speaker_1", "Speaker 2"),
  speaker("speaker_2", "Tomas", { source: "confirmed" }),
  speaker("speaker_3", "Lea", { source: "suggested" }),
  speaker("t0_speaker_4", "Speaker 5"),
  speaker("track-0", "Microphone"),
  speaker("track-1", "Shared audio"),
  speaker("track-2", "Track 3"),
  speaker("A", "A"),
];

const unnamed = ["speaker_1", "t0_speaker_4", "track-0", "track-1", "track-2"];

describe("meeting speaker names", () => {
  test("named speakers read as the page shows them, suggestions marked", () => {
    const english = createOpenGeniText();
    for (const label of ["speaker_0", "speaker_2"]) {
      expect(meetingSpeakerName(label, speakers, tracks)).toEqual({
        text: speakerDisplayName(label, speakers, tracks, english),
        unnamed: false,
      });
    }
    expect(meetingSpeakerName("speaker_0", speakers, tracks).text).toBe("Ingrid Solberg");
    expect(meetingSpeakerName("speaker_3", speakers, tracks)).toEqual({
      text: "Lea (suggested)",
      unnamed: false,
    });
    // A label of no known form is shown as it is, on the page too.
    expect(meetingSpeakerName("A", speakers, tracks)).toEqual({
      text: "A",
      unnamed: false,
    });
    expect(speakerDisplayName("A", speakers, tracks, english)).toBe("A");
  });

  test("an unnamed voice is its number or source in parentheses, never the English default", () => {
    expect(unnamed.map((label) => meetingSpeakerName(label, speakers, tracks))).toEqual([
      { text: "(speaker 2)", unnamed: true },
      { text: "(speaker 5)", unnamed: true },
      { text: "(microphone)", unnamed: true },
      { text: "(shared audio)", unnamed: true },
      { text: "(track 3)", unnamed: true },
    ]);
    // Heard in the transcript before the speaker list knows it: the same.
    expect(meetingSpeakerName("speaker_7", [], tracks)).toEqual({
      text: "(speaker 8)",
      unnamed: true,
    });
  });

  test("it names the voice the English page shows", () => {
    const english = createOpenGeniText();
    for (const label of unnamed) {
      expect(meetingSpeakerName(label, speakers, tracks).text).toBe(
        `(${speakerDisplayName(label, speakers, tracks, english).toLowerCase()})`,
      );
    }
  });

  test("a page in another language shows the same number the model is given", () => {
    const norwegian = createOpenGeniText({
      locale: "nb",
      messages: {
        "meetings.recordings.speakerNumber": "Taler {number}",
        "meetings.recordings.microphone": "Mikrofon",
        "meetings.recordings.sharedAudio": "Delt lyd",
        "meetings.recordings.trackNumber": "Spor {number}",
      },
    });
    expect(unnamed.map((label) => speakerDisplayName(label, speakers, tracks, norwegian))).toEqual([
      "Taler 2",
      "Taler 5",
      "Mikrofon",
      "Delt lyd",
      "Spor 3",
    ]);
    // What the model reads is the same whatever language the page is in, and
    // never the English name the server lists, so it isn't taken for a name.
    for (const label of unnamed) {
      const { text } = meetingSpeakerName(label, speakers, tracks);
      expect(text).not.toBe(speakers.find((entry) => entry.label === label)!.name);
      expect(text).toMatch(/^\(.+\)$/u);
    }
    expect(meetingSpeakerName("speaker_1", speakers, tracks).text).toBe("(speaker 2)");
    expect(UNNAMED_SPEAKERS_NOTE).toContain("in the language you write in");
  });
});
