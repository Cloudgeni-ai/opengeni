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
  test("includes artifacts published by sub-sessions as the chat's own", async () => {
    const sources: unknown[] = [];
    const node = (id: string, children: unknown[] = []) => ({ session: { id }, children });
    const reconcile = await discoverSessionArtifacts("workspace", "parent", () => true, {
      getSessionLineage: async () =>
        ({
          ancestors: [],
          truncated: false,
          children: [node("child", [node("grandchild")]), node("unreadable")],
        }) as never,
      listArtifactCatalog: async (_workspaceId, options = {}) => {
        sources.push(options.sourceSessionId);
        if (options.status === "archived") return { items: [], nextCursor: null };
        if (options.sourceSessionId === "unreadable")
          throw Object.assign(new Error("denied"), { status: 403 });
        return {
          items: [
            {
              ...item,
              id: `${options.sourceSessionId}-image`,
              updatedAt:
                options.sourceSessionId === "grandchild"
                  ? "2026-09-03T00:00:00Z"
                  : "2026-09-01T00:00:00Z",
            },
          ],
          nextCursor: null,
        };
      },
    });
    const result = reconcile([]);
    expect(result.status).toBe("ready");
    expect(result.artifacts.map((artifact) => artifact.id)).toEqual([
      "grandchild-image",
      "parent-image",
      "child-image",
    ]);
    expect(new Set(sources)).toEqual(new Set(["parent", "child", "grandchild", "unreadable"]));
  });
  test("keeps pinned and active artifacts first when sub-sessions are merged", async () => {
    const node = (id: string) => ({ session: { id }, children: [] });
    const reconcile = await discoverSessionArtifacts("workspace", "parent", () => true, {
      getSessionLineage: async () =>
        ({ ancestors: [], truncated: false, children: [node("child")] }) as never,
      listArtifactCatalog: async (_workspaceId, options = {}) => {
        const source = options.sourceSessionId;
        if (options.status === "archived")
          return {
            items: [
              {
                ...item,
                id: `${source}-archived`,
                status: "archived" as const,
                updatedAt: "2026-09-09T00:00:00Z",
              },
            ],
            nextCursor: null,
          };
        // Server order for one source: pinned first, then recency.
        return {
          items:
            source === "parent"
              ? [
                  { ...item, id: "parent-pinned", pinned: true },
                  { ...item, id: "parent-recent", updatedAt: "2026-09-05T00:00:00Z" },
                ]
              : [{ ...item, id: "child-recent", updatedAt: "2026-09-05T00:00:00Z" }],
          nextCursor: null,
        };
      },
    });
    expect(reconcile([]).artifacts.map((artifact) => artifact.id)).toEqual([
      "parent-pinned",
      "parent-recent",
      "child-recent",
      "parent-archived",
      "child-archived",
    ]);
  });
  test("reads at most 50 sub-sessions beyond the chat itself", async () => {
    const sources = new Set<unknown>();
    const children = Array.from({ length: 60 }, (_, index) => ({
      session: { id: `child-${index}` },
      children: [],
    }));
    await discoverSessionArtifacts("workspace", "parent", () => true, {
      getSessionLineage: async () => ({ ancestors: [], truncated: false, children }) as never,
      listArtifactCatalog: async (_workspaceId, options = {}) => {
        sources.add(options.sourceSessionId);
        return { items: [], nextCursor: null };
      },
    });
    expect(sources.size).toBe(51);
    expect(sources.has("parent")).toBe(true);
    expect(sources.has("child-49")).toBe(true);
    expect(sources.has("child-50")).toBe(false);
  });
  test("falls back to the chat's own artifacts when lineage is unavailable", async () => {
    const sources: unknown[] = [];
    const reconcile = await discoverSessionArtifacts("workspace", "parent", () => true, {
      getSessionLineage: async () => {
        throw new Error("unavailable");
      },
      listArtifactCatalog: async (_workspaceId, options = {}) => {
        sources.push(options.sourceSessionId);
        return { items: options.status === "active" ? [item] : [], nextCursor: null };
      },
    });
    expect(reconcile([]).artifacts.map((artifact) => artifact.id)).toEqual(["same"]);
    expect(new Set(sources)).toEqual(new Set(["parent"]));
  });
});
