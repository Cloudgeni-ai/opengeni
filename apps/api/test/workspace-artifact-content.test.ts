import { describe, expect, test } from "bun:test";
import type { ObjectStorageDependency } from "@opengeni/core";
import { prepareWorkspaceArtifactContent } from "../src/workspace-artifact-content";

describe("workspace artifact content persistence", () => {
  test("removes the successful sibling when exactly one object write fails", async () => {
    const deleted: string[] = [];
    const storage = {
      putObject: async (input: { contentType: string }) => {
        if (input.contentType.startsWith("application/json")) {
          throw new Error("source upload failed");
        }
      },
      deleteObject: async (key: string) => {
        deleted.push(key);
      },
    } as unknown as NonNullable<ObjectStorageDependency>;
    const prepared = prepareWorkspaceArtifactContent(
      storage,
      "11111111-1111-4111-8111-111111111111",
      { html: "<!doctype html><h1>Site</h1>" },
    );

    await expect(prepared.persistContent()).rejects.toThrow("source upload failed");
    expect(deleted).toEqual([prepared.contentKey]);
    expect(prepared.contentKey).not.toBe(prepared.sourceKey);
  });

  test("uses a unique storage group so partial cleanup cannot delete another version", () => {
    const storage = {
      putObject: async () => undefined,
      deleteObject: async () => undefined,
    } as unknown as NonNullable<ObjectStorageDependency>;
    const first = prepareWorkspaceArtifactContent(storage, "workspace-one", {
      html: "<!doctype html><h1>Same Site</h1>",
    });
    const second = prepareWorkspaceArtifactContent(storage, "workspace-one", {
      html: "<!doctype html><h1>Same Site</h1>",
    });

    expect(first.contentSha256).toBe(second.contentSha256);
    expect(first.sourceSha256).toBe(second.sourceSha256);
    expect(first.contentKey).not.toBe(second.contentKey);
    expect(first.sourceKey).not.toBe(second.sourceKey);
  });
});
