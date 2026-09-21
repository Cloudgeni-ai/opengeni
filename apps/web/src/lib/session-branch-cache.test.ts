import { describe, expect, test } from "bun:test";

import type { Session } from "@/types";
import { commitSessionBranchPage, upsertSessionBranchChild } from "./session-branch-cache";
import { applySessionRailProjection } from "./session-pins";
import { compareSessionActivity, compareSessionBrowse } from "./sessions-group";

const listed = {
  id: "child-a",
  workspaceId: "workspace",
  parentSessionId: "parent",
  status: "idle",
  title: "Listed child",
  channelId: "listed-channel",
  createdAt: "2026-07-10T00:00:00.123456Z",
  updatedAt: "2026-07-10T00:01:00.123456Z",
  treeStats: {
    directChildren: 1,
    totalDescendants: 1,
    runningDescendants: 0,
    queuedDescendants: 0,
    attentionDescendants: 0,
    pausedDescendants: 0,
    failedDescendants: 0,
    truncated: false,
  },
} as Session;
const peer = {
  ...listed,
  id: "child-z",
  createdAt: "2026-07-10T00:00:00.123455Z",
  updatedAt: "2026-07-10T00:02:00.123455Z",
};

describe("branch route insertion ordering ownership", () => {
  test("accepted child page keeps exact ordering through selection, detail updates, deselection and refresh", () => {
    let pages = commitSessionBranchPage(
      new Map(),
      "parent",
      { sessions: [listed, peer], nextCursor: null },
      { readGeneration: 1 },
    );
    const order = (rows: Session[]) =>
      [...rows].sort((a, b) => compareSessionBrowse(a, b, "createdAt")).map((row) => row.id);
    const activityOrder = (rows: Session[]) =>
      [...rows].sort(compareSessionActivity).map((row) => row.id);
    expect(order(pages.get("parent")!.sessions)).toEqual([listed.id, peer.id]);

    // Route detail can be ahead of or behind the accepted list activity clock.
    for (const updatedAt of ["2026-07-10T00:03:00.123Z", "2026-07-09T00:00:00.123Z"]) {
      const detail = {
        ...listed,
        createdAt: "2026-07-10T00:00:00.123Z",
        updatedAt,
        status: "running" as const,
        title: `Fresh route ${updatedAt}`,
        initialMessage: "Fresh route content",
        channelId: "old-detail-channel",
        treeStats: undefined,
      };
      pages = upsertSessionBranchChild(pages, detail);
      const rows = pages.get("parent")!.sessions;
      const cached = rows.find((row) => row.id === listed.id)!;
      expect(cached).toMatchObject({
        createdAt: listed.createdAt,
        updatedAt: listed.updatedAt,
        status: detail.status,
        title: detail.title,
        initialMessage: detail.initialMessage,
        treeStats: listed.treeStats,
        channelId: listed.channelId,
      });
      const selected = applySessionRailProjection(detail, cached);
      const selectedRows = rows.map((row) => (row.id === selected.id ? selected : row));
      expect(order(selectedRows)).toEqual([listed.id, peer.id]);
      expect(activityOrder(selectedRows)).toEqual([peer.id, listed.id]);
      // Deselecting uses the persisted branch rows, not the route overlay.
      expect(order(rows)).toEqual([listed.id, peer.id]);
      expect(activityOrder(rows)).toEqual([peer.id, listed.id]);
    }

    const refreshed = { ...listed, updatedAt: "2026-07-10T00:04:00.654321Z" };
    pages = commitSessionBranchPage(
      pages,
      "parent",
      { sessions: [refreshed, peer], nextCursor: null },
      { replaceWindow: true, readGeneration: 2 },
    );
    pages = upsertSessionBranchChild(pages, {
      ...refreshed,
      createdAt: "2026-07-10T00:00:00.123Z",
      updatedAt: "2026-07-10T00:05:00.000Z",
    });
    const rows = pages.get("parent")!.sessions;
    expect(rows[0]!.updatedAt).toBe(refreshed.updatedAt);
    expect(order(rows)).toEqual([listed.id, peer.id]);
    expect(activityOrder(rows)).toEqual([listed.id, peer.id]);
    expect(order([applySessionRailProjection(listed, rows[0]!), peer])).toEqual([
      listed.id,
      peer.id,
    ]);
  });

  test("a missing child retains route timestamps until an accepted list row replaces it", () => {
    const detail = {
      ...listed,
      createdAt: "2026-07-10T00:00:00.123Z",
      updatedAt: "2026-07-10T00:03:00.123Z",
    };
    for (const initial of [
      new Map(),
      commitSessionBranchPage(new Map(), "parent", { sessions: [peer], nextCursor: "tail" }),
    ]) {
      let pages = upsertSessionBranchChild(initial, detail);
      expect(pages.get("parent")!.sessions.find((row) => row.id === detail.id)).toBe(detail);
      expect(pages.get("parent")!.channelGenerations.has(detail.id)).toBe(false);
      pages = commitSessionBranchPage(pages, "parent", {
        sessions: [listed, peer],
        nextCursor: null,
      });
      pages = upsertSessionBranchChild(pages, detail);
      expect(pages.get("parent")!.sessions[0]).toMatchObject({
        createdAt: listed.createdAt,
        updatedAt: listed.updatedAt,
      });
    }
  });
});
