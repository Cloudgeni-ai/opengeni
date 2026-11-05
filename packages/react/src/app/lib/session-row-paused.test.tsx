import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RailTrailingMetadata } from "../components/rail/session-row-content";
import { prunePinnedSubtrees, summarizeRailNodes, summarizeRailRow } from "./sessions-group";
import type { Session } from "../types";

/*
 * Pause parks a chat's work for Resume. Its sidebar row shows a still pause
 * mark instead of the working spinner, or nothing at all.
 */

function control(state: "active" | "paused"): Session["effectiveControl"] {
  return {
    state,
    controlVersion: 0,
    controlEtag: `${state}-0`,
    directState: state,
    primaryBlocker: null,
    additionalBlockerCount: 0,
    blockers: [],
    resumeOptions: [],
    override: null,
    settlement: null,
  } as Session["effectiveControl"];
}

function tree(overrides: Partial<NonNullable<Session["treeStats"]>> = {}): Session["treeStats"] {
  return {
    directChildren: 0,
    totalDescendants: 0,
    runningDescendants: 0,
    queuedDescendants: 0,
    waitingDescendants: 0,
    attentionDescendants: 0,
    pausedDescendants: 0,
    failedDescendants: 0,
    unreadDescendants: 0,
    unreadFailedDescendants: 0,
    truncated: false,
    ...overrides,
  } as Session["treeStats"];
}

function session(patch: Partial<Session> & Pick<Session, "id">): Session {
  return {
    accountId: "account-1",
    workspaceId: "workspace-1",
    status: "idle",
    activeTurnId: null,
    initialMessage: "hi",
    title: null,
    parentSessionId: null,
    channelId: null,
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    unread: false,
    createdBy: { kind: "subject", subjectId: "user:test" },
    effectiveControl: control("active"),
    treeStats: tree(),
    createdAt: "2026-11-02T12:00:00.000Z",
    updatedAt: "2026-11-02T13:00:00.000Z",
    ...patch,
  } as Session;
}

const row = (value: Session) => ({ session: value, children: [], hasActiveDescendant: false });

describe("a paused chat in the sidebar", () => {
  test("its turn parked by Pause shows paused, not working", () => {
    // Pause interrupts the running turn and parks it: idle, turn still open.
    const parked = session({
      id: "parked",
      status: "idle",
      activeTurnId: "turn-1",
      effectiveControl: control("paused"),
    });
    expect(summarizeRailRow(row(parked))).toEqual({
      kind: "paused",
      count: 1,
      total: 1,
      label: "1 paused",
    });
  });

  test("a running chat held by its parent's pause shows paused", () => {
    const held = session({ id: "held", status: "queued", effectiveControl: control("paused") });
    expect(summarizeRailRow(row(held)).kind).toBe("paused");
  });

  test("a paused chat with nothing in progress shows no marker", () => {
    const done = session({ id: "done", status: "idle", effectiveControl: control("paused") });
    expect(summarizeRailRow(row(done)).kind).toBe("neutral");
  });

  test("a paused chat waiting for input, or ending, shows no paused marker", () => {
    const waiting = session({
      id: "waiting",
      status: "idle",
      inputWait: { deadlineAt: "2026-11-02T14:00:00.000Z", reason: "sleep" },
      effectiveControl: control("paused"),
    });
    expect(summarizeRailRow(row(waiting)).kind).not.toBe("paused");
    for (const status of ["cancelled", "failed"] as const) {
      const ending = session({
        id: status,
        status,
        activeTurnId: "turn-1",
        effectiveControl: control("paused"),
      });
      expect(summarizeRailRow(row(ending)).kind).not.toBe("paused");
    }
  });

  test("an idle parent that is not paused never shows its paused workers as its own pause", () => {
    // Its own work is done and nothing paused it; only the workers it started are paused.
    const parent = session({
      id: "owner",
      pinned: true,
      treeStats: tree({
        directChildren: 39,
        totalDescendants: 39,
        pausedDescendants: 39,
        pausedWorkDescendants: 39,
      }),
    });
    const summary = summarizeRailRow(row(parent));
    expect(summary.kind).toBe("neutral");
    const markup = renderToStaticMarkup(<RailTrailingMetadata summary={summary} />);
    expect(markup).not.toContain("data-og-rail-paused");

    const replied = session({ ...parent, unread: true });
    expect(summarizeRailRow(row(replied))).toMatchObject({ kind: "unread", label: "1 unread" });

    // Its workers' other states still surface on it, as before.
    const busy = session({
      ...parent,
      treeStats: tree({ ...parent.treeStats, runningDescendants: 1, totalDescendants: 40 }),
    });
    expect(summarizeRailRow(row(busy))).toMatchObject({ kind: "active", label: "1 working" });
    const blocked = session({
      ...parent,
      treeStats: tree({ ...parent.treeStats, attentionDescendants: 1, totalDescendants: 40 }),
    });
    expect(summarizeRailRow(row(blocked))).toMatchObject({
      kind: "needs_attention",
      label: "1 needs you",
    });
  });

  test("a paused parent shows paused while its pause holds its workers' work", () => {
    const stats = tree({
      directChildren: 2,
      totalDescendants: 2,
      pausedDescendants: 2,
      pausedWorkDescendants: 2,
    });
    const manager = session({
      id: "manager",
      effectiveControl: control("paused"),
      treeStats: stats,
    });
    expect(summarizeRailRow(row(manager))).toMatchObject({ kind: "paused", label: "2 paused" });
    // Once the workers have nothing left to resume, the parent's pause shows nothing either.
    const settled = session({
      ...manager,
      treeStats: tree({ ...stats, pausedWorkDescendants: 0 }),
    });
    expect(summarizeRailRow(row(settled)).kind).toBe("neutral");
  });

  test("a section header still says what is paused inside it", () => {
    const parent = session({
      id: "manager",
      treeStats: tree({
        directChildren: 3,
        totalDescendants: 3,
        pausedDescendants: 3,
        pausedWorkDescendants: 2,
      }),
    });
    expect(summarizeRailNodes([row(parent)])).toMatchObject({ kind: "paused", label: "2 paused" });
  });

  test("the chat's own paused turn outranks its unread reply", () => {
    const parked = session({
      id: "parked",
      unread: true,
      activeTurnId: "turn-1",
      effectiveControl: control("paused"),
    });
    expect(summarizeRailRow(row(parked)).kind).toBe("paused");
  });

  test("a pinned paused worker leaves its parent's paused count", () => {
    const worker = session({
      id: "worker",
      parentSessionId: "manager",
      pinned: true,
      activeTurnId: "turn-1",
      effectiveControl: control("paused"),
    });
    const manager = session({
      id: "manager",
      treeStats: tree({
        directChildren: 1,
        totalDescendants: 1,
        pausedDescendants: 1,
        pausedWorkDescendants: 1,
      }),
    });
    const pruned = prunePinnedSubtrees({
      session: manager,
      children: [row(worker)],
      hasActiveDescendant: false,
    });
    expect(pruned?.session.treeStats?.pausedWorkDescendants).toBe(0);
  });

  test("the marker is a still pause mark, never the spinner", () => {
    const markup = renderToStaticMarkup(
      <RailTrailingMetadata summary={{ kind: "paused", count: 1, total: 1, label: "1 paused" }} />,
    );
    expect(markup).toContain("data-og-rail-paused");
    expect(markup).not.toContain("animate-spin");
  });
});
