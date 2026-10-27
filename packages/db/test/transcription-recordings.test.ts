import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assembleTranscriptionSegments,
  canReclaimTranscriptionRecordingAttempt,
  FORCE_RLS_TABLES,
  RUNTIME_FULL_DML_TABLES,
  transcriptionRecordingChunkObjectKey,
  transcriptionRecordingSegmentObjectKey,
} from "../src";

const sourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/transcription-recordings.ts",
);

describe("resumable transcription recording persistence", () => {
  test("pins one private provider for every segment and retry in a recording", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain(
      "const providerId = recording.providerId ?? candidate.providerId ?? input.providerId",
    );
    expect(source).toContain("Recording provider pin is inconsistent");
    const recordingUpdate = source.match(
      /const \[updatedRecording\] = await scopedDb\s*\.update\(schema\.transcriptionRecordings\)\s*\.set\(\{([\s\S]*?)\}\)/,
    );
    expect(recordingUpdate?.[1]).toContain("providerId,");
    expect(recordingUpdate?.[1]).toContain("errorCode: null");
  });

  test("reclaims stale segment attempts under a row lock and fences late completions", async () => {
    const source = await readFile(sourcePath, "utf8");
    expect(source).toContain('eq(schema.transcriptionRecordingSegments.state, "transcribing")');
    expect(source).toContain('.limit(1)\n      .for("update")');
    expect(source).toContain("!canReclaimTranscriptionRecordingAttempt({");
    expect(source).toContain("attemptDeadlineAt: active.attemptDeadlineAt");
    expect(source).toContain("attemptDeadlineAt: input.providerDeadlineAt");
    expect(source).toContain("attemptStartedAt: input.providerStartedAt");
    expect(source).toContain("processingStartedAt: input.providerStartedAt");
    expect(source).toContain("attemptDeadlineAt: null");
    expect(source).toContain("startTranscriptionRecordingSegmentProviderCall");
    expect(source).toContain('state: "failed"');
    expect(source).toContain("attemptId: null");
    expect(source).toContain(
      "eq(schema.transcriptionRecordingSegments.attemptId, active.attemptId!)",
    );
    expect(source).toContain(
      "eq(schema.transcriptionRecordingSegments.attemptId, input.attemptId)",
    );
    expect(source).toContain("eq(schema.transcriptionRecordings.processingOwner, input.attemptId)");
  });

  test("requires both the durable lease and provider deadline to reclaim", () => {
    const providerStartedAt = new Date("2026-08-05T00:06:00.000Z");
    const providerDeadlineAt = new Date("2026-08-05T00:16:00.000Z");
    expect(
      canReclaimTranscriptionRecordingAttempt({
        attemptStartedAt: providerStartedAt,
        attemptDeadlineAt: providerDeadlineAt,
        staleBefore: new Date("2026-08-05T00:05:59.999Z"),
        now: new Date("2026-08-05T00:16:00.000Z"),
      }),
    ).toBe(false);
    expect(
      canReclaimTranscriptionRecordingAttempt({
        attemptStartedAt: providerStartedAt,
        attemptDeadlineAt: providerDeadlineAt,
        staleBefore: new Date("2026-08-05T00:06:00.001Z"),
        now: new Date("2026-08-05T00:21:00.000Z"),
      }),
    ).toBe(true);
    expect(
      canReclaimTranscriptionRecordingAttempt({
        attemptStartedAt: providerStartedAt,
        attemptDeadlineAt: null,
        staleBefore: new Date("2026-08-05T00:21:00.000Z"),
        now: new Date("2026-08-05T00:21:01.000Z"),
      }),
    ).toBe(false);
  });

  test("keeps the five-minute reclaim margin after delayed provider-start refresh and commit", () => {
    const providerStartedAt = new Date("2026-08-05T00:00:00.000Z");
    const providerDeadlineAt = new Date(providerStartedAt.getTime() + 10 * 60_000);
    for (const refreshDelayMinutes of [0, 4, 5, 6]) {
      const refreshReturnedAt = new Date(
        providerStartedAt.getTime() + refreshDelayMinutes * 60_000,
      );
      expect(providerDeadlineAt.getTime() - refreshReturnedAt.getTime()).toBe(
        (10 - refreshDelayMinutes) * 60_000,
      );
    }
    expect(
      canReclaimTranscriptionRecordingAttempt({
        attemptStartedAt: providerStartedAt,
        attemptDeadlineAt: providerDeadlineAt,
        staleBefore: providerStartedAt,
        now: new Date(providerDeadlineAt.getTime() + 5 * 60_000),
      }),
    ).toBe(false);
    expect(
      canReclaimTranscriptionRecordingAttempt({
        attemptStartedAt: providerStartedAt,
        attemptDeadlineAt: providerDeadlineAt,
        staleBefore: new Date(providerStartedAt.getTime() + 1),
        now: new Date(providerDeadlineAt.getTime() + 5 * 60_000 + 1),
      }),
    ).toBe(true);
  });

  test("declares every transcription table in the runtime posture contract", () => {
    for (const table of [
      "transcription_recordings",
      "transcription_recording_objects",
      "transcription_recording_chunks",
      "transcription_recording_segments",
    ] as const) {
      expect(FORCE_RLS_TABLES).toContain(table);
      expect(RUNTIME_FULL_DML_TABLES).toContain(table);
    }
  });

  test("derives tenant-scoped immutable object keys", () => {
    expect(
      transcriptionRecordingChunkObjectKey({
        accountId: "account",
        workspaceId: "workspace",
        recordingId: "recording",
        chunkNumber: 7,
        sha256: "a".repeat(64),
      }),
    ).toBe(
      `transcription-recordings/account/workspace/recording/chunks/00000007-${"a".repeat(64)}.bin`,
    );
    expect(
      transcriptionRecordingSegmentObjectKey({
        accountId: "account",
        workspaceId: "workspace",
        recordingId: "recording",
        generation: 3,
        segmentNumber: 12,
        sha256: "b".repeat(64),
      }),
    ).toBe(
      `transcription-recordings/account/workspace/recording/segments/00000003/00000012-${"b".repeat(64)}.wav`,
    );
  });

  test("assembles segment text and languages in deterministic segment order", () => {
    expect(
      assembleTranscriptionSegments([
        { segmentNumber: 2, transcriptText: " third ", languages: ["fr", "en"] },
        { segmentNumber: 0, transcriptText: " first ", languages: ["en", ""] },
        { segmentNumber: 1, transcriptText: "  ", languages: ["de", "fr"] },
      ]),
    ).toEqual({
      text: "first third",
      languages: ["en", "de", "fr"],
    });
  });
});
