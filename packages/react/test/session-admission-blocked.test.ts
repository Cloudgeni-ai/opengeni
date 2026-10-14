import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { recentSessionStatus } from "../src/session-list-model";
import {
  SESSION_STATUS_PRESENTATION,
  sessionAdmissionBlocked,
  sessionDisplayStatus,
} from "../src/session-status-model";
import { buildTimeline, groupTimeline } from "../src/timeline/projection";
import type { SessionStatusItem } from "../src/timeline/types";

const block = {
  reason: "database_claim_rejected",
  sqlState: "42501",
  retryPolicy: "explicit_recheck",
  blockedAt: "2026-09-30T00:00:00.000Z",
} as const;

function event(
  sequence: number,
  type: string,
  payload: unknown = {},
  turnId: string | null = "turn-1",
): SessionEvent {
  return {
    id: `blocked-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(Date.UTC(2026, 8, 30) + sequence * 1000).toISOString(),
  } as SessionEvent;
}

const statuses = (events: SessionEvent[]) =>
  buildTimeline(events).filter((item): item is SessionStatusItem => item.kind === "session-status");

describe("admission-blocked sessions", () => {
  test("read as stuck, not as waiting on the person", () => {
    expect(
      sessionDisplayStatus({
        status: "requires_action",
        admissionBlock: block,
      }),
    ).toBe("blocked");
    expect(SESSION_STATUS_PRESENTATION.blocked.label).toBe("Stuck");
    expect(SESSION_STATUS_PRESENTATION.blocked.tone).toBe("failed");
    expect(recentSessionStatus({ status: "requires_action", admissionBlock: block })).toEqual({
      tone: "failed",
      pulse: false,
    });
  });

  test("a real request, an absent block or another status keeps its own presentation", () => {
    expect(sessionDisplayStatus({ status: "requires_action", admissionBlock: null })).toBe(
      "requires_action",
    );
    expect(sessionDisplayStatus({ status: "requires_action" })).toBe("requires_action");
    // A stale block on a session that moved on never relabels it.
    expect(sessionAdmissionBlocked({ status: "running", admissionBlock: block })).toBe(false);
    expect(sessionDisplayStatus({ status: "idle", admissionBlock: block })).toBe("idle");
  });

  test("the timeline divider is a stuck marker that never becomes the turn's wait", () => {
    const events = [
      event(1, "agent.message.completed", {
        messageId: "m",
        phase: "final_answer",
        text: "Done",
      }),
      event(2, "turn.completed"),
      event(
        3,
        "session.status.changed",
        {
          status: "requires_action",
          code: "admission_blocked",
          admissionBlock: block,
        },
        null,
      ),
    ];
    const [divider] = statuses(events);
    expect(divider).toMatchObject({ status: "requires_action", blocked: true });
    expect(divider!.resolvedAt).toBeUndefined();
    const groups = groupTimeline(buildTimeline(events), {
      readableTurns: true,
    });
    for (const group of groups) {
      if (group.kind === "activity") expect(group.work?.waiting?.label).not.toBe("Waiting for you");
    }
    expect(
      groups.some((group) => group.kind === "item" && group.item.kind === "session-status"),
    ).toBe(true);
  });

  test("the next status change resolves the stuck divider, even in another turn", () => {
    const [divider] = statuses([
      event(
        1,
        "session.status.changed",
        {
          status: "requires_action",
          code: "admission_blocked",
          admissionBlock: block,
        },
        null,
      ),
      event(2, "session.status.changed", { status: "running" }, "turn-2"),
    ]);
    expect(divider!.blocked).toBe(true);
    expect(divider!.resolvedAt).toBe(new Date(Date.UTC(2026, 8, 30) + 2000).toISOString());
  });

  test("a person's request after a block gets its own waiting divider", () => {
    const items = statuses([
      event(
        1,
        "session.status.changed",
        {
          status: "requires_action",
          code: "admission_blocked",
          admissionBlock: block,
        },
        null,
      ),
      event(2, "session.status.changed", { status: "requires_action" }, "turn-2"),
    ]);
    expect(items.map((item) => Boolean(item.blocked))).toEqual([true, false]);
    expect(items[0]!.resolvedAt).toBeDefined();
  });
});
