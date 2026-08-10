import { describe, expect, test } from "bun:test";
import type { AgentTopologySession } from "@opengeni/sdk";

import {
  AGENT_DIAGRAM_NODE_HEIGHT,
  AGENT_DIAGRAM_NODE_WIDTH,
  buildAgentTopology,
  filterAgentTopology,
  layoutAgentTopologyDiagram,
  limitAgentTopology,
  summarizeAgentTopology,
} from "./agent-topology";

function session(
  id: string,
  options: Partial<Pick<AgentTopologySession, "parentSessionId" | "status" | "title">> = {},
): AgentTopologySession {
  return {
    id,
    parentSessionId: options.parentSessionId ?? null,
    status: options.status ?? "idle",
    title: options.title ?? id,
    titleTruncated: false,
    rootSessionId: options.parentSessionId ? "root" : id,
    nestedAgentDepth: options.parentSessionId ? 1 : 0,
    ancestorPath: [],
    updatedAt: "2026-08-10T10:00:00.000Z",
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

  test("active filtering retains the ancestor path", () => {
    const root = session("root");
    const child = session("child", { parentSessionId: "root", status: "running" });
    const filtered = filterAgentTopology(buildAgentTopology([root, child]), "active", "");
    expect(filtered[0]?.session.id).toBe("root");
    expect(filtered[0]?.children[0]?.session.id).toBe("child");
  });

  test("keeps an unloaded branch when server aggregates contain a matching descendant", () => {
    const root = session("root");
    root.children.runningDescendants = 1;
    root.children.totalDescendants = 1;
    const filtered = filterAgentTopology(buildAgentTopology([root]), "active", "");
    expect(filtered.map((node) => node.session.id)).toEqual(["root"]);
  });

  test("summarizes paused work separately from active statuses", () => {
    const running = session("running", { status: "running" });
    const queued = session("queued", { status: "queued" });
    const paused = {
      ...session("paused", { status: "running" }),
      pause: { state: "paused", additionalBlockerCount: 0, source: null },
    } as AgentTopologySession;
    expect(summarizeAgentTopology([running, queued, paused])).toMatchObject({
      total: 3,
      active: 2,
      running: 1,
      queued: 1,
      paused: 1,
    });
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
});
