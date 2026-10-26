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
  test("reads the chat and its sub-sessions in one catalog query per status, with pagination and kind-qualified deduplication", async () => {
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
      expect(call).toMatchObject({
        workspaceId: "workspace",
        sourceSessionId: "session",
        includeSubSessions: true,
        sort: "updated",
      });
    expect(new Set(calls.map((call) => (call as { status: string }).status))).toEqual(
      new Set(["active", "archived"]),
    );
  });
  test("costs two reads however many sub-sessions published work", async () => {
    // The server answers for the whole tree; sub-session provenance comes back
    // on each item, and the client never lists the catalog per sub-session.
    const calls: Array<{ sourceSessionId?: string; status?: string }> = [];
    const reconcile = await discoverSessionArtifacts("workspace", "parent", () => true, {
      listArtifactCatalog: async (_workspaceId, options = {}) => {
        calls.push(options);
        if (options.status === "archived") return { items: [], nextCursor: null };
        return {
          items: Array.from({ length: 60 }, (_, index) => ({
            ...item,
            id: `child-${index}-image`,
            sourceSessionId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          })),
          nextCursor: null,
        };
      },
    });
    expect(reconcile([]).artifacts).toHaveLength(60);
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.sourceSessionId))).toEqual(new Set(["parent"]));
  });
  test("keeps the server's catalog order and lists active before archived", async () => {
    const reconcile = await discoverSessionArtifacts("workspace", "parent", () => true, {
      listArtifactCatalog: async (_workspaceId, options = {}) =>
        options.status === "archived"
          ? {
              items: [
                {
                  ...item,
                  id: "archived",
                  status: "archived" as const,
                  updatedAt: "2026-09-09T00:00:00Z",
                },
              ],
              nextCursor: null,
            }
          : {
              // Server order: pinned first, then most recently updated.
              items: [
                { ...item, id: "pinned-old", pinned: true },
                { ...item, id: "new", updatedAt: "2026-09-05T00:00:00Z" },
                { ...item, id: "old" },
              ],
              nextCursor: null,
            },
    });
    expect(reconcile([]).artifacts.map((artifact) => artifact.id)).toEqual([
      "pinned-old",
      "new",
      "old",
      "archived",
    ]);
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
  test("refuses a cursor that does not advance", async () => {
    const reconcile = await discoverSessionArtifacts("workspace", "session", () => true, {
      listArtifactCatalog: async () => ({ items: [item], nextCursor: "same" }),
    });
    expect(reconcile([]).status).toBe("error");
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
