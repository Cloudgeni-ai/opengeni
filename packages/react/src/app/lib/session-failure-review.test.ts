import { describe, expect, test } from "bun:test";

import type { Session } from "../types";
import { filterNeedsYou } from "./needs-you";
import { applySessionAttentionProjections } from "./session-attention";
import { needsFailureReview } from "./session-failure";
import { summarizeRailNodes, type SessionTreeNode } from "./sessions-group";

// A failed sub-agent whose result its parent agent already consumed is that
// agent's to retry, restart or replace. The server marks it `failureHandled`
// and leaves it out of `unreadFailedDescendants`; loaded rows and live read
// projections must apply the same rule, so the person sees one signal.

function session(overrides: Partial<Session> & { id: string }): Session {
  const { id, ...rest } = overrides;
  return {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    status: "idle",
    parentSessionId: null,
    rootSessionId: "root",
    archived: false,
    unread: false,
    attentionVersion: 1,
    lastSequence: 10,
    effectiveControl: { state: "active" },
    ...rest,
    id,
  } as Session;
}

function node(value: Session, children: SessionTreeNode[] = []): SessionTreeNode {
  return { session: value, children, hasActiveDescendant: false };
}

const handled = session({
  id: "handled",
  parentSessionId: "root",
  status: "failed",
  unread: true,
  failureHandled: true,
});
const unhandled = session({
  id: "unhandled",
  parentSessionId: "root",
  status: "failed",
  unread: true,
});

describe("failures a parent agent already handled", () => {
  test("do not ask the person for review", () => {
    expect(needsFailureReview(handled)).toBe(false);
    expect(needsFailureReview(unhandled)).toBe(true);
    expect(needsFailureReview({ ...unhandled, unread: false })).toBe(false);
    // A top-level chat has no parent agent to take its failure.
    expect(needsFailureReview(session({ id: "root", status: "failed", unread: true }))).toBe(true);
  });

  test("leave no red or unread marker on a row built from loaded sub-agents", () => {
    const root = session({ id: "root" });
    expect(summarizeRailNodes([node(root, [node(handled)])]).kind).toBe("neutral");
    expect(summarizeRailNodes([node(root, [node(handled), node(unhandled)])])).toMatchObject({
      kind: "failed",
      count: 1,
    });
  });

  test("reading one leaves the count of failures that still need the person", () => {
    const root = session({
      id: "root",
      treeStats: {
        directChildren: 2,
        totalDescendants: 2,
        runningDescendants: 0,
        queuedDescendants: 0,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 2,
        unreadFailedDescendants: 1,
        // The server leaves `handled` out of both counts.
        unreadDescendants: 1,
        activelyWorkingDescendants: 0,
        truncated: false,
      },
    });
    const projected = applySessionAttentionProjections(
      [root, handled, unhandled],
      new Map([[handled.id, { ...handled, unread: false, attentionVersion: 2 }]]),
    );
    // Neither count included `handled`, so reading it leaves both unchanged.
    expect(projected.find((row) => row.id === root.id)?.treeStats).toMatchObject({
      unreadFailedDescendants: 1,
      unreadDescendants: 1,
    });
  });

  test("are not listed under Needs you", () => {
    const root = session({ id: "root" });
    expect(filterNeedsYou([root, handled, unhandled]).map((row) => row.id)).toEqual([
      "unhandled",
    ]);
  });
});
