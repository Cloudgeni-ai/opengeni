import { describe, expect, test } from "bun:test";
import * as snapshots from "../src/sandbox-snapshots";
import {
  omitInlineWorkspaceArchiveWhenObjectRefPresent,
  parseWorkspaceArchiveObjectRef,
  workspaceArchiveObjectKey,
} from "../src/sandbox-snapshots";

const ref = {
  schema: "sandbox_archive_object_v1" as const,
  key: workspaceArchiveObjectKey({
    accountId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    sandboxGroupId: "33333333-3333-4333-8333-333333333333",
    revision: "wa1:1900000000000:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }),
  sha256: "a".repeat(64),
  bytes: 12,
  backend: "s3-compatible",
};

const scope = {
  accountId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sandboxGroupId: "33333333-3333-4333-8333-333333333333",
};
const descriptor = {
  version: 1 as const,
  revision: `wa1:1900000000000:${"a".repeat(64)}`,
  archiveSha256: ref.sha256,
  archiveBytes: ref.bytes,
  capturedAt: new Date(1900000000000).toISOString(),
  workspace: {
    algorithm: "sha256" as const,
    sha256: ref.sha256,
    entryCount: 1,
    fileCount: 1,
    totalFileBytes: 12,
  },
};
const uploadId = "44444444-4444-4444-8444-444444444444";

describe("workspace archive physical locator", () => {
  test("keeps the legacy key and separates fresh upload identity from logical revision", () => {
    const input = { ...scope, revision: descriptor.revision };
    expect(workspaceArchiveObjectKey(input)).toBe(ref.key);
    expect(workspaceArchiveObjectKey({ ...input, uploadId })).toBe(
      ref.key.replace(/\.tar$/, `.${uploadId}.tar`),
    );
    for (const id of [undefined, uploadId]) {
      const key = workspaceArchiveObjectKey({ ...input, ...(id ? { uploadId: id } : {}) });
      expect(snapshots.parseWorkspaceArchiveObjectKey(key)).toEqual({
        ...input,
        uploadId: id ?? null,
      });
      expect(parseWorkspaceArchiveObjectRef({ ...ref, key })).toEqual({ ...ref, key });
    }
  });

  test("rejects malformed UUID suffixes and path extensions", () => {
    for (const suffix of [
      "garbage",
      "../other",
      "44444444444444448444444444444444",
      "44444444-4444-0444-8444-444444444444",
      "44444444-4444-4444-7444-444444444444",
      `${uploadId}.extra`,
    ]) {
      const key = ref.key.replace(/\.tar$/, `.${suffix}.tar`);
      expect(parseWorkspaceArchiveObjectRef({ ...ref, key })).toBeNull();
      expect(() =>
        workspaceArchiveObjectKey({ ...scope, revision: descriptor.revision, uploadId: suffix }),
      ).toThrow();
    }
    expect(snapshots.parseWorkspaceArchiveObjectKey(`${ref.key}/child`)).toBeNull();
    expect(snapshots.parseWorkspaceArchiveObjectKey(`${ref.key}\n`)).toBeNull();
  });

  test("binds legacy and unique refs to scope, revision, descriptor hash and size", () => {
    for (const id of [undefined, uploadId]) {
      const candidate = {
        ...ref,
        key: workspaceArchiveObjectKey({
          ...scope,
          revision: descriptor.revision,
          ...(id ? { uploadId: id } : {}),
        }),
      };
      expect(
        snapshots.validateWorkspaceArchiveObjectRef(candidate, { ...scope, descriptor }),
      ).toEqual(candidate);
      for (const field of ["accountId", "workspaceId", "sandboxGroupId"] as const) {
        expect(
          snapshots.validateWorkspaceArchiveObjectRef(candidate, {
            ...scope,
            [field]: uploadId,
            descriptor,
          }),
        ).toBeNull();
      }
      expect(
        snapshots.validateWorkspaceArchiveObjectRef(
          { ...candidate, sha256: "b".repeat(64) },
          { ...scope, descriptor },
        ),
      ).toBeNull();
      expect(
        snapshots.validateWorkspaceArchiveObjectRef(
          { ...candidate, bytes: 13 },
          { ...scope, descriptor },
        ),
      ).toBeNull();
      const otherCapture = {
        ...descriptor,
        revision: descriptor.revision.replace("1900000000000", "1900000000001"),
        capturedAt: new Date(1900000000001).toISOString(),
      };
      expect(
        snapshots.validateWorkspaceArchiveObjectRef(candidate, {
          ...scope,
          descriptor: otherCapture,
        }),
      ).toBeNull();
      expect(
        snapshots.validateWorkspaceArchiveObjectRef(candidate, {
          ...scope,
          descriptor: { ...descriptor, archiveBytes: 0 },
        }),
      ).toBeNull();
    }
  });
});

describe("omitInlineWorkspaceArchiveWhenObjectRefPresent", () => {
  test("strips hydrate inlines beside a durable object ref", () => {
    const previousRef = {
      ...ref,
      key: workspaceArchiveObjectKey({
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "22222222-2222-4222-8222-222222222222",
        sandboxGroupId: "33333333-3333-4333-8333-333333333333",
        revision:
          "wa1:1900000000001:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    };
    const durable = omitInlineWorkspaceArchiveWhenObjectRefPresent({
      workspaceArchive: "aW5saW5lLWh5ZHJhdGU=",
      workspaceArchiveRef: ref,
      workspaceArchivePrev: "cHJldmlvdXMtaW5saW5l",
      workspaceArchivePrevRef: previousRef,
      workspaceArchiveMeta: { revision: "wa1:current" },
    });
    expect(durable.workspaceArchive).toBeUndefined();
    expect(durable.workspaceArchivePrev).toBeUndefined();
    expect(parseWorkspaceArchiveObjectRef(durable.workspaceArchiveRef)).toEqual(ref);
    expect(durable.workspaceArchiveMeta).toEqual({ revision: "wa1:current" });
  });

  test("keeps inline bytes when no object ref is present", () => {
    const durable = omitInlineWorkspaceArchiveWhenObjectRefPresent({
      workspaceArchive: "aW5saW5l",
      workspaceArchiveMeta: { revision: "wa1:inline" },
    });
    expect(durable.workspaceArchive).toBe("aW5saW5l");
  });
});
