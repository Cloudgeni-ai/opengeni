import { describe, expect, test } from "bun:test";
import type { AgentTopologySession } from "@opengeni/sdk";

import {
  AGENT_DIAGRAM_NODE_HEIGHT,
  AGENT_DIAGRAM_NODE_WIDTH,
  agentHasMatchingDescendants,
  buildAgentTopology,
  canStartAgentTopologyRootRead,
  filterAgentTopology,
  layoutAgentTopologyDiagram,
  limitAgentTopology,
  mergeAgentTopologySessions,
  nextAgentTopologyBranchPage,
  normalizeAgentTopologySession,
  selectAgentTopologyBranchesToLoad,
  staleLiveRootIds,
  summarizeAgentTopology,
  withoutAgentTopologyRoots,
} from "./agent-topology";

function session(
  id: string,
  options: Partial<
    Pick<
      AgentTopologySession,
      "parentSessionId" | "status" | "title" | "updatedAt" | "rootSessionId"
    >
  > = {},
): AgentTopologySession {
  return {
    id,
    parentSessionId: options.parentSessionId ?? null,
    status: options.status ?? "idle",
    title: options.title ?? id,
    titleTruncated: false,
    rootSessionId: options.rootSessionId ?? (options.parentSessionId ? "root" : id),
    nestedAgentDepth: options.parentSessionId ? 1 : 0,
    ancestorPath: [],
    goal: null,
    relatedWork: {
      claims: [],
      claimsTruncated: false,
      match: null,
      possibleOverlap: false,
      advisoryOnly: true,
      noAdditionalAccess: true,
    },
    updatedAt: options.updatedAt ?? "2026-08-10T10:00:00.000Z",
    createdAt: "2026-08-10T10:00:00.000Z",
    pause: { state: "active", additionalBlockerCount: 0, source: null },
    children: {
      directChildren: 0,
      totalDescendants: 0,
      runningDescendants: 0,
      queuedDescendants: 0,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      truncated: false,
    },
  };
}

