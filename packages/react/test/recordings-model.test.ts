import { describe, expect, test } from "bun:test";

import type {
  Recording,
  RecordingTrack,
  RecordingTranscriptSegment,
  RecordingTranscriptVersion,
} from "@opengeni/contracts";

import {
  activeSegmentIndex,
  defaultSpeakerName,
  formatClock,
  formatDuration,
  groupTranscriptTurns,
  languageName,
  meetingPhase,
  speakerColorSlots,
  speakerDisplayName,
  speakerIsNamed,
  transcriptErrorText,
} from "../src/recordings-model";

function segment(
  index: number,
  start: number,
  end: number,
  speakerLabel: string | null,
): RecordingTranscriptSegment {
  return {
    index,
    startMilliseconds: start,
    endMilliseconds: end,
    trackNumber: 0,
    speakerLabel,
    text: `line ${index}`,
    edited: false,
  };
}

function version(state: RecordingTranscriptVersion["state"]): RecordingTranscriptVersion {
  return {
    id: "v1",
    recordingId: "r1",
    versionNumber: 1,
    providerId: "elevenlabs",
    model: "scribe_v2",
    options: {},
    state,
    isCurrent: state === "complete",
    languages: [],
    diarized: true,
    diarization: "provider",
    audioMilliseconds: 0,
    segmentCount: 0,
    costUsd: null,
    requestedBySubjectId: "user:1",
    errorCode: null,
    createdAt: "2026-10-23T10:00:00Z",
    completedAt: null,
  };
}

function recordingWith(
  state: Recording["state"],
  transcript: RecordingTranscriptVersion | null,
): Recording {
  return {
    id: "r1",
    workspaceId: "w1",
    ownerSubjectId: "user:1",
    visibility: "private",
    title: "Sync",
    state,
    startedAt: "2026-10-23T10:00:00Z",
    captureEndedAt: null,
    durationMilliseconds: 0,
    externalRef: null,
    metadata: {},
    transcription: {},
    tracks: [],
    transcript,
    createdAt: "2026-10-23T10:00:00Z",
    updatedAt: "2026-10-23T10:00:00Z",
  };
}

const tracks: RecordingTrack[] = [
  {
    trackNumber: 0,
    kind: "audio",
    source: "microphone",
    mimeType: "audio/webm",
    chunkCount: 1,
    totalBytes: 1,
    durationMilliseconds: 1,
    playable: true,
  },
  {
    trackNumber: 1,
    kind: "audio",
    source: "system",
    mimeType: "audio/webm",
    chunkCount: 1,
    totalBytes: 1,
    durationMilliseconds: 1,
    playable: true,
  },
];

describe("formatting", () => {
  test("clock times round down and add hours only when needed", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(247_900)).toBe("4:07");
    expect(formatClock(3_729_000)).toBe("1:02:09");
    expect(formatClock(-5)).toBe("0:00");
  });

  test("durations read as seconds, minutes, then hours", () => {
    expect(formatDuration(45_000)).toBe("45 sec");
    expect(formatDuration(12 * 60_000)).toBe("12 min");
    expect(formatDuration(65 * 60_000)).toBe("1 h 5 min");
    expect(formatDuration(120 * 60_000)).toBe("2 h");
  });
});

describe("meetingPhase", () => {
  test("capturing is uploading, whatever the transcript", () => {
    expect(meetingPhase(recordingWith("capturing", null)).kind).toBe("uploading");
  });

  test("a complete current version is ready even while the recording is reprocessing", () => {
    expect(meetingPhase(recordingWith("processing", version("complete"))).kind).toBe("ready");
  });

  test("queued and processing versions are transcribing", () => {
    expect(meetingPhase(recordingWith("processing", version("queued"))).kind).toBe("transcribing");
    expect(meetingPhase(recordingWith("processing", null)).kind).toBe("transcribing");
  });

  test("a failed version or recording is failed", () => {
    expect(meetingPhase(recordingWith("failed", version("failed"))).kind).toBe("failed");
    expect(meetingPhase(recordingWith("failed", null)).kind).toBe("failed");
  });
});

