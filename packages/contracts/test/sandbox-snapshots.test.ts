import { describe, expect, test } from "bun:test";
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