describe("agent topology", () => {
  test("normalizes additive advisory fields from a draining older API replica", () => {
    const legacy = { ...session("legacy") } as Partial<AgentTopologySession>;
    delete legacy.goal;
    delete legacy.relatedWork;

    expect(normalizeAgentTopologySession(legacy as AgentTopologySession)).toMatchObject({
      goal: null,
      relatedWork: {
        claims: [],
        match: null,
        possibleOverlap: false,
        advisoryOnly: true,
        noAdditionalAccess: true,
      },
    });
  });

  test("builds spawned sessions beneath their durable parent", () => {
    const root = session("root", { status: "running" });
    const child = session("child", { parentSessionId: "root" });
    const grandchild = session("grandchild", { parentSessionId: "child" });
    const forest = buildAgentTopology([grandchild, root, child]);
    expect(forest.map((node) => node.session.id)).toEqual(["root"]);
    expect(forest[0]?.children[0]?.session.id).toBe("child");
    expect(forest[0]?.children[0]?.children[0]?.session.id).toBe("grandchild");
  });

  test("keeps orphaned and cyclic history visible without recursive nodes", () => {
    const orphan = session("orphan", { parentSessionId: "missing" });
    const a = session("a", { parentSessionId: "b" });
    const b = session("b", { parentSessionId: "a" });
    const forest = buildAgentTopology([orphan, a, b]);
    expect(new Set(forest.map((node) => node.session.id))).toEqual(new Set(["orphan", "a", "b"]));
    expect(forest.every((node) => node.detached && node.children.length === 0)).toBe(true);
  });

  test("the running view retains the ancestor path", () => {
    const root = session("root");
    const child = session("child", {
      parentSessionId: "root",
      status: "running",
    });
    const filtered = filterAgentTopology(buildAgentTopology([root, child]), "running", "");
    expect(filtered[0]?.session.id).toBe("root");
    expect(filtered[0]?.children[0]?.session.id).toBe("child");
  });

  test("keeps an unloaded branch when server aggregates contain a matching descendant", () => {
    const root = session("root");
    root.children.runningDescendants = 1;
    root.children.totalDescendants = 1;
    const filtered = filterAgentTopology(buildAgentTopology([root]), "running", "");
    expect(filtered.map((node) => node.session.id)).toEqual(["root"]);
  });

  test("counts queued, recovering and capacity waits as running, never paused work", () => {
    const paused = {
      ...session("paused", { status: "requires_action" }),
      pause: { state: "paused", additionalBlockerCount: 0, source: null },
    } as AgentTopologySession;
    const forest = buildAgentTopology([
      session("queued", { status: "queued" }),
      session("recovering", { status: "recovering" }),
      session("capacity", { status: "waiting_capacity" }),
      session("idle"),
      paused,
    ]);
    expect(
      filterAgentTopology(forest, "running", "")
        .map((node) => node.session.id)
        .sort(),
    ).toEqual(["capacity", "queued", "recovering"]);
    expect(filterAgentTopology(forest, "attention", "")).toEqual([]);
  });

  test("the failed view holds top-level workstreams that failed in the last day", () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const recent = session("recent", { status: "failed", updatedAt: "2026-08-10T02:00:00.000Z" });
    const old = session("old", { status: "failed", updatedAt: "2026-08-08T12:00:00.000Z" });
    const parent = session("parent", { updatedAt: "2026-08-10T11:00:00.000Z" });
    const failedChild = session("failed-child", {
      parentSessionId: "parent",
      rootSessionId: "parent",
      status: "failed",
      updatedAt: "2026-08-10T11:00:00.000Z",
    });
    const forest = buildAgentTopology([recent, old, parent, failedChild]);
    expect(filterAgentTopology(forest, "failed", "", now).map((node) => node.session.id)).toEqual([
      "recent",
    ]);
  });

  test("uses server aggregates to decide which filtered branches should open automatically", () => {
    const root = session("root");
    root.children.directChildren = 4;
    root.children.runningDescendants = 1;
    root.children.pausedDescendants = 2;
    expect(agentHasMatchingDescendants(root, "all")).toBe(true);
    expect(agentHasMatchingDescendants(root, "running")).toBe(true);
    expect(agentHasMatchingDescendants(root, "attention")).toBe(false);
    expect(agentHasMatchingDescendants(root, "failed")).toBe(false);

    const quiet = session("quiet");
    quiet.children.directChildren = 3;
    quiet.children.totalDescendants = 3;
    expect(agentHasMatchingDescendants(quiet, "all")).toBe(false);
  });

  test("drops a workstream loaded only while live once it is neither live nor on a page", () => {
    const stale = staleLiveRootIds(
      new Set(["done", "still-live", "paged"]),
      new Set(["still-live", "first-page"]),
      new Set(["paged"]),
    );
    expect([...stale]).toEqual(["done"]);

    const done = session("done");
    const doneChild = session("done-child", { parentSessionId: "done", rootSessionId: "done" });
    const kept = session("kept");
    expect(
      withoutAgentTopologyRoots([done, doneChild, kept], stale).map((item) => item.id),
    ).toEqual(["kept"]);
  });

  test("keeps previously paged agents when the first page refreshes", () => {
    const rootA = session("root-a");
    const rootB = session("root-b");
    const child = session("child", { parentSessionId: "root-a" });
    const refreshedRootA = { ...rootA, title: "refreshed" };
    expect(mergeAgentTopologySessions([rootA, rootB, child], [refreshedRootA], 200)).toEqual([
      refreshedRootA,
      rootB,
      child,
    ]);
    expect(mergeAgentTopologySessions([rootA], [rootB, child], 2).map((item) => item.id)).toEqual([
      "root-a",
      "root-b",
    ]);
  });

  test("refreshes known agents after skipping novel agents beyond the cap", () => {
    const rootA = session("root-a");
    const rootB = session("root-b");
    const novel = session("novel");
    const refreshedRootB = { ...rootB, title: "refreshed" };

    expect(mergeAgentTopologySessions([rootA, rootB], [novel, refreshedRootB], 2)).toEqual([
      rootA,
      refreshedRootB,
    ]);
  });

  test("fills only the available global auto-expand request slots", () => {
    expect(
      selectAgentTopologyBranchesToLoad(
        ["loaded", "active", "next", "later"],
        new Set(["loaded"]),
        new Set(["active", "manual"]),
        4,
      ),
    ).toEqual(["next", "later"]);
    expect(
      selectAgentTopologyBranchesToLoad(
        ["one", "two"],
        new Set(),
        new Set(["a", "b", "c", "d"]),
        4,
      ),
    ).toEqual([]);
  });

  test("keeps first-page refresh and root pagination on one request lane", () => {
    expect(canStartAgentTopologyRootRead(false)).toBe(true);
    expect(canStartAgentTopologyRootRead(true)).toBe(false);
  });

  test("summarizes three numbers from workstreams and their server counts", () => {
    const now = Date.parse("2026-08-10T12:00:00.000Z");
    const running = session("running", { status: "running" });
    running.children.attentionDescendants = 2;
    running.children.runningDescendants = 1;
    running.children.queuedDescendants = 1;
    const queued = session("queued", { status: "queued" });
    const waiting = session("waiting", { status: "requires_action" });
    const paused = {
      ...session("paused", { status: "requires_action" }),
      pause: { state: "paused", additionalBlockerCount: 0, source: null },
    } as AgentTopologySession;
    const recentFailure = session("recent", {
      status: "failed",
      updatedAt: "2026-08-10T01:00:00.000Z",
    });
    const oldFailure = session("old", { status: "failed", updatedAt: "2026-08-01T01:00:00.000Z" });
    // A loaded child is already inside its root's counts.
    const loadedChild = session("child", {
      parentSessionId: "running",
      rootSessionId: "running",
      status: "requires_action",
    });
    expect(
      summarizeAgentTopology(
        [running, queued, waiting, paused, recentFailure, oldFailure, loadedChild, running],
        now,
      ),
    ).toEqual({ attention: 3, running: 4, failed: 1, capped: false });

    const huge = session("huge");
    huge.children.truncated = true;
    expect(summarizeAgentTopology([huge], now).capped).toBe(true);
  });

  test("lays out a top-down diagram and removes collapsed descendants", () => {
    const root = session("root", { status: "running" });
    const childA = session("child-a", { parentSessionId: "root" });
    const childB = session("child-b", { parentSessionId: "root" });
    const grandchild = session("grandchild", { parentSessionId: "child-a" });
    const forest = buildAgentTopology([root, childA, childB, grandchild]);

    const expanded = layoutAgentTopologyDiagram(forest, new Set());
    const rootPosition = expanded.nodes.find((item) => item.node.session.id === "root");
    const childPosition = expanded.nodes.find((item) => item.node.session.id === "child-a");
    expect(expanded.nodes).toHaveLength(4);
    expect(rootPosition?.x).toBeGreaterThanOrEqual(0);
    expect(childPosition?.y).toBeGreaterThan(rootPosition?.y ?? 0);
    expect(expanded.width).toBeGreaterThan(AGENT_DIAGRAM_NODE_WIDTH * 2);
    expect(expanded.height).toBeGreaterThan(AGENT_DIAGRAM_NODE_HEIGHT * 2);

    const collapsed = layoutAgentTopologyDiagram(forest, new Set(["root"]));
    expect(collapsed.nodes.map((item) => item.node.session.id)).toEqual(["root"]);
  });

  test("bounds wide and deep trees without losing omitted counts", () => {
    const root = session("root");
    const children = Array.from({ length: 20 }, (_, index) =>
      session(`child-${index}`, { parentSessionId: "root" }),
    );
    const deep = session("deep", { parentSessionId: "child-0" });
    const deeper = session("deeper", { parentSessionId: "deep" });
    const forest = buildAgentTopology([root, ...children, deep, deeper]);

    const limited = limitAgentTopology(forest, {
      maxDepth: 1,
      maxChildren: 5,
      maxNodes: 200,
    });
    expect(limited.visibleCount).toBe(6);
    expect(limited.hiddenCount).toBe(17);
    expect(limited.hiddenByParent.get("root")).toBe(15);
    expect(limited.hiddenByParent.get("child-0")).toBe(2);

    const globallyLimited = limitAgentTopology(forest, {
      maxDepth: null,
      maxChildren: null,
      maxNodes: 4,
    });
    expect(globallyLimited.visibleCount).toBe(4);
    expect(globallyLimited.hiddenCount).toBe(19);
  });

  test("wraps whole workstreams into bands that fit the available width", () => {
    const roots = Array.from({ length: 5 }, (_, index) => session(`root-${index}`));
    const withChildren = [
      ...roots,
      session("child-a", { parentSessionId: "root-1", rootSessionId: "root-1" }),
      session("child-b", { parentSessionId: "root-1", rootSessionId: "root-1" }),
    ];
    const forest = buildAgentTopology(withChildren);
    const single = layoutAgentTopologyDiagram(forest, new Set());
    expect(
      new Set(single.nodes.filter((item) => item.depth === 0).map((item) => item.y)).size,
    ).toBe(1);

    const narrow = layoutAgentTopologyDiagram(forest, new Set(), AGENT_DIAGRAM_NODE_WIDTH * 3);
    expect(narrow.width).toBeLessThanOrEqual(AGENT_DIAGRAM_NODE_WIDTH * 3);
    const rootRows = new Set(narrow.nodes.filter((item) => item.depth === 0).map((item) => item.y));
    expect(rootRows.size).toBeGreaterThan(1);
    // A workstream is never split across bands: children sit under their root.
    const parent = narrow.nodes.find((item) => item.node.session.id === "root-1")!;
    for (const child of narrow.nodes.filter((item) => item.parentId === "root-1")) {
      expect(child.y).toBeGreaterThan(parent.y);
      expect(child.y - parent.y).toBeLessThan(AGENT_DIAGRAM_NODE_HEIGHT * 2);
    }
  });

  test("on one column a parent sits over its first child so it stays on screen", () => {
    const root = session("root");
    const children = Array.from({ length: 3 }, (_, index) =>
      session(`child-${index}`, {
        parentSessionId: "root",
        status: index === 0 ? "running" : "idle",
      }),
    );
    const layout = layoutAgentTopologyDiagram(
      buildAgentTopology([root, ...children]),
      new Set(),
      AGENT_DIAGRAM_NODE_WIDTH + 40,
    );
    const rootPosition = layout.nodes.find((item) => item.node.session.id === "root")!;
    const first = layout.nodes.find((item) => item.node.session.id === "child-0")!;
    expect(rootPosition.x).toBe(0);
    expect(first.x).toBe(0);
  });

  test("places the highest-priority child near the center of a wide diagram", () => {
    const root = session("root");
    const children = Array.from({ length: 5 }, (_, index) =>
      session(`child-${index}`, {
        parentSessionId: "root",
        status: index === 0 ? "running" : "idle",
      }),
    );
    const layout = layoutAgentTopologyDiagram(buildAgentTopology([root, ...children]), new Set());
    const rootPosition = layout.nodes.find((item) => item.node.session.id === "root")!;
    const priorityPosition = layout.nodes.find((item) => item.node.session.id === "child-0")!;
    expect(priorityPosition.x).toBe(rootPosition.x);
  });

  test("an open branch with a footer gets a slot after its children, and one while empty", () => {
    const root = session("root");
    const children = Array.from({ length: 2 }, (_, index) =>
      session(`child-${index}`, { parentSessionId: "root" }),
    );
    const forest = buildAgentTopology([root, ...children]);
    const layout = layoutAgentTopologyDiagram(forest, new Set(), undefined, new Set(["root"]));
    const footer = layout.footers[0]!;
    expect(layout.footers).toHaveLength(1);
    expect(footer).toMatchObject({ parentId: "root", depth: 1 });
    const childSlots = layout.nodes.filter((item) => item.parentId === "root");
    expect(childSlots.every((child) => child.y === footer.y)).toBe(true);
    // After every child, never on top of one.
    expect(footer.x).toBeGreaterThan(Math.max(...childSlots.map((child) => child.x)));

    // A branch still loading has no children yet: the footer alone is its second level.
    const loading = layoutAgentTopologyDiagram(
      buildAgentTopology([root]),
      new Set(),
      undefined,
      new Set(["root"]),
    );
    expect(loading.footers).toHaveLength(1);
    expect(loading.height).toBeGreaterThan(AGENT_DIAGRAM_NODE_HEIGHT * 2);

    // A folded branch shows no footer.
    expect(
      layoutAgentTopologyDiagram(forest, new Set(["root"]), undefined, new Set(["root"])).footers,
    ).toEqual([]);
  });

  test("a quiet refresh keeps the cursor of a branch already paged past page one", () => {
    const first = nextAgentTopologyBranchPage(
      undefined,
      { total: 250, hasMore: true, nextCursor: "page-2" },
      { quiet: false },
    );
    expect(first).toMatchObject({ nextCursor: "page-2", paged: false });
    const second = nextAgentTopologyBranchPage(
      first,
      { total: 250, hasMore: true, nextCursor: "page-3" },
      { cursor: "page-2", quiet: false },
    );
    expect(second).toMatchObject({ nextCursor: "page-3", paged: true });

    // Re-reading page one must not hand back page two's cursor.
    const refreshed = nextAgentTopologyBranchPage(
      second,
      { total: 251, hasMore: true, nextCursor: "page-2" },
      { quiet: true },
    );
    expect(refreshed).toMatchObject({ nextCursor: "page-3", hasMore: true, total: 251 });

    // Every page loaded: "Show more" stays gone after a refresh.
    const done = nextAgentTopologyBranchPage(
      second,
      { total: 250, hasMore: false, nextCursor: null },
      { cursor: "page-3", quiet: false },
    );
    expect(
      nextAgentTopologyBranchPage(
        done,
        { total: 250, hasMore: true, nextCursor: "page-2" },
        { quiet: true },
      ),
    ).toMatchObject({ nextCursor: null, hasMore: false });

    // A branch on its first page takes the refreshed first page as is.
    expect(
      nextAgentTopologyBranchPage(
        first,
        { total: 260, hasMore: true, nextCursor: "page-2b" },
        { quiet: true },
      ),
    ).toMatchObject({ nextCursor: "page-2b", total: 260, paged: false });
  });
});
