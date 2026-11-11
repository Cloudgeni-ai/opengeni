import { describe, expect, mock, test } from "bun:test";
import type { ExpiredFileUploadCleanupClaim } from "@opengeni/db";
import type { ObjectStorage } from "@opengeni/storage";
import { createFileUploadReaperActivities } from "../src/activities/file-upload-reaper";
import type { ActivityServices } from "../src/activities/types";

const claim: ExpiredFileUploadCleanupClaim = {
  uploadId: "55555555-5555-4555-8555-555555555555",
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  fileId: "66666666-6666-4666-8666-666666666666",
  objectKey: "private-upload-key",
};

function services(warn: ReturnType<typeof mock>): () => Promise<ActivityServices> {
  return async () =>
    ({
      db: {} as never,
      objectStorage: {} as ObjectStorage,
      observability: { info: mock(() => undefined), warn } as never,
    }) as ActivityServices;
}

describe("expired file upload reaper", () => {
  test("leaves a failed delete reclaimable and settles a later successful retry", async () => {
    const warn = mock(() => undefined);
    const failedSettlement = mock(async () => true);
    const failed = createFileUploadReaperActivities(services(warn), {
      graceMs: 0,
      claimTimeoutMs: 0,
      batchSize: 10,
      claimFileUploads: async () => [claim],
      completeFileUpload: failedSettlement,
      deleteObject: async () => {
        throw Object.assign(new Error("provider body contains private objectKey and token"), {
          code: "provider",
          status: 503,
        });
      },
    });

    expect(await failed.reapExpiredFileUploads()).toEqual({ claimed: 1, deleted: 0, failed: 1 });
    expect(failedSettlement).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const warningAttributes = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(warningAttributes).toMatchObject({
      workspaceId: claim.workspaceId,
      uploadId: claim.uploadId,
      fileId: claim.fileId,
      errorCategory: "provider",
      errorStatus: 503,
    });
    expect(warningAttributes).not.toHaveProperty("objectKey");
    expect(JSON.stringify(warningAttributes)).not.toContain(claim.objectKey);
    expect(JSON.stringify(warningAttributes)).not.toContain("provider body contains private");

    const deleteObject = mock(async () => undefined);
    const completeFileUpload = mock(async () => true);
    const retried = createFileUploadReaperActivities(services(mock(() => undefined)), {
      graceMs: 0,
      claimTimeoutMs: 0,
      batchSize: 10,
      claimFileUploads: async () => [claim],
      completeFileUpload,
      deleteObject,
    });

    expect(await retried.reapExpiredFileUploads()).toEqual({ claimed: 1, deleted: 1, failed: 0 });
    expect(deleteObject).toHaveBeenCalledWith(expect.anything(), claim.objectKey);
    expect(completeFileUpload).toHaveBeenCalledWith(expect.anything(), claim);
  });

  test("maps private provider codes to an allowlisted category", async () => {
    const warn = mock(() => undefined);
    const reaper = createFileUploadReaperActivities(services(warn), {
      graceMs: 0,
      claimTimeoutMs: 0,
      batchSize: 10,
      claimFileUploads: async () => [claim],
      completeFileUpload: async () => true,
      deleteObject: async () => {
        throw Object.assign(new Error("private provider details"), {
          code: "uploads/account/workspace/secret",
          status: 700,
        });
      },
    });

    expect(await reaper.reapExpiredFileUploads()).toEqual({ claimed: 1, deleted: 0, failed: 1 });
    const warningAttributes = warn.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(warningAttributes).toMatchObject({
      workspaceId: claim.workspaceId,
      uploadId: claim.uploadId,
      fileId: claim.fileId,
      errorCategory: "unknown",
    });
    expect(warningAttributes).not.toHaveProperty("errorStatus");
    expect(JSON.stringify(warningAttributes)).not.toContain(claim.objectKey);
    expect(JSON.stringify(warningAttributes)).not.toContain("private provider details");
    expect(JSON.stringify(warningAttributes)).not.toContain("uploads/account");
  });
});

describe("transient object deletion", () => {
  test("deletes only keys inside the named workspace and tolerates objects already gone", async () => {
    const deleted: string[] = [];
    const reaper = createFileUploadReaperActivities(services(mock(() => undefined)), {
      deleteObject: async (_storage, key) => {
        deleted.push(key);
      },
    });
    const workspaceId = claim.workspaceId;
    const result = await reaper.deleteTransientObjects({
      workspaceId,
      objectKeys: [
        `workspaces/${workspaceId}/browser-recordings/r/bundle`,
        "workspaces/another/browser-recordings/r/bundle",
        `workspaces/${workspaceId}/browser-recordings/r/op/video.mp4`,
      ],
    });
    expect(result).toEqual({ deleted: 2 });
    expect(deleted).toEqual([
      `workspaces/${workspaceId}/browser-recordings/r/bundle`,
      `workspaces/${workspaceId}/browser-recordings/r/op/video.mp4`,
    ]);
  });
});
