import { describe, expect, mock, test } from "bun:test";
import type { TranscriptionRecordingObjectCleanupClaim } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { createFileUploadReaperActivities } from "../src/activities/file-upload-reaper";
import type { ActivityServices } from "../src/activities/types";

const claim: TranscriptionRecordingObjectCleanupClaim = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  subjectId: "user:reaper-test",
  recordingId: "33333333-3333-4333-8333-333333333333",
  objectKey: `transcription-recordings/account/workspace/recording/chunks/00000000-${"a".repeat(64)}.bin`,
  cleanupClaimId: "44444444-4444-4444-8444-444444444444",
};

function services(warn: ReturnType<typeof mock>): () => Promise<ActivityServices> {
  return async () =>
    ({
      db: {} as never,
      objectStorage: {} as ObjectStorage,
      observability: { info: mock(() => undefined), warn } as never,
    }) as ActivityServices;
}

describe("transcription recording object reaper", () => {
  test("leaves a failed delete reclaimable and settles a later successful retry", async () => {
    const warn = mock(() => undefined);
    const failedSettlement = mock(async () => true);
    const failed = createFileUploadReaperActivities(services(warn), {
      graceMs: 0,
      claimTimeoutMs: 0,
      batchSize: 10,
      claimFileUploads: async () => [],
      completeFileUpload: async () => true,
      claimTranscriptionObjects: async () => [claim],
      completeTranscriptionObject: failedSettlement,
      purgeTranscriptionRecordings: async () => 0,
      deleteObject: async () => {
        throw Object.assign(new Error("provider body contains private objectKey and token"), {
          code: "provider",
          status: 503,
        });
      },
    });

    expect(await failed.reapExpiredFileUploads()).toEqual({
      claimed: 1,
      deleted: 0,
      failed: 1,
    });
    expect(failedSettlement).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const warningAttributes = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(warningAttributes).toMatchObject({
      workspaceId: claim.workspaceId,
      recordingId: claim.recordingId,
      errorCategory: "provider",
      errorStatus: 503,
    });
    expect(warningAttributes).not.toHaveProperty("objectKey");
    expect(JSON.stringify(warningAttributes)).not.toContain(claim.objectKey);
    expect(JSON.stringify(warningAttributes)).not.toContain("provider body contains private");

    const deleteObject = mock(async () => undefined);
    const completeTranscriptionObject = mock(async () => true);
    const purgeTranscriptionRecordings = mock(async () => 1);
    const retried = createFileUploadReaperActivities(services(mock(() => undefined)), {
      graceMs: 0,
      claimTimeoutMs: 0,
      batchSize: 10,
      claimFileUploads: async () => [],
      completeFileUpload: async () => true,
      claimTranscriptionObjects: async () => [claim],
      completeTranscriptionObject,
      purgeTranscriptionRecordings,
      deleteObject,
    });

    expect(await retried.reapExpiredFileUploads()).toEqual({
      claimed: 1,
      deleted: 1,
      failed: 0,
    });
    expect(deleteObject).toHaveBeenCalledWith(expect.anything(), claim.objectKey);
    expect(completeTranscriptionObject).toHaveBeenCalledWith(expect.anything(), claim);
    expect(purgeTranscriptionRecordings).toHaveBeenCalledWith(expect.anything(), {
      graceMs: 0,
      limit: 10,
    });
  });

  test("maps private provider codes to an allowlisted category", async () => {
    const warn = mock(() => undefined);
    const fileUpload = {
      uploadId: "55555555-5555-4555-8555-555555555555",
      accountId: claim.accountId,
      workspaceId: claim.workspaceId,
      fileId: "66666666-6666-4666-8666-666666666666",
      objectKey: "private-upload-key",
    };
    const reaper = createFileUploadReaperActivities(services(warn), {
      graceMs: 0,
      claimTimeoutMs: 0,
      batchSize: 10,
      claimFileUploads: async () => [fileUpload],
      completeFileUpload: async () => true,
      claimTranscriptionObjects: async () => [],
      completeTranscriptionObject: async () => true,
      purgeTranscriptionRecordings: async () => 0,
      deleteObject: async () => {
        throw Object.assign(new Error("private provider details"), {
          code: "transcription-recordings/account/workspace/secret",
          status: 700,
        });
      },
    });

    expect(await reaper.reapExpiredFileUploads()).toEqual({
      claimed: 1,
      deleted: 0,
      failed: 1,
    });
    const warningAttributes = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(warningAttributes).toMatchObject({
      workspaceId: fileUpload.workspaceId,
      uploadId: fileUpload.uploadId,
      fileId: fileUpload.fileId,
      errorCategory: "unknown",
    });
    expect(warningAttributes).not.toHaveProperty("errorStatus");
    expect(JSON.stringify(warningAttributes)).not.toContain(fileUpload.objectKey);
    expect(JSON.stringify(warningAttributes)).not.toContain("private provider details");
    expect(JSON.stringify(warningAttributes)).not.toContain("transcription-recordings/account");
  });
});
