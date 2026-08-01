import { describe, expect, test } from "bun:test";
import { trailingAgentTextAfterTurn } from "../src/components/message-timeline";
import type { TimelineGroup } from "../src/timeline/types";

function turnWithActivity(turnId: string): TimelineGroup {
  return {
    kind: "turn",
    id: `turn-${turnId}`,
    outcome: "complete",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    groups: [
      {
        kind: "activity",
        id: `activity-${turnId}`,
        items: [
          {
            kind: "reasoning",
            id: `r-${turnId}`,
            turnId,
            text: "thinking",
            streaming: false,
            occurredAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    ],
  };
}

function agentMessage(turnId: string | null, text: string): TimelineGroup {
  return {
    kind: "item",
    item: {
      kind: "agent-message",
      id: `a-${text}`,
      turnId,
      text,
      streaming: false,
      occurredAt: "2026-01-01T00:00:01.000Z",
    },
  };
}

describe("trailingAgentTextAfterTurn", () => {
  test("lifts matching turnId trailing answer", () => {
    const turn = turnWithActivity("t1");
    expect(trailingAgentTextAfterTurn(turn, agentMessage("t1", "final answer"))).toBe(
      "final answer",
    );
  });

  test("does not steal the next turn's agent message", () => {
    const turn = turnWithActivity("t1");
    expect(trailingAgentTextAfterTurn(turn, agentMessage("t2", "next turn"))).toBeUndefined();
  });

  test("does not lift when the turn body has no turnIds", () => {
    const emptyTurn: TimelineGroup = {
      kind: "turn",
      id: "turn-orphan",
      outcome: "complete",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      groups: [],
    };
    expect(trailingAgentTextAfterTurn(emptyTurn, agentMessage("t1", "answer"))).toBeUndefined();
  });

  test("does not lift when trailing message has null turnId", () => {
    const turn = turnWithActivity("t1");
    expect(trailingAgentTextAfterTurn(turn, agentMessage(null, "answer"))).toBeUndefined();
  });
});
