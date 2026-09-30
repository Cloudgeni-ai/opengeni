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
