import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline, type TimelineGroup } from "../src/timeline";
import { createOpenGeniText } from "../src/messages/runtime";

const englishText = createOpenGeniText();

let sequence = 0;

function event(type: string, payload: unknown, turnId = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(Date.UTC(2026, 10, 8, 14, 0, 0) + sequence * 1000).toISOString(),
    turnId,
  };
}

function tool(id: string): SessionEvent[] {
  return [
    event("agent.toolCall.created", { id, name: "create_item", arguments: {} }),
    event("agent.toolCall.output", { id, output: "ok" }),
  ];
}

function message(text: string, phase: "commentary" | "final_answer"): SessionEvent[] {
  return [
    event("agent.message.delta", { text, phase }),
    event("agent.message.completed", { text, phase }),
  ];
}

/** A long turn from a model that writes "\n\n" around every tool call. */
function blankHeavyTurn(steps: number, settled: boolean): SessionEvent[] {
  const events: SessionEvent[] = [
    event("user.message", { text: "Build the estimate" }, null as unknown as string),
    ...message("Building it part by part.", "commentary"),
  ];
  for (let index = 0; index < steps; index += 1) {
    events.push(...message("\n\n", "commentary"), ...tool(`call-${index}`));
  }
  if (settled) {
    events.push(...message("Done.", "final_answer"), event("turn.completed", { output: "Done." }));
  }
  return events;
}

function blankRows(groups: TimelineGroup[]): TimelineGroup[] {
  return groups.filter(
    (group) =>
      group.kind === "item" && group.item.kind === "agent-message" && !group.item.text.trim(),
  );
}

describe("whitespace-only assistant messages", () => {
  for (const settled of [false, true]) {
    const state = settled ? "settled" : "live";

    test(`never become rows in a ${state} readable turn`, () => {
      const items = buildTimeline(englishText, blankHeavyTurn(30, settled));
      const groups = groupTimeline(englishText, items, { readableTurns: true });
      expect(blankRows(groups)).toEqual([]);
      const prose = groups.filter(
        (group) => group.kind === "item" && group.item.kind === "agent-message",
      );
      expect(prose.length).toBeGreaterThan(0);
    });

    test(`never become rows or split work in a ${state} flat timeline`, () => {
      const items = buildTimeline(englishText, blankHeavyTurn(30, settled));
      const groups = groupTimeline(englishText, items);
      expect(blankRows(groups)).toEqual([]);
      // Settling folds the work away; while live, the steps stay one run.
      if (!settled) expect(groups.filter((group) => group.kind === "activity")).toHaveLength(1);
    });
  }

  test("a streaming message appears once it has text", () => {
    const events = blankHeavyTurn(2, false);
    events.push(event("agent.message.delta", { text: "\n\n", phase: "commentary" }));
    const before = groupTimeline(englishText, buildTimeline(englishText, events), {
      readableTurns: true,
    });
    expect(blankRows(before)).toEqual([]);
    events.push(event("agent.message.delta", { text: "Now the roof.", phase: "commentary" }));
    const after = groupTimeline(englishText, buildTimeline(englishText, events), {
      readableTurns: true,
    });
    expect(
      after.some(
        (group) =>
          group.kind === "item" &&
          group.item.kind === "agent-message" &&
          group.item.text.includes("Now the roof."),
      ),
    ).toBe(true);
  });
});
