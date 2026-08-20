import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { workspaceArchiveObjectKey } from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";
import {
  collectWorkspaceArchiveObjectKeys,
  deleteWorkspaceArchiveObjectKeys,
  putTarWorkspaceArchiveObject,
} from "../src/sandbox-archive-storage";

function fakeStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    backend: "s3-compatible" as const,
    async putObject(input: { key: string; body: Uint8Array }) {
      objects.set(input.key, input.body);
    },
    async getObjectBytes(key: string) {
      const bytes = objects.get(key);
      return bytes ? { bytes } : null;
    },
    async deleteObject(key: string) {
      objects.delete(key);
    },
  };
  return { objects, storage: storage as unknown as ObjectStorage };
}

describe("workspace archive object storage", () => {
  test("writes a tar object, collects current/prev keys, and deletes displaced keys", async () => {
    const { objects, storage } = fakeStorage();
    const accountId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const sandboxGroupId = "33333333-3333-4333-8333-333333333333";
    const bytes = new TextEncoder().encode("portable-tar");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const capturedAt = 1_900_000_000_000;
    const descriptor = {
      version: 1 as const,
      revision: `wa1:${capturedAt}:${sha256}`,
      archiveSha256: sha256,
      archiveBytes: bytes.length,
      capturedAt: new Date(capturedAt).toISOString(),
      workspace: {
        algorithm: "sha256" as const,
        sha256,
        entryCount: 1,
        fileCount: 1,
        totalFileBytes: bytes.length,
      },
    };
    const ref = await putTarWorkspaceArchiveObject({
      objectStorage: storage,
      accountId,
      workspaceId,
      sandboxGroupId,
      archive: { bytes, descriptor },
    });
    expect(ref).toEqual({
      schema: "sandbox_archive_object_v1",
      key: workspaceArchiveObjectKey({
        accountId,
        workspaceId,
        sandboxGroupId,
        revision: descriptor.revision,
      }),
      sha256,
      bytes: bytes.length,
      backend: "s3-compatible",
    });
    expect(objects.get(ref.key)).toEqual(bytes);

    const keys = collectWorkspaceArchiveObjectKeys({
      sessionState: {
        workspaceArchiveRef: ref,
        workspaceArchivePrevRef: {
          ...ref,
          key: workspaceArchiveObjectKey({
            accountId,
            workspaceId,
            sandboxGroupId,
            revision: `wa1:${capturedAt + 1}:${sha256}`,
          }),
        },
      },
    });
    expect(keys.size).toBe(2);
    await deleteWorkspaceArchiveObjectKeys(storage, [ref.key]);
    expect(objects.has(ref.key)).toBe(false);
  });
});
