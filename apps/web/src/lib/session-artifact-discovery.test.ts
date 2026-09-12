import { describe, expect, test } from "bun:test";
import type { ArtifactCatalogItem } from "@opengeni/sdk";
import { discoverSessionArtifacts } from "./session-artifact-discovery";
const item: ArtifactCatalogItem = {
  id: "same",
  kind: "image",
  title: "Logo",
  status: "active",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};
describe("session catalog discovery", () => {
  test("uses shared catalog, session provenance, both statuses, pagination and kind-qualified deduplication", async () => {
    const calls: unknown[] = [];
    const reconcile = await discoverSessionArtifacts("workspace", "session", () => true, {
      listArtifactCatalog: async (workspaceId, options = {}) => {
        calls.push({ workspaceId, ...options });
        return options.status === "archived"
          ? { items: [], nextCursor: null }
          : options.cursor
            ? { items: [{ ...item, kind: "site" }, item], nextCursor: null }
            : { items: [item], nextCursor: "next" };
      },
    });
    const result = reconcile([]);
    expect(result.status).toBe("ready");
    expect(result.artifacts.map((artifact) => artifact.modality)).toEqual(["image", "site"]);
    expect(calls).toHaveLength(3);
    for (const call of calls)
      expect(call).toMatchObject({ workspaceId: "workspace", sourceSessionId: "session" });
  });
  test("stops paging when a request belongs to a stale session", async () => {
    let calls = 0;
    const reconcile = await discoverSessionArtifacts("workspace", "session", () => false, {
      listArtifactCatalog: async () => {
        calls++;
        return { items: [item], nextCursor: "next" };
      },
    });
    expect(reconcile([]).artifacts).toEqual([]);
    expect(calls).toBe(2);
  });
  test("retains transient results but drops them after denial", async () => {
    const previous = [{ id: "old", modality: "image" as const, title: "Old" }];
    for (const status of [403, 404, 500]) {
      const reconcile = await discoverSessionArtifacts("workspace", "session", () => true, {
        listArtifactCatalog: async () => {
          throw Object.assign(new Error("failed"), { status });
        },
      });
      expect(reconcile(previous)).toEqual({
        status: "error",
        artifacts: status === 500 ? previous : [],
      });
    }
  });
});
