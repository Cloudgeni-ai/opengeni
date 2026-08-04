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
  objectKey: "transcription-recordings/account/workspace/recording/chunks/00000000.bin",
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
        throw new Error("provider unavailable");
      },
    });

    expect(await failed.reapExpiredFileUploads()).toEqual({
      claimed: 1,
      deleted: 0,
      failed: 1,
    });
    expect(failedSettlement).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

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
});
