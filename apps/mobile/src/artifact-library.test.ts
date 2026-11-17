import { expect, mock, test } from "bun:test";
import * as React from "../../../packages/react/node_modules/react";

// The library's hooks need React; the mobile app's own install isn't required here.
mock.module("react", () => React);
mock.module("expo-crypto", () => ({ getRandomBytes: (size: number) => new Uint8Array(size) }));

const { cachedArtifact, loadArtifactItem } = await import("./artifact-library");

function siteClient(title: string) {
  return {
    getWorkspaceArtifact: async () => ({
      artifact: {
        title,
        createdAt: "2026-11-17T10:00:00.000Z",
        updatedAt: "2026-11-17T10:00:00.000Z",
        status: "active",
      },
    }),
    listArtifactCatalog: async () => ({ items: [], nextCursor: null }),
  } as unknown as Parameters<typeof loadArtifactItem>[0];
}

test("what one account read is never shown to another in the same workspace", async () => {
  const a = siteClient("Private to A");
  const b = siteClient("B's view");
  await loadArtifactItem(a, "shared-workspace", "site", "site-1", undefined);
  expect(cachedArtifact(a, "shared-workspace", "site", "site-1")?.title).toBe("Private to A");
  expect(cachedArtifact(b, "shared-workspace", "site", "site-1")).toBeNull();
});
