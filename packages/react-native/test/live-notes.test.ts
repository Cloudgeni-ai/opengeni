import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline, type TimelineGroup } from "@opengeni/react/session";
import { collectLiveNotes, foldedLiveNotes, liveFoldShift } from "../src/timeline/live-notes";

let sequence = 0;

function event(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `live-note-evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(Date.UTC(2026, 0, 5, 9, 0, 0) + sequence * 5_000).toISOString(),
    turnId,
  };
}

function tool(id: string, turnId = "turn-1"): SessionEvent[] {
  return [
    event("agent.toolCall.created", { id, name: "exec_command", arguments: {} }, turnId),
    event("agent.toolCall.output", { id, output: "ok" }, turnId),
  ];
}

function note(text: string, messageId: string, turnId = "turn-1"): SessionEvent[] {
  return [
    event("agent.message.delta", { text, phase: "commentary", messageId }, turnId),
    event("agent.message.completed", { text, phase: "commentary", messageId }, turnId),
  ];
}

function liveTurn(): TimelineGroup[] {
  return groupTimeline(buildTimeline(liveTurnEvents()), { readableTurns: true });
}

function workId(groups: TimelineGroup[]): string {
  for (const group of groups) if (group.kind === "activity" && group.work) return group.id;
  throw new Error("expected a live work row");
}

function noteIds(groups: TimelineGroup[]): string[] {
  return groups.flatMap((group) =>
    group.kind === "item" && group.item.kind === "agent-message" ? [group.item.id] : [],
  );
}

describe("live progress notes", () => {
  test("a live note shows above a closed work row and folds while the row is open", () => {
    const groups = liveTurn();
    const live = collectLiveNotes(groups);
    const ids = noteIds(groups);
    expect(ids).toHaveLength(1);
    expect([...live.notes]).toEqual(ids);
    expect(foldedLiveNotes(live, new Set()).size).toBe(0);
    expect([...foldedLiveNotes(live, new Set([workId(groups)]))]).toEqual(ids);
  });

  test("opening moves the offset up by the folded rows; closing moves it back", () => {
    const groups = liveTurn();
    const live = collectLiveNotes(groups);
    const heights = new Map(noteIds(groups).map((id) => [id, 48]));
    expect(liveFoldShift(live, workId(groups), true, heights, 20)).toBe(-68);
    expect(liveFoldShift(live, workId(groups), false, heights, 20)).toBe(68);
    // A note that has not laid out yet owes nothing.
    expect(liveFoldShift(live, workId(groups), true, new Map(), 20)).toBe(0);
  });

  test("a settled turn has no live notes to fold", () => {
    const groups = groupTimeline(
      buildTimeline([...liveTurnEvents(), event("turn.completed", { output: "" }, "turn-1")]),
      { readableTurns: true },
    );
    expect(collectLiveNotes(groups).notes.size).toBe(0);
  });
});

function liveTurnEvents(): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Check every checklist" }, null),
    event("turn.started", {}, "turn-1"),
    ...tool("search"),
    ...note("Found the checklists. Going through them now.", "note-1"),
    ...tool("tree"),
  ];
}
