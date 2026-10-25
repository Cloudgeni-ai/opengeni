import { describe, expect, test } from "bun:test";
import type {
  Recording,
  RecordingSpeaker,
  RecordingTranscriptPage,
  RecordingTranscriptSegment,
  RecordingTranscriptVersion,
} from "@opengeni/contracts";

import { useRecording, useTranscript } from "../src/hooks/use-recordings";
import { WORKSPACE_ID } from "./fake-client";
import { actRun, flush, registerDom, renderHook } from "./render-hook";

registerDom();

const RECORDING_ID = "33333333-3333-4333-8333-333333333333";

function version(overrides: Partial<RecordingTranscriptVersion> = {}): RecordingTranscriptVersion {
  return {
    id: "v1",
    recordingId: RECORDING_ID,
    versionNumber: 1,
    providerId: "elevenlabs",
    model: "scribe_v2",
    options: {},
    state: "complete",
    isCurrent: true,
    languages: ["en"],
    diarized: true,
    diarization: "provider",
    audioMilliseconds: 60_000,
    segmentCount: 3,
    costUsd: 0.01,
    requestedBySubjectId: "subject",
    errorCode: null,
    createdAt: "2026-10-23T10:00:00.000Z",
    completedAt: "2026-10-23T10:01:00.000Z",
    ...overrides,
  };
}

function segment(index: number, speakerLabel: string, text: string): RecordingTranscriptSegment {
  return {
    index,
    startMilliseconds: index * 1_000,
    endMilliseconds: index * 1_000 + 900,
    trackNumber: 0,
    speakerLabel,
    text,
    edited: false,
  };
}

const speakers: RecordingSpeaker[] = [
  { label: "speaker_0", name: "speaker_0", personId: null, source: null, confidence: null },
  { label: "speaker_1", name: "speaker_1", personId: null, source: null, confidence: null },
];

describe("useTranscript", () => {
  test("reads every page and keeps edits until the next read", async () => {
    const segments = [
      segment(0, "speaker_0", "Hi"),
      segment(1, "speaker_1", "Hello"),
      segment(2, "speaker_0", "Bye"),
    ];
    const reads: Array<number | undefined> = [];
    const recordings = {
      getRecordingTranscript: async (
        _workspaceId: string,
        _recordingId: string,
        options: { after?: number } = {},
      ): Promise<RecordingTranscriptPage> => {
        reads.push(options.after);
        // Two pages: indexes 0-1, then 2.
        const from = options.after === undefined ? 0 : options.after + 1;
        const page = segments.slice(from, from + 2);
        const last = page.at(-1)!.index;
        return { version: version(), speakers, segments: page, nextAfter: last < 2 ? last : null };
      },
      updateRecordingSpeakers: async (
        _workspaceId: string,
        _recordingId: string,
        request: { assignments?: Array<{ label: string; name?: string | null }> },
        options: { versionId?: string } = {},
      ) => {
        expect(options.versionId).toBe("v1");
        const named = request.assignments?.[0];
        return {
          speakers: speakers.map((speaker) =>
            speaker.label === named?.label
              ? { ...speaker, name: named.name ?? speaker.label, source: "confirmed" as const }
              : speaker,
          ),
        };
      },
      updateRecordingSegments: async (
        _workspaceId: string,
        _recordingId: string,
        request: { edits: Array<{ segmentIndex: number; text: string | null }> },
      ) => ({
        segments: request.edits.map((edit) => ({
          ...segments[edit.segmentIndex]!,
          text: edit.text ?? segments[edit.segmentIndex]!.text,
          edited: edit.text !== null,
        })),
      }),
    };
    const hook = await renderHook(
      () => useTranscript(RECORDING_ID, { recordings, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(reads).toEqual([undefined, 1]);
    expect(hook.result.current.segments.map((item) => item.text)).toEqual(["Hi", "Hello", "Bye"]);

    await actRun(() => hook.result.current.nameSpeaker("speaker_1", { name: "Ada" }));
    expect(hook.result.current.speakers.find((item) => item.label === "speaker_1")?.name).toBe(
      "Ada",
    );

    await actRun(() => hook.result.current.editSegment(2, "Goodbye"));
    expect(hook.result.current.segments[2]).toMatchObject({ text: "Goodbye", edited: true });
    // The speaker name survives the segment edit.
    expect(hook.result.current.speakers.find((item) => item.label === "speaker_1")?.name).toBe(
      "Ada",
    );
    await hook.unmount();
  });
});

describe("useRecording", () => {
  test("polls while transcription runs and stops once the version is complete", async () => {
    let reads = 0;
    const recording = (
      state: Recording["state"],
      transcript: RecordingTranscriptVersion,
    ): Recording => ({
      id: RECORDING_ID,
      workspaceId: WORKSPACE_ID,
      ownerSubjectId: "subject",
      visibility: "private",
      title: "Weekly sync",
      purpose: "meeting",
      state,
      startedAt: "2026-10-23T10:00:00.000Z",
      captureEndedAt: "2026-10-23T10:30:00.000Z",
      durationMilliseconds: 1_800_000,
      errorCode: null,
      externalRef: null,
      audioDeletedAt: null,
      metadata: {},
      transcription: {},
      tracks: [],
      transcript,
      createdAt: "2026-10-23T10:00:00.000Z",
      updatedAt: "2026-10-23T10:30:00.000Z",
    });
    const recordings = {
      getRecording: async () => {
        reads += 1;
        return reads < 2
          ? recording("processing", version({ state: "processing", completedAt: null }))
          : recording("ready", version());
      },
      listRecordingTranscriptVersions: async () => [
        version({ state: reads < 2 ? "processing" : "complete" }),
      ],
    };
    const hook = await renderHook(
      () => useRecording(RECORDING_ID, { recordings, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.processing).toBe(true);
    await flush(3_200);
    expect(hook.result.current.recording?.state).toBe("ready");
    expect(hook.result.current.processing).toBe(false);
    const settled = reads;
    await flush(3_200);
    expect(reads).toBe(settled);
    await hook.unmount();
  }, 15_000);
});
