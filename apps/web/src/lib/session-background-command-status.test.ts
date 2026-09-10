import { describe, expect, test } from "bun:test";
import type { Session } from "@/types";

import { sessionStateLabel, sessionWaitLabel } from "./session-rail";
import { groupSessionsForRail, summarizeRailNodes, prunePinnedSubtrees } from "./sessions-group";

function session(
  id: string,
  backgroundCommandActivity?: Session["backgroundCommandActivity"],
): Session {
  return {
    id,
    status: "idle",
    backgroundCommandActivity,
    effectiveControl: { state: "active" },
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  } as Session;
}

describe("session background command rail status", () => {
  test("unavailable observations never claim those commands are running", () => {
    expect(
      sessionStateLabel(session("unknown", { state: "running", count: 1, unavailableCount: 1 })),
    ).toBe("Command status unavailable");
    expect(
      sessionStateLabel(session("mixed", { state: "running", count: 3, unavailableCount: 2 })),
    ).toBe("1 other active background command · 2 command statuses unavailable");
    expect(
      sessionStateLabel(session("stopping", { state: "stopping", count: 1, unavailableCount: 1 })),
    ).toBe("Stop requested · Command status unavailable");
  });
  test("an idle session with a running command is grouped as active", () => {
    const active = session("active", { state: "running", count: 1 });
    const idle = session("idle");
    const grouped = groupSessionsForRail([idle, active], new Date("2026-08-23T12:00:00.000Z"));
    expect(grouped.running.map((row) => row.id)).toEqual(["active"]);
    expect(sessionStateLabel(active)).toBe("Background command running");
    expect(
      summarizeRailNodes([{ session: active, children: [], hasActiveDescendant: false }]),
    ).toEqual({ kind: "active", count: 1, total: 1, label: "1 working" });
  });

  test("stopping takes precedence over the idle turn lifecycle", () => {
    const stopping = session("stopping", { state: "stopping", count: 2 });
    expect(sessionStateLabel(stopping)).toBe("Stopping 2 background commands…");
  });
});

describe("durable session waits in the rail", () => {
  const waiting = () => ({
    ...session("waiting"),
    unread: true,
    inputWait: { deadlineAt: "2099-09-08T14:00:00Z", reason: "Awaiting CI" },
  });
  test("waiting work takes precedence over unread without changing personal acknowledgment", () => {
    const value = waiting();
    expect(groupSessionsForRail([value]).running.map((row) => row.id)).toEqual(["waiting"]);
    expect(
      summarizeRailNodes([{ session: value, children: [], hasActiveDescendant: false }]),
    ).toMatchObject({ kind: "active", label: "1 working" });
    expect(value.unread).toBe(true);
    expect(sessionStateLabel(value)).toStartWith("Waiting · ");
  });
  test("an elapsed deadline says due rather than claiming a turn is running", () => {
    expect(sessionWaitLabel("2026-09-08T14:00:00Z", Date.parse("2026-09-08T14:01:00Z"))).toBe(
      "Waiting · recheck due",
    );
  });
  test("superseded, failed and paused waits are not counted as ongoing", () => {
    for (const value of [
      { ...waiting(), inputWait: null },
      { ...waiting(), status: "failed" as const },
      { ...waiting(), effectiveControl: { state: "paused" } as Session["effectiveControl"] },
    ]) {
      expect(groupSessionsForRail([value]).running).toHaveLength(0);
      expect(sessionStateLabel(value)).not.toStartWith("Waiting");
    }
  });
  test("unloaded waiting children keep their collapsed parent working", () => {
    const parent = {
      ...session("parent"),
      treeStats: {
        directChildren: 1,
        totalDescendants: 1,
        runningDescendants: 0,
        queuedDescendants: 0,
        waitingDescendants: 1,
        attentionDescendants: 0,
        pausedDescendants: 0,
        failedDescendants: 0,
        truncated: false,
      },
    };
    expect(
      summarizeRailNodes([{ session: parent, children: [], hasActiveDescendant: true }]),
    ).toMatchObject({ kind: "active", count: 1 });
  });
});

test("a pinned waiting subtree is subtracted from the ordinary parent's aggregate", () => {
  const child = {
    ...session("child"),
    pinned: true,
    inputWait: { deadlineAt: "2099-09-08T14:00:00Z", reason: "CI" },
  };
  const parent = {
    ...session("parent"),
    treeStats: {
      directChildren: 1,
      totalDescendants: 1,
      runningDescendants: 0,
      queuedDescendants: 0,
      waitingDescendants: 1,
      attentionDescendants: 0,
      pausedDescendants: 0,
      failedDescendants: 0,
      truncated: false,
    },
  };
  const root = prunePinnedSubtrees({
    session: parent,
    children: [{ session: child, children: [], hasActiveDescendant: false }],
    hasActiveDescendant: true,
  });
  expect(root?.session.treeStats?.waitingDescendants).toBe(0);
  expect(summarizeRailNodes(root ? [root] : []).kind).toBe("neutral");
});
