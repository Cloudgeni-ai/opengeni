import { describe, expect, test } from "bun:test";
import {
  SESSION_GROUP_VISIBLE_STEP,
  sessionGroupDisclosurePlan,
  sessionGroupWindowNodes,
} from "./session-group-window";
import type { SessionTreeNode } from "./sessions-group";
import type { Session } from "@/types";

function nodes(count: number): SessionTreeNode[] {
  return Array.from({ length: count }, (_, index) => ({
    session: { id: `session-${index}` } as Session,
    children: [],
    hasActiveDescendant: false,
  }));
}

describe("session group disclosure", () => {
  test("initially shows four regardless of a retained 8, 40 or 100-row page", () => {
    for (const count of [8, 40, 100]) {
      expect(sessionGroupWindowNodes(nodes(count), SESSION_GROUP_VISIBLE_STEP, null)).toHaveLength(
        4,
      );
    }
  });

  test("reveals four at a time and only the remaining rows on the final step", () => {
    const rows = nodes(10);
    expect(sessionGroupWindowNodes(rows, 4, null)).toHaveLength(4);
    expect(sessionGroupWindowNodes(rows, 8, null)).toHaveLength(8);
    expect(sessionGroupWindowNodes(rows, 12, null)).toHaveLength(10);
  });

  test("fills a four-row step across a 50-row cache boundary", () => {
    expect(sessionGroupDisclosurePlan(48, 50, true, false)).toEqual({
      nextCount: 52,
      needsPage: true,
    });
    expect(sessionGroupDisclosurePlan(44, 50, true, false)).toEqual({
      nextCount: 48,
      needsPage: false,
    });
  });

  test("reveals an exhausted final partial batch without another request", () => {
    expect(sessionGroupDisclosurePlan(48, 50, false, false)).toEqual({
      nextCount: 52,
      needsPage: false,
    });
  });

  test("retry fetches again but does not enlarge the display window", () => {
    expect(sessionGroupDisclosurePlan(4, 40, true, true)).toEqual({
      nextCount: 4,
      needsPage: true,
    });
  });

  test("keeps an off-window selected root within the four-row limit", () => {
    const rows = nodes(40);
    expect(sessionGroupWindowNodes(rows, 4, "session-39").map((node) => node.session.id)).toEqual([
      "session-0",
      "session-1",
      "session-2",
      "session-39",
    ]);
    expect(rows[3]!.session.id).toBe("session-3");
  });

  test("keeps the root of an off-window selected descendant visible", () => {
    const rows = nodes(8);
    rows[7]!.children = nodes(1).map((node) => ({
      ...node,
      session: { id: "selected-child" } as Session,
    }));
    const visible = sessionGroupWindowNodes(rows, 4, "selected-child");
    expect(visible).toHaveLength(4);
    expect(visible[3]).toBe(rows[7]);
  });

  test("does not invent rows in empty or sparse groups", () => {
    expect(sessionGroupWindowNodes([], 4, "missing")).toEqual([]);
    expect(sessionGroupWindowNodes(nodes(1), 4, null)).toHaveLength(1);
  });
});