describe("speakers", () => {
  test("language names read the same with or without Intl.DisplayNames", () => {
    expect(languageName("en")).toBe("English");
    expect(languageName("eng")).toBe("English");
    expect(languageName("zz")).toBe("zz");
    const displayNames = Intl.DisplayNames;
    const canonical = Intl.getCanonicalLocales;
    try {
      // Hermes, the phone's JavaScript engine, has no Intl.DisplayNames and
      // leaves three-letter codes as they are.
      Reflect.deleteProperty(Intl, "DisplayNames");
      Object.defineProperty(Intl, "getCanonicalLocales", {
        value: (code: string) => [code],
        configurable: true,
        writable: true,
      });
      expect(languageName("eng")).toBe("English");
      expect(languageName("nob")).toBe("Norwegian Bokmål");
      expect(languageName("en-GB")).toBe("English");
      expect(languageName("zz")).toBe("zz");
    } finally {
      Object.defineProperty(Intl, "DisplayNames", {
        value: displayNames,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(Intl, "getCanonicalLocales", {
        value: canonical,
        configurable: true,
        writable: true,
      });
    }
  });

  const speakers = [
    {
      label: "speaker_0",
      name: "Maja Berg",
      personId: "p1",
      source: "confirmed" as const,
      confidence: null,
    },
    // The server's default name for a label nobody named.
    { label: "speaker_1", name: "Speaker 2", personId: null, source: null, confidence: null },
    {
      label: "speaker_2",
      name: "Pilot customer",
      personId: null,
      source: "confirmed" as const,
      confidence: null,
    },
  ];

  test("named labels show the name; model labels count from one", () => {
    expect(speakerDisplayName("speaker_0", speakers, tracks)).toBe("Maja Berg");
    expect(speakerDisplayName("speaker_1", speakers, tracks)).toBe("Speaker 2");
    expect(speakerDisplayName("t1_speaker_3", speakers, tracks)).toBe("Speaker 4");
    expect(speakerDisplayName(null, speakers, tracks)).toBe("Unknown speaker");
  });

  test("track labels name the track's role", () => {
    expect(defaultSpeakerName("track-0", tracks)).toBe("Microphone");
    expect(defaultSpeakerName("track-1", tracks)).toBe("Shared audio");
    expect(defaultSpeakerName("track-4", tracks)).toBe("Track 5");
  });

  test("a label is named only by a person or a name someone gave it", () => {
    expect(speakerIsNamed("speaker_0", speakers)).toBe(true);
    expect(speakerIsNamed("speaker_1", speakers)).toBe(false);
    expect(speakerIsNamed("speaker_2", speakers)).toBe(true);
    expect(speakerIsNamed("speaker_9", speakers)).toBe(false);
    expect(speakerDisplayName("speaker_2", speakers, tracks)).toBe("Pilot customer");
  });

  test("colors follow first appearance and wrap after six", () => {
    const slots = speakerColorSlots([
      segment(0, 0, 1, "b"),
      segment(1, 1, 2, "a"),
      segment(2, 2, 3, "b"),
      ...["c", "d", "e", "f", "g"].map((label, offset) => segment(3 + offset, 3, 4, label)),
    ]);
    expect(slots.get("b")).toBe(1);
    expect(slots.get("a")).toBe(2);
    expect(slots.get("g")).toBe(1);
  });
});

describe("transcript turns", () => {
  test("joins one speaker's consecutive segments and splits on a long pause", () => {
    const turns = groupTranscriptTurns([
      segment(0, 0, 4_000, "a"),
      segment(1, 4_500, 9_000, "a"),
      segment(2, 9_500, 12_000, "b"),
      segment(3, 60_000, 64_000, "b"),
    ]);
    expect(turns.map((turn) => turn.segments.map((entry) => entry.index))).toEqual([
      [0, 1],
      [2],
      [3],
    ]);
    expect(turns[0]!.endMilliseconds).toBe(9_000);
  });

  test("finds the segment playing now", () => {
    const segments = [segment(0, 0, 4_000, "a"), segment(5, 5_000, 9_000, "b")];
    expect(activeSegmentIndex(segments, 4_500)).toBe(0);
    expect(activeSegmentIndex(segments, 7_000)).toBe(5);
    expect(activeSegmentIndex([segment(0, 1_000, 2_000, "a")], 500)).toBe(null);
  });
});

test("error codes from the worker and providers read as plain advice", () => {
  expect(transcriptErrorText("missing_provider_key")).toContain("Organization settings");
  expect(transcriptErrorText("provider_quota_exceeded")).toContain("no credit left");
  expect(transcriptErrorText("something_new")).toContain("Try again");
});
