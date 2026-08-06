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

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const sourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../src/transcription-recordings.ts",
);

describe("resumable transcription recording persistence", () => {
  test("migration is rolling, exact-subject FORCE-RLS protected, and reaper claims are fenced", async () => {
    const sql = await readFile(
      join(migrationsDir, "0170_resumable_transcription_recordings.sql"),
      "utf8",
    );
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    for (const table of [
      "transcription_recordings",
      "transcription_recording_objects",
      "transcription_recording_chunks",
      "transcription_recording_segments",
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
    }
    expect(sql.match(/current_setting\('opengeni\.subject_id', true\)/g)).toHaveLength(8);
    expect(sql).toContain("transcription_recordings_exact_authority_uq");
    expect(sql).toContain('"provider_id" text');
    expect(sql).toContain("transcription_recording_objects_authority_fk");
    expect(sql).toContain("transcription_recording_chunks_object_fk");
    expect(sql).toContain("transcription_recording_segments_object_fk");
    expect(sql).toContain("claim_due_transcription_recording_object_cleanup");
    expect(sql).toContain("DO $privileged_functions$");
    expect(sql).toContain("DECLARE data_schema text := current_schema();");
    expect(sql.match(/SET search_path = pg_catalog/g)).toHaveLength(2);
    expect(sql).toContain("FROM %1$I.transcription_recordings R");
    expect(sql).not.toContain("SET search_path = pg_catalog, public");
    expect(sql).toContain("FOR UPDATE OF R SKIP LOCKED");
    expect(sql).toContain("FOR UPDATE OF O SKIP LOCKED");
    expect(sql.match(/greatest\(p_grace_ms, 0\)/g)).toHaveLength(3);
    expect(sql.match(/greatest\(p_claim_timeout_ms, 0\)/g)).toHaveLength(2);
    expect(sql.match(/LIMIT least\(greatest\(p_limit, 0\), 1000\)/g)).toHaveLength(2);
    expect(sql).toContain("LIMIT least(p_limit, 1000)");
    expect(sql.match(/SECURITY DEFINER\n    STRICT\n/g)).toHaveLength(2);
    expect(sql).toContain("cleanup_claim_id = gen_random_uuid()");
    expect(sql).toContain("purge_expired_transcription_recordings");
    expect(sql).toContain("AND O.cleaned_at IS NULL");
    expect(sql).toContain("DELETE FROM %1$I.transcription_recording_segments");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION");
  });

  test("provider deadline migration backfills active attempts and fails closed", async () => {
    const sql = await readFile(
      join(migrationsDir, "0175_resumable_transcription_provider_deadline.sql"),
      "utf8",
    );
    expect(sql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(sql).toContain('ADD COLUMN "attempt_deadline_at" timestamptz');
    expect(sql).toContain("\"attempt_started_at\" + interval '10 minutes'");
    expect(sql).toContain('"attempt_id" IS NULL AND "attempt_started_at" IS NULL');
    expect(sql).toContain('"attempt_id" IS NOT NULL');
    expect(sql).toContain('"attempt_deadline_at" IS NOT NULL');
  });

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
      text: "first\n\nthird",
      languages: ["en", "de", "fr"],
    });
  });
});
