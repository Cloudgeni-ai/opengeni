import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import {
  bootstrapWorkspace,
  createDb,
  claimNextTranscriptionRecordingSegment,
  failTranscriptionRecordingSegment,
  completeTranscriptionRecordingSegment,
} from "../src";
import { sql } from "drizzle-orm";
let shared: SharedTestDatabase | null;
let client: ReturnType<typeof createDb>;
let admin: ReturnType<typeof createDb>;
beforeAll(async () => {
  shared = await acquireSharedTestDatabase("transcription-fallback");
  if (shared) {
    client = createDb(shared.appUrl);
    admin = createDb(shared.adminUrl);
  }
}, 180_000);
afterAll(async () => {
  await client?.close();
  await admin?.close();
  await shared?.release();
});
async function fixture() {
  const suffix = crypto.randomUUID(),
    subjectId = `transcription-${suffix}`;
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: suffix,
    accountName: "STT",
    workspaceExternalSource: "test",
    workspaceExternalId: suffix,
    workspaceName: "STT",
    subjectId,
  });
  const grant = access.workspaceGrants[0]!,
    workspaceId = grant.workspaceId!,
    accountId = grant.accountId,
    recordingId = crypto.randomUUID(),
    key = `segment-${recordingId}`;
  await admin.db.execute(
    sql`insert into transcription_recordings(id,account_id,workspace_id,subject_id,mime_type,state,segment_count,expires_at) values(${recordingId},${accountId},${workspaceId},${subjectId},'audio/webm','ready',1,now()+interval '1 day')`,
  );
  await admin.db.execute(
    sql`insert into transcription_recording_objects(account_id,workspace_id,subject_id,recording_id,object_key,kind,cleanup_after) values(${accountId},${workspaceId},${subjectId},${recordingId},${key},'segment',now()+interval '1 day')`,
  );
  await admin.db.execute(
    sql`insert into transcription_recording_segments(account_id,workspace_id,subject_id,recording_id,segment_number,generation,state,byte_length,sha256,start_milliseconds,duration_milliseconds,object_key) values(${accountId},${workspaceId},${subjectId},${recordingId},0,1,'pending',1,${"a".repeat(64)},0,1000,${key})`,
  );
  return { workspaceId, subjectId, recordingId };
}
function claimInput(f: Awaited<ReturnType<typeof fixture>>, providerId: string) {
  return {
    ...f,
    attemptId: crypto.randomUUID(),
    providerId,
    staleBefore: new Date(Date.now() - 900_000),
    providerDeadlineAt: new Date(Date.now() + 600_000),
  };
}
test("safe auth rejections advance the same recording; stale failures cannot repin it", async () => {
  if (!shared) return;
  const f = await fixture(),
    first = claimInput(f, "openai");
  expect((await claimNextTranscriptionRecordingSegment(client.db, first)).fallbackAllowed).toBe(
    true,
  );
  await failTranscriptionRecordingSegment(client.db, {
    ...first,
    segmentNumber: 0,
    errorCode: "unavailable",
    retryable: true,
    fallbackProviderId: "azure-openai",
  });
  const second = claimInput(f, "openai"),
    claimed = await claimNextTranscriptionRecordingSegment(client.db, second);
  expect(claimed.segment?.providerId).toBe("azure-openai");
  expect(claimed.fallbackAllowed).toBe(true);
  await expect(
    failTranscriptionRecordingSegment(client.db, {
      ...first,
      segmentNumber: 0,
      errorCode: "unavailable",
      retryable: true,
      fallbackProviderId: "codex-subscription",
    }),
  ).rejects.toThrow("stale");
  await failTranscriptionRecordingSegment(client.db, {
    ...second,
    segmentNumber: 0,
    errorCode: "unavailable",
    retryable: true,
    fallbackProviderId: "codex-subscription",
  });
  const third = claimInput(f, "openai"),
    last = await claimNextTranscriptionRecordingSegment(client.db, third);
  expect(last.segment?.providerId).toBe("codex-subscription");
  expect(last.fallbackAllowed).toBe(true);
  const done = await completeTranscriptionRecordingSegment(client.db, {
    ...third,
    segmentNumber: 0,
    providerId: "codex-subscription",
    text: "recovered",
    languages: [],
  });
  expect(done.recording.state).toBe("complete");
});
test("timeout permanently disables cross-provider fallback eligibility", async () => {
  if (!shared) return;
  const f = await fixture(),
    first = claimInput(f, "openai");
  await claimNextTranscriptionRecordingSegment(client.db, first);
  await failTranscriptionRecordingSegment(client.db, {
    ...first,
    segmentNumber: 0,
    errorCode: "timeout",
    retryable: true,
  });
  const second = claimInput(f, "azure-openai"),
    retry = await claimNextTranscriptionRecordingSegment(client.db, second);
  expect(retry.fallbackAllowed).toBe(false);
  expect(retry.segment?.providerId).toBe("openai");
  await failTranscriptionRecordingSegment(client.db, {
    ...second,
    segmentNumber: 0,
    errorCode: "unavailable",
    retryable: true,
  });
  expect(
    (await claimNextTranscriptionRecordingSegment(client.db, claimInput(f, "azure-openai")))
      .fallbackAllowed,
  ).toBe(false);
});
