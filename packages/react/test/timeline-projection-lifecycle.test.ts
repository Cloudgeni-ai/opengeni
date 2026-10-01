import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline } from "../src/timeline/projection";
import type { TimelineGroup } from "../src/timeline/types";

function event(
  sequence: number,
  type: string,
  payload: unknown = {},
  turnId = "turn-1",
): SessionEvent {
  return {
    id: `lifecycle-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(Date.UTC(2026, 8, 30) + sequence * 1000).toISOString(),
  };
}
const fold = (events: SessionEvent[]) =>
  groupTimeline(buildTimeline(events), { readableTurns: true });
const work = (groups: TimelineGroup[]) => groups.filter((group) => group.kind === "activity");
const prose = (groups: TimelineGroup[]) =>
  groups.flatMap((group) =>
    group.kind === "item" && group.item.kind === "agent-message" ? [group.item.text] : [],
  );

describe("projection lifecycle audit regressions", () => {
  for (const newerTurn of [false, true]) {
    test(`a late final-only receipt cannot create live old work (newer turn=${newerTurn})`, () => {
      const events = [
        event(1, "agent.message.completed", {
          messageId: "first",
          phase: "final_answer",
          text: "Original final",
        }),
        event(2, "turn.completed"),
        ...(newerTurn
          ? [event(3, "agent.message.delta", { messageId: "next", text: "New work" }, "turn-2")]
          : []),
        event(4, "agent.message.completed", {
          messageId: "late",
          phase: "final_answer",
          text: "Late final",
        }),
      ];
      const groups = fold(events);
      expect(work(groups).map((group) => group.id)).toEqual(newerTurn ? ["work-turn-2"] : []);
      if (newerTurn) expect(work(groups)[0]!.work!.endedAt).toBeUndefined();
      expect(prose(groups)).toEqual(
        newerTurn ? ["Original final", "New work", "Late final"] : ["Original final", "Late final"],
      );
    });
  }

  test("a seen final-only turn cannot settle its successor even without the old end receipt", () => {
    const groups = fold([
      event(1, "agent.message.completed", {
        messageId: "first",
        phase: "final_answer",
        text: "Original final",
      }),
      event(3, "agent.message.delta", { messageId: "next", text: "New work" }, "turn-2"),
      event(4, "agent.message.completed", {
        messageId: "late",
        phase: "final_answer",
        text: "Late final",
      }),
    ]);
    expect(work(groups).map((group) => group.id)).toEqual(["work-turn-2"]);
    expect(work(groups)[0]!.work!.endedAt).toBeUndefined();
  });

  test("startup details cannot coalesce across intervening folded prose", () => {
    const groups = fold([
      event(1, "turn.startup.phase.completed", { phase: "tools", durationMs: 200 }),
      event(2, "agent.message.completed", {
        messageId: "progress",
        phase: "commentary",
        text: "Tools ready",
      }),
      event(3, "turn.startup.phase.completed", { phase: "model_preparation", durationMs: 300 }),
      event(4, "agent.message.completed", {
        messageId: "final",
        phase: "final_answer",
        text: "Ready",
      }),
      event(5, "turn.completed"),
    ]);
    const details = work(groups)[0]!.work!.details.flatMap((group) =>
      group.kind === "activity"
        ? group.items.map((item) => item.id)
        : group.kind === "item"
          ? [group.item.id]
          : [],
    );
    expect(details).toEqual(["lifecycle-1", "lifecycle-2", "lifecycle-3"]);
  });

  test("Steer supersession settles the old turn before its replacement starts", () => {
    const superseded = event(4, "turn.superseded", { reason: "steer" });
    const events = [
      event(1, "turn.started"),
      event(2, "agent.message.completed", { messageId: "before", text: "Checking" }),
      event(3, "agent.toolCall.created", { id: "read", name: "exec_command", arguments: {} }),
      superseded,
    ];
    const groups = fold(events);
    expect(work(groups)[0]!.work!.endedAt).toBe(superseded.occurredAt);
    expect(work(groups)[0]!.outcome).toBe("cancelled");
    expect(work(groups)[0]!.items[0]).toMatchObject({ kind: "tool-call", status: "cancelled" });
    const replacement = fold([
      ...events,
      event(8, "turn.started", {}, "turn-2"),
      event(9, "agent.message.delta", { messageId: "next", text: "Revised check" }, "turn-2"),
    ]);
    expect(work(replacement)[0]!.work!.endedAt).toBe(superseded.occurredAt);
    expect(work(replacement)[1]!.work!.endedAt).toBeUndefined();
  });

  test("human Retry reopens the failed logical turn without prematurely folding its progress", () => {
    const failed = [
      event(1, "agent.message.completed", { messageId: "before", text: "Checking records" }),
      event(2, "agent.toolCall.created", { id: "read", name: "exec_command", arguments: {} }),
      event(3, "turn.failed", { error: "Provider unavailable" }),
      event(4, "session.status.changed", { status: "failed" }),
    ];
    expect(work(fold(failed))[0]!.outcome).toBe("failed");
    const recovering = [
      ...failed,
      event(5, "turn.recovery.requested", { reason: "human_retry", failureEventId: failed[2]!.id }),
      event(6, "session.status.changed", { status: "recovering" }),
    ];
    const resumed = [
      ...recovering,
      event(7, "turn.started"),
      event(8, "session.status.changed", { status: "running" }),
      event(9, "agent.message.delta", { messageId: "after", text: "Retrying the check" }),
    ];
    for (const events of [recovering, resumed]) {
      const groups = fold(events);
      expect(work(groups)).toHaveLength(1);
      expect(work(groups)[0]!.work!.endedAt).toBeUndefined();
      expect(work(groups)[0]!.outcome).toBeUndefined();
      expect(groups.at(-1)?.kind).toBe("activity");
    }
    expect(prose(fold(resumed))).toEqual(["Checking records", "Retrying the check"]);
    const completed = fold([
      ...resumed,
      event(10, "agent.message.completed", {
        messageId: "final",
        phase: "final_answer",
        text: "Verified",
      }),
      event(11, "turn.completed"),
    ]);
    expect(prose(completed)).toEqual(["Verified"]);
    expect(work(completed)[0]!.outcome).toBe("complete");
    expect(
      work(completed)[0]!.work!.details.some(
        (group) =>
          group.kind === "item" &&
          group.item.kind === "notice" &&
          group.item.text === "Provider unavailable",
      ),
    ).toBe(true);
  });

  test("foreign, duplicate and late recovery receipts cannot reopen another failed turn", () => {
    const failed = [
      event(1, "agent.message.completed", { messageId: "before", text: "Checking" }),
      event(2, "turn.failed", { error: "Unavailable" }),
      event(3, "session.status.changed", { status: "failed" }),
    ];
    for (const retry of [
      event(4, "turn.recovery.requested", { reason: "human_retry" }, "other-turn"),
      {
        ...event(4, "turn.recovery.requested", { reason: "human_retry" }),
        duplicateOfEventId: "prior",
      },
      {
        ...event(4, "turn.recovery.requested", { reason: "human_retry" }),
        turnAssociation: "late_rejected" as const,
      },
    ]) {
      const groups = fold([...failed, retry]);
      expect(work(groups)[0]!.outcome).toBe("failed");
      expect(work(groups)[0]!.work!.endedAt).toBe(failed[1]!.occurredAt);
    }
  });

  test("settled final-only corrections fold the superseded final, without an empty single-final row", () => {
    const first = event(1, "agent.message.completed", {
      messageId: "first",
      phase: "final_answer",
      text: "First result",
    });
    const corrected = event(2, "agent.message.completed", {
      messageId: "corrected",
      phase: "final_answer",
      text: "Corrected result",
    });
    expect(work(fold([first, event(3, "turn.completed")]))).toHaveLength(0);
    expect(prose(fold([first, corrected]))).toEqual(["First result", "Corrected result"]);
    const settled = fold([first, corrected, event(3, "turn.completed")]);
    expect(prose(settled)).toEqual(["Corrected result"]);
    expect(work(settled)).toHaveLength(1);
    expect(prose(work(settled)[0]!.work!.details)).toEqual(["First result"]);
  });

  test("a duration-only startup receipt extends the work clock to the earliest known start", () => {
    const groups = fold([
      event(10, "agent.reasoning.delta", { text: "Preparing" }),
      event(12, "turn.startup.phase.completed", { phase: "tools", durationMs: 10000 }),
    ]);
    expect(work(groups)[0]!.work!.startedAt).toBe(event(2, "unused").occurredAt);
  });

  test("same-turn prose after a steer still precedes the single live work tail", () => {
    const groups = fold([
      event(1, "agent.message.completed", { messageId: "first", text: "Checking" }),
      event(2, "user.message", {
        text: "Also check yesterday",
        delivery: "steer",
        routing: "accepted_for_steering",
      }),
      event(3, "agent.message.delta", { messageId: "second", text: "Checking yesterday" }),
    ]);
    expect(prose(groups)).toEqual(["Checking", "Checking yesterday"]);
    expect(work(groups)).toHaveLength(1);
    expect(groups.at(-1)?.kind).toBe("activity");
    expect(work(groups)[0]!.work!.endedAt).toBeUndefined();
  });
});
