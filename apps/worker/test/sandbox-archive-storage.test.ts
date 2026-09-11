import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { workspaceArchiveObjectKey } from "@opengeni/contracts";
import type { ObjectStorage } from "@opengeni/storage";
import {
  collectWorkspaceArchiveObjectKeys,
  deleteWorkspaceArchiveObjectKeys,
  putTarWorkspaceArchiveObject,
  putVersion1TarArchiveOrInline,
  persistWorkspaceArchiveCandidate,
  WorkspaceArchiveObjectStorageRequiredError,
} from "../src/sandbox-archive-storage";

function fakeStorage() {
  const objects = new Map<string, Uint8Array>();
  const storage = {
    backend: "s3-compatible" as const,
    async putObject(input: { key: string; body: Uint8Array }) {
      objects.set(input.key, input.body);
    },
    async putObjectStream(input: { key: string; chunks: AsyncIterable<Uint8Array> }) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.chunks) chunks.push(chunk);
      objects.set(input.key, Buffer.concat(chunks));
    },
    async headObject(key: string) {
      const bytes = objects.get(key);
      return bytes
        ? {
            ContentLength: bytes.length,
            VersionToken: createHash("sha256").update(bytes).digest("hex"),
          }
        : null;
    },
    async getObjectRange(input: {
      key: string;
      start: number;
      endInclusive: number;
      expectedVersionToken: string;
    }) {
      const bytes = objects.get(input.key);
      if (!bytes) return null;
      const token = createHash("sha256").update(bytes).digest("hex");
      if (token !== input.expectedVersionToken) return null;
      return { bytes: bytes.subarray(input.start, input.endInclusive + 1), versionToken: token };
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
  test("publishes disk-backed archive bytes without materializing inline payloads", async () => {
    const bytes = new TextEncoder().encode("synthetic portable archive");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let uploaded = false;
    const storage = {
      backend: "s3-compatible",
      async headObject() {
        expect(uploaded).toBe(true);
        return { ContentLength: bytes.length, VersionToken: sha256 };
      },
      async getObjectRange(input: { start: number; endInclusive: number }) {
        return { bytes: bytes.subarray(input.start, input.endInclusive + 1), versionToken: sha256 };
      },
      async putObjectStream(input: { chunks: AsyncIterable<Uint8Array> }) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of input.chunks) chunks.push(chunk);
        expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
        uploaded = true;
      },
    } as unknown as ObjectStorage;
    const archive = {
      kind: "host_spool",
      spool: {
        path: "/unused-synthetic-spool",
        byteSize: bytes.length,
        sha256,
        async *open() {
          yield bytes;
        },
        async dispose() {},
      },
      descriptor: {
        version: 1,
        revision: `wa1:1900000000000:${sha256}`,
        archiveSha256: sha256,
        archiveBytes: bytes.length,
        capturedAt: "2030-03-17T17:46:40.000Z",
        workspace: {
          algorithm: "sha256",
          sha256,
          entryCount: 1,
          fileCount: 1,
          totalFileBytes: bytes.length,
        },
      },
      get bytes(): Uint8Array {
        throw new Error("whole archive bytes must not be requested");
      },
      get base64(): string {
        throw new Error("whole archive base64 must not be requested");
      },
    };
    const result = await putVersion1TarArchiveOrInline({
      backend: "local",
      objectStorage: storage,
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sandboxGroupId: "33333333-3333-4333-8333-333333333333",
      archive: archive as Parameters<typeof putVersion1TarArchiveOrInline>[0]["archive"],
    });
    expect(uploaded).toBe(true);
    expect(result.workspaceArchive).toBeUndefined();
    expect(result.workspaceArchiveRef?.sha256).toBe(sha256);
  });
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
      key: expect.stringMatching(/\.[0-9a-f-]{36}\.tar$/),
      sha256,
      bytes: bytes.length,
      backend: "s3-compatible",
    });
    expect(objects.get(ref.key)).toEqual(bytes);
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        putTarWorkspaceArchiveObject({
          objectStorage: storage,
          accountId,
          workspaceId,
          sandboxGroupId,
          archive: { bytes, descriptor },
        }),
      ),
    );
    expect(new Set([ref.key, ...concurrent.map((value) => value.key)]).size).toBe(3);
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

  test("OpenSandbox tar persist fails closed without object storage", async () => {
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
    await expect(
      putVersion1TarArchiveOrInline({
        backend: "opensandbox",
        objectStorage: null,
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sandboxGroupId: "33333333-3333-4333-8333-333333333333",
        archive: { bytes, descriptor, base64: Buffer.from(bytes).toString("base64") },
      }),
    ).rejects.toBeInstanceOf(WorkspaceArchiveObjectStorageRequiredError);
    const inlined = await putVersion1TarArchiveOrInline({
      backend: "docker",
      objectStorage: null,
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sandboxGroupId: "33333333-3333-4333-8333-333333333333",
      archive: { bytes, descriptor, base64: Buffer.from(bytes).toString("base64") },
    });
    expect(inlined.workspaceArchiveRef).toBeUndefined();
    expect(inlined.workspaceArchive?.length).toBeGreaterThan(0);
  });

  test("retains an ambiguously committed candidate and deletes only a definitively unused candidate", async () => {
    const { objects, storage } = fakeStorage();
    const bytes = new TextEncoder().encode("orphan-tar");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const capturedAt = 1_900_000_000_001;
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
    const published = await putVersion1TarArchiveOrInline({
      backend: "opensandbox",
      objectStorage: storage,
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sandboxGroupId: "33333333-3333-4333-8333-333333333333",
      archive: { bytes, descriptor, base64: Buffer.from(bytes).toString("base64") },
    });
    expect(published.workspaceArchive).toBeUndefined();
    expect(objects.has(published.workspaceArchiveRef!.key)).toBe(true);
    let committedKey: string | undefined;
    await expect(
      persistWorkspaceArchiveCandidate({
        objectStorage: storage,
        ref: published.workspaceArchiveRef,
        persist: async () => {
          committedKey = published.workspaceArchiveRef!.key;
          throw new Error("commit succeeded but acknowledgement was lost");
        },
      }),
    ).rejects.toThrow("acknowledgement was lost");
    expect(objects.has(committedKey!)).toBe(true);
    await persistWorkspaceArchiveCandidate({
      objectStorage: storage,
      ref: published.workspaceArchiveRef,
      persist: async () => ({
        wrote: true,
        candidateDisposition: "already_referenced" as const,
      }),
    });
    expect(objects.has(committedKey!)).toBe(true);
    // A separate candidate, not the committed one, is rejected by the database.
    const unused = await putTarWorkspaceArchiveObject({
      objectStorage: storage,
      accountId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      sandboxGroupId: "33333333-3333-4333-8333-333333333333",
      archive: { bytes, descriptor },
    });
    await persistWorkspaceArchiveCandidate({
      objectStorage: storage,
      ref: unused,
      persist: async () => ({ wrote: true, candidateDisposition: "unused" as const }),
    });
    expect(objects.has(unused.key)).toBe(false);
    expect(objects.has(committedKey!)).toBe(true);
  });
});
