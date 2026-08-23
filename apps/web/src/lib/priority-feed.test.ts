import { describe, expect, test } from "bun:test";

import { buildPriorityFeed, formatAgentMinutes } from "./priority-feed";
import type { Session, SessionStatus } from "../types";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function session(
  patch: Partial<Session> & Pick<Session, "id" | "status">, // status is the tier driver
): Session {
  return {
    accountId: "account-1",
    workspaceId: "workspace-1",
    initialMessage: "hi",
    title: null,
    parentSessionId: null,
    channelId: null,
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    createdBy: { kind: "subject", subjectId: "user:test" },
    effectiveControl: {
      state: "active",
      controlVersion: 0,
      controlEtag: "active-0",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(0),
    ...patch,
  } as Session;
}

function stats(patch: Partial<NonNullable<Session["treeStats"]>>) {
  return {
    directChildren: 0,
    totalDescendants: 0,
    runningDescendants: 0,
    queuedDescendants: 0,
    attentionDescendants: 0,
    pausedDescendants: 0,
    failedDescendants: 0,
    truncated: false,
    ...patch,
  };
}

describe("buildPriorityFeed", () => {
  test("tiers by status and ranks blocked work by agent-minutes lost", () => {
    const feed = buildPriorityFeed(
      [
        // 1 waiting turn × 60 m = 60 agent-minutes.
        session({ id: "s-old", status: "requires_action", updatedAt: minutesAgo(60) }),
        // 5 waiting turns × 25 m = 125 agent-minutes: outranks the older wait.
        session({
          id: "s-hot",
          status: "requires_action",
          updatedAt: minutesAgo(25),
          treeStats: stats({ attentionDescendants: 4, totalDescendants: 6 }),
        }),
        session({ id: "s-failed", status: "failed", updatedAt: minutesAgo(11) }),
        session({ id: "s-capacity", status: "waiting_capacity", updatedAt: minutesAgo(20) }),
        session({ id: "s-done", status: "idle", updatedAt: minutesAgo(90) }),
      ],
      NOW,
    );

    expect(feed.blocked.map((entry) => entry.session.id)).toEqual(["s-hot", "s-old"]);
    expect(feed.blocked[0]!.costMinutes).toBe(125);
    expect(feed.blocked[0]!.waitingAgents).toBe(5);
    // Ranks run sequentially across blocked, broken, finished.
    expect(feed.blocked.map((entry) => entry.rank)).toEqual([1, 2]);
    expect(feed.broken[0]!.rank).toBe(3);
    expect(feed.finished[0]!.rank).toBe(4);
    // Waits stay unranked; the badge counts only blocked + broken.
    expect(feed.waiting[0]!.rank).toBeNull();
    expect(feed.needsYou).toBe(3);
  });

  test("an idle manager with blocked children is blocked work, not healthy", () => {
    const feed = buildPriorityFeed(
      [
        session({
          id: "s-mgr",
          status: "idle",
          updatedAt: minutesAgo(30),
          treeStats: stats({
            attentionDescendants: 2,
            runningDescendants: 3,
            totalDescendants: 10,
          }),
        }),
      ],
      NOW,
    );
    expect(feed.blocked.map((entry) => entry.session.id)).toEqual(["s-mgr"]);
    expect(feed.blocked[0]!.waitingAgents).toBe(2);
    expect(feed.blocked[0]!.reason).toBe("2 spawned agents need you");
    expect(feed.healthy.workstreams).toBe(0);
    expect(feed.needsYou).toBe(1);
  });

  test("healthy trees collapse to counts and never rank", () => {
    const feed = buildPriorityFeed(
      [
        session({ id: "s-run", status: "running" }),
        // Idle root whose descendants are still live counts as healthy, not finished.
        session({
          id: "s-manager",
          status: "idle",
          treeStats: stats({ runningDescendants: 12, totalDescendants: 71 }),
        }),
        session({ id: "s-cancelled", status: "cancelled" }),
      ],
      NOW,
    );
    expect(feed.healthy).toEqual({ workstreams: 2, agents: 73 });
    expect(feed.blocked).toEqual([]);
    expect(feed.finished).toEqual([]);
    // Cancelled is deliberate terminal state: absent everywhere.
    expect(feed.waiting).toEqual([]);
    expect(feed.needsYou).toBe(0);
  });

  test("ignores child rows and orders finished newest-first", () => {
    const feed = buildPriorityFeed(
      [
        session({ id: "child", status: "failed", parentSessionId: "root" }),
        session({ id: "f-older", status: "idle", updatedAt: minutesAgo(600) }),
        session({ id: "f-newer", status: "idle", updatedAt: minutesAgo(30) }),
      ],
      NOW,
    );
    expect(feed.broken).toEqual([]);
    expect(feed.finished.map((entry) => entry.session.id)).toEqual(["f-newer", "f-older"]);
  });

  test("caps the finished tier", () => {
    const feed = buildPriorityFeed(
      Array.from({ length: 12 }, (_, index) =>
        session({
          id: `f-${index}`,
          status: "idle" as SessionStatus,
          updatedAt: minutesAgo(index + 1),
        }),
      ),
      NOW,
    );
    expect(feed.finished).toHaveLength(8);
  });
});

describe("formatAgentMinutes", () => {
  test("reads like a ledger", () => {
    expect(formatAgentMinutes(0)).toBe("<1 m");
    expect(formatAgentMinutes(25)).toBe("25 m");
    expect(formatAgentMinutes(100)).toBe("1 h 40 m");
    expect(formatAgentMinutes(120)).toBe("2 h");
    expect(formatAgentMinutes(50 * 60)).toBe("2 d 2 h");
  });
});

describe("buildPriorityFeed waiting duration", () => {
  test("says how long blocked agents have waited for a human", () => {
    const feed = buildPriorityFeed(
      [
        session({
          id: "s-mgr",
          status: "idle",
          updatedAt: minutesAgo(30),
          treeStats: stats({
            attentionDescendants: 3,
            totalDescendants: 6,
            attentionSince: minutesAgo(10 * 60 + 5),
          }),
        }),
        session({
          id: "s-own",
          status: "requires_action",
          updatedAt: minutesAgo(5),
          requiresActionSince: minutesAgo(95),
        }),
      ],
      NOW,
    );
    const byId = new Map(feed.blocked.map((entry) => [entry.session.id, entry]));
    expect(byId.get("s-mgr")?.reason).toBe("3 spawned agents need you for 10 h 5 m");
    expect(byId.get("s-own")?.reason).toMatch(/ for 1 h 35 m$/);
  });

  test("keeps the plain wording when the server reports no waiting timestamp", () => {
    const feed = buildPriorityFeed(
      [
        session({
          id: "s-mgr",
          status: "idle",
          updatedAt: minutesAgo(30),
          treeStats: stats({ attentionDescendants: 1, totalDescendants: 2 }),
        }),
      ],
      NOW,
    );
    expect(feed.blocked[0]!.reason).toBe("1 spawned agent needs you");
  });
});
