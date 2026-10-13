import { describe, expect, test } from "bun:test";
import {
  SESSION_GROUP_VISIBLE_STEP,
  sessionGroupDisclosurePlan,
  sessionGroupWindowNodes,
  planSessionGroupFill,
  sameSessionGroupFill,
  type SessionGroupFillCandidate,
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

describe("session group fill", () => {
  const group = (
    key: string,
    loaded: number,
    hasMore: boolean,
    base = SESSION_GROUP_VISIBLE_STEP,
  ): SessionGroupFillCandidate => ({ key, loaded, base, hasMore });
  const plan = (
    candidates: SessionGroupFillCandidate[],
    current: Record<string, number>,
    freeRows: number,
    shrink = false,
  ) =>
    Object.fromEntries(
      planSessionGroupFill(candidates, new Map(Object.entries(current)), freeRows, shrink),
    );

  test("uses spare rows instead of stopping at the four-row step", () => {
    expect(plan([group("default", 40, true)], {}, 12)).toEqual({ default: 12 });
  });

  test("fills top-down and moves on once a group is exhausted", () => {
    // Completing a reuses the height of its removed Show more control.
    expect(plan([group("a", 6, false), group("b", 30, true)], {}, 10)).toEqual({ a: 2, b: 9 });
  });

  test("reveals a last hidden row in the space of its Show more control", () => {
    expect(plan([group("a", 5, false)], {}, 0)).toEqual({ a: 1 });
    expect(plan([group("a", 6, false)], {}, 0)).toEqual({});
    expect(plan([group("a", 9, false)], { a: 4 }, 0)).toEqual({ a: 5 });
    expect(plan([group("a", 10, false)], { a: 4 }, 0)).toEqual({ a: 4 });
    expect(plan([group("a", 9, false)], { a: 3 }, 1)).toEqual({ a: 5 });
    expect(plan([group("a", 12, false)], { a: 3 }, 1)).toEqual({ a: 4 });
    // A group that takes the remaining space leaves only control swaps below.
    expect(plan([group("a", 40, true), group("b", 5, false)], {}, 3)).toEqual({ a: 3, b: 1 });
  });

  test("never fills a group that has nothing hidden", () => {
    expect(plan([group("a", 3, false), group("b", 4, false)], {}, 10)).toEqual({});
  });

  test("counts planned rows that are still loading against spare space", () => {
    // 12 rows are planned, 4 + 2 are rendered, so 10 are still on the way.
    expect(plan([group("a", 6, true)], { a: 12 }, 10)).toEqual({ a: 12 });
    expect(plan([group("a", 6, true)], { a: 12 }, 13)).toEqual({ a: 15 });
  });

  test("counts a restored manual window that is still loading", () => {
    // Show more was at 12 before Settings; only the first 4 rows are back yet.
    expect(plan([group("a", 4, true, 12)], {}, 8)).toEqual({});
    expect(plan([group("a", 4, true, 12)], {}, 11)).toEqual({ a: 3 });
  });

  test("keeps visible rows when content grows without the viewport shrinking", () => {
    expect(plan([group("a", 40, true), group("b", 40, true, 12)], { a: 6 }, -8)).toEqual({ a: 6 });
  });

  test("returns rows bottom-up when the viewport shrinks", () => {
    expect(plan([group("a", 40, true), group("b", 40, true)], { a: 6, b: 3 }, -5, true)).toEqual({
      a: 4,
    });
    expect(plan([group("a", 40, true)], { a: 6 }, -20, true)).toEqual({});
  });

  test("drops unloaded rows before visible rows when shrinking", () => {
    // 10 planned, 4 visible: one row of overflow keeps three visible rows.
    expect(plan([group("a", 8, true)], { a: 10 }, -1, true)).toEqual({ a: 3 });
  });

  test("trims fill an exhausted group cannot render and drops collapsed groups", () => {
    expect(plan([group("a", 7, false)], { a: 10, collapsed: 5 }, 0)).toEqual({ a: 3 });
  });

  test("compares plans by visible rows", () => {
    expect(sameSessionGroupFill(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
    expect(sameSessionGroupFill(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(sameSessionGroupFill(new Map(), new Map([["a", 1]]))).toBe(false);
  });
});
