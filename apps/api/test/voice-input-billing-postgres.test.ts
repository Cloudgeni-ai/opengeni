import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireSharedTestDatabase,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  completeTranscriptionRecordingSegment,
  getTranscriptionRecording,
  withWorkspaceSubjectRls,
  setWorkspaceAllowance,
  getWorkspaceUsage,
  ensureManagedAccessForUser,
  applyCreditLedgerEntry,
  getBillingBalance,
  listUsageEvents,
  type DbClient,
} from "@opengeni/db";
import { createVoiceInputBilling } from "@opengeni/core";
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("voice-input-billing");
  if (!shared) throw Error("PostgreSQL required for credit settlement tests");
  client = createDb(shared.appUrl, { max: 8 });
}, 180000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180000);

test("one segment replay settles once; unfunded admission refuses under application-role RLS", async () => {
  const id = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId: id,
    email: `${id}@example.test`,
    name: "Voice fixture",
  });
  const grant = access.workspaceGrants[0]!;
  const accountId = grant.accountId,
    workspaceId = grant.workspaceId!;
  await setWorkspaceAllowance(client!.db, {
    accountId,
    workspaceId,
    actorSubjectId: grant.subjectId,
    expectedVersion: 0,
    includedCredits: 10000,
    period: "monthly",
    memberDefault: { credits: 500 },
  });
  const attribution = { kind: "human" as const, initiatingHumanSubjectId: grant.subjectId };
  const billing = createVoiceInputBilling({
    db: client!.db,
    settings: testSettings({ billingMode: "stripe" }),
  });
  await expect(billing.admit({ accountId, workspaceId, attribution })).rejects.toMatchObject({
    code: "insufficient_credits",
  });
  await applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros: 10000,
    type: "grant",
    idempotencyKey: crypto.randomUUID(),
  });
  await billing.admit({ accountId, workspaceId, attribution });
  const input = {
    accountId,
    workspaceId,
    providerId: "azure-mai",
    model: "MAI-Transcribe-2",
    pricing: { microsPerMinute: 6000, marginBps: 500 },
    usage: { kind: "duration" as const, seconds: 5 },
    billing: {
      idempotencyKey: `segment:${id}:0`,
      sourceType: "voice_transcription",
      sourceId: `${id}:0`,
      attribution,
    },
  };
  const results = await Promise.all([billing.settle(input), billing.settle(input)]);
  expect(results).toEqual([{ creditCostMicros: 525 }, { creditCostMicros: 525 }]);
  expect((await getBillingBalance(client!.db, accountId)).balanceMicros).toBe(9475);
  const usage = await listUsageEvents(client!.db, { accountId, workspaceId, limit: 100 });
  expect(usage.filter((row) => row.eventType === "model.cost")).toHaveLength(1);
  const memberUsage = await getWorkspaceUsage(client!.db, {
    accountId,
    workspaceId,
    subjectId: grant.subjectId,
  });
  expect(memberUsage.members.find((member) => member.subjectId === grant.subjectId)?.used).toBe(
    525,
  );
  await expect(billing.admit({ accountId, workspaceId, attribution })).rejects.toMatchObject({
    code: "allowance_exhausted",
  });
  expect(usage.find((row) => row.eventType === "model.cost")?.quantity).toBe(525);
}, 30000);

test("transcript and debit roll back together, then commit once", async () => {
  const id = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId: id,
    email: `${id}@example.test`,
    name: "Atomic voice fixture",
  });
  const { accountId, workspaceId, subjectId } = access.workspaceGrants[0]!;
  if (!workspaceId) throw Error("fixture workspace missing");
  const recordingId = crypto.randomUUID(),
    attemptId = crypto.randomUUID();
  const objectKey = `voice-fixture/${recordingId}/segment`;
  await applyCreditLedgerEntry(client!.db, {
    accountId,
    amountMicros: 10000,
    type: "grant",
    idempotencyKey: id,
  });
  await withWorkspaceSubjectRls(client!.db, workspaceId, subjectId, async (tx) => {
    await tx.execute(
      sql`INSERT INTO transcription_recordings (id, account_id, workspace_id, subject_id, mime_type, state, segment_count, processing_owner, processing_started_at, expires_at) VALUES (${recordingId}, ${accountId}, ${workspaceId}, ${subjectId}, 'audio/wav', 'transcribing', 1, ${attemptId}, now(), now() + interval '1 hour')`,
    );
    await tx.execute(
      sql`INSERT INTO transcription_recording_objects (account_id, workspace_id, subject_id, recording_id, object_key, kind, cleanup_after) VALUES (${accountId}, ${workspaceId}, ${subjectId}, ${recordingId}, ${objectKey}, 'segment', now() + interval '1 hour')`,
    );
    await tx.execute(
      sql`INSERT INTO transcription_recording_segments (account_id, workspace_id, subject_id, recording_id, segment_number, generation, state, byte_length, sha256, start_milliseconds, duration_milliseconds, object_key, attempt_id, attempt_started_at, attempt_deadline_at) VALUES (${accountId}, ${workspaceId}, ${subjectId}, ${recordingId}, 0, 1, 'transcribing', 160044, ${"a".repeat(64)}, 0, 5000, ${objectKey}, ${attemptId}, now(), now() + interval '1 minute')`,
    );
  });
  const billing = createVoiceInputBilling({
    db: client!.db,
    settings: testSettings({ billingMode: "stripe" }),
  });
  const settlement = {
    accountId,
    workspaceId,
    providerId: "azure-mai",
    model: "MAI-Transcribe-2",
    pricing: { microsPerMinute: 6000, marginBps: 500 },
    usage: { kind: "duration" as const, seconds: 5 },
    billing: {
      idempotencyKey: `segment:${recordingId}:0`,
      sourceType: "voice_transcription",
      sourceId: `${recordingId}:0`,
      attribution: { kind: "human" as const, initiatingHumanSubjectId: subjectId },
    },
  };
  const completion = {
    workspaceId,
    subjectId,
    recordingId,
    segmentNumber: 0,
    attemptId,
    text: "Hello",
    languages: ["en"],
    providerId: "azure-mai",
  };
  await expect(
    completeTranscriptionRecordingSegment(client!.db, completion, async (tx) => {
      await billing.settle(settlement, tx);
      throw Error("synthetic rollback");
    }),
  ).rejects.toThrow("synthetic rollback");
  expect((await getBillingBalance(client!.db, accountId)).balanceMicros).toBe(10000);
  expect(
    (await getTranscriptionRecording(client!.db, { workspaceId, subjectId, recordingId })).recording
      .state,
  ).toBe("transcribing");
  const result = await completeTranscriptionRecordingSegment(client!.db, completion, async (tx) => {
    await billing.settle(settlement, tx);
  });
  expect(result.recording.state).toBe("complete");
  expect(result.recording.transcriptText).toBe("Hello");
  expect((await getBillingBalance(client!.db, accountId)).balanceMicros).toBe(9475);
  await expect(
    completeTranscriptionRecordingSegment(client!.db, completion, async (tx) => {
      await billing.settle(settlement, tx);
    }),
  ).rejects.toThrow("stale");
  expect((await getBillingBalance(client!.db, accountId)).balanceMicros).toBe(9475);
}, 30000);
