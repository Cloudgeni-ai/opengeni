import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import {
  automationRunOutcomesOnly,
  buildTimeline,
  groupTimeline,
} from "../src/timeline/projection";
import { readableWorkIsEmpty } from "../src/timeline/work-presentation";
import type { TimelineGroup, TimelineItem } from "../src/timeline/types";
import { createOpenGeniText } from "../src/messages/runtime";

const t = createOpenGeniText();

let sequence = 0;
function event(type: string, payload: unknown = {}, turnId: string | null = "run"): SessionEvent {
  sequence += 1;
  return {
    id: `run-${sequence}`,
    workspaceId: "ws",
    sessionId: "session",
    sequence,
    type,
    payload,
    turnId,
    occurredAt: new Date(Date.UTC(2026, 10, 5, 14) + sequence * 1000).toISOString(),
  } as SessionEvent;
}

const delivered = (turnId = "run") =>
  event(
    "system.update.delivered",
    {
      members: [
        {
          id: "update-1",
          kind: "scheduled_occurrence",
          sourceId: "task-1",
          classification: "info",
          summary: "Ticket assigned to you",
          automation: {
            name: "Ticket assigned to you",
            eventSummaries: ["T-1 Refund request"],
            eventCount: 1,
          },
        },
      ],
    },
    turnId,
  );

function run(answer: string | null, extra: SessionEvent[] = [], turnId = "run"): SessionEvent[] {
  return [
    delivered(turnId),
    event("turn.started", {}, turnId),
    event(
      "agent.toolCall.created",
      { id: `${turnId}-c`, name: "get_ticket", arguments: {} },
      turnId,
    ),
    event("agent.toolCall.output", { id: `${turnId}-c`, output: "{}" }, turnId),
    ...extra,
    ...(answer === null
      ? []
      : [
          event("agent.message.completed", { phase: "final_answer", text: answer }, turnId),
          event("turn.completed", {}, turnId),
        ]),
  ];
}

const earlier = (): SessionEvent[] => [
  event("user.message", { text: "Check T-0" }, "chat"),
  event("turn.started", {}, "chat"),
  event("agent.message.completed", { phase: "final", text: "Done." }, "chat"),
  event("turn.completed", {}, "chat"),
];

const kinds = (items: TimelineItem[]) => items.map((item) => item.kind);
const answers = (items: TimelineItem[]) =>
  items.flatMap((item) => (item.kind === "agent-message" ? [item.text] : []));
const lines = (items: TimelineItem[]) =>
  items.filter((item) => item.kind === "machine-input-batch");
/** Work rows ("Worked for 15s") as the timeline groups the turns. */
const workRows = (items: TimelineItem[]): TimelineGroup[] =>
  groupTimeline(t, items, { readableTurns: true }).filter((group) => group.kind === "activity");
/** Work rows a reader who never sees the agent's work is shown. */
const readableWorkRows = (items: TimelineItem[]): TimelineGroup[] =>
  workRows(items).filter((group) => group.kind === "activity" && !readableWorkIsEmpty(group));
const narration = () =>
  event("agent.message.completed", { phase: "commentary", text: "Checking the ticket." });

describe("an automation run in the chat", () => {
  test("a run with nothing to say is only its line", () => {
    const items = buildTimeline(t, [...earlier(), ...run("NO_REPLY", [narration()])]);
    expect(lines(items)).toHaveLength(1);
    expect(answers(items)).toEqual(["Done."]);
    expect(items.some((item) => item.kind === "tool-call")).toBe(false);
    expect(workRows(items.filter((item) => "turnId" in item && item.turnId === "run"))).toEqual([]);
  });

  test("a run with something to say is its line and its answer, without its work", () => {
    const items = buildTimeline(t, run("Contoso wants a refund.", [narration()]));
    expect(kinds(items)).toEqual(["machine-input-batch", "agent-message", "turn-end"]);
    expect(answers(items)).toEqual(["Contoso wants a refund."]);
    expect(workRows(items)).toEqual([]);
  });

  test("a run still working shows its line and no work row", () => {
    const items = buildTimeline(t, [...earlier(), ...run(null, [narration()])]);
    expect(lines(items)).toHaveLength(1);
    expect(answers(items)).toEqual(["Done."]);
    expect(workRows(items.filter((item) => "turnId" in item && item.turnId === "run"))).toEqual([]);
  });

  test("the token is never drawn, even in a turn a person started", () => {
    const items = buildTimeline(t, [
      event("user.message", { text: "Anything new?" }, "chat"),
      event("turn.started", {}, "chat"),
      event("agent.message.completed", { phase: "final", text: " no_reply " }, "chat"),
      event("turn.completed", {}, "chat"),
    ]);
    expect(answers(items)).toEqual([]);
    expect(kinds(items)).toContain("user-message");
  });

  test("an answer still streaming is held while it could become the token", () => {
    const streaming = (delta: string, phase?: string) =>
      buildTimeline(t, [
        ...run(null),
        event("agent.message.delta", { text: delta, messageId: "run-answer", phase }),
      ]);
    expect(answers(streaming("NO_", "final_answer"))).toEqual([]);
    expect(answers(streaming("Not much changed", "final_answer"))).toEqual(["Not much changed"]);
    // Until a message says it is the answer it may be narration, so a run
    // shows it once it settles.
    expect(answers(streaming("Not much changed"))).toEqual([]);
    expect(answers(streaming("Checking", "commentary"))).toEqual([]);
  });

  test("a run that asks the person something keeps the question under its line", () => {
    const items = buildTimeline(t, [
      ...run(null),
      event("session.humanInput.requested", {
        request: {
          id: "question-1",
          questions: [{ id: "q", kind: "text", label: "Close", prompt: "Close it?", options: [] }],
        },
      }),
      event("user.humanInputResponse", {
        requestId: "question-1",
        response: { outcome: "answered", answers: [{ questionId: "q", values: ["Yes"] }] },
      }),
      event("agent.message.completed", { phase: "final_answer", text: "NO_REPLY" }),
      event("turn.completed", {}),
    ]);
    expect(lines(items)).toHaveLength(1);
    expect(kinds(items)).toContain("human-input");
    expect(answers(items)).toEqual([]);
    expect(items.some((item) => item.kind === "tool-call")).toBe(false);
  });

  test("a failed run keeps its work so the failure can be read", () => {
    const items = buildTimeline(t, [...run(null), event("turn.failed", { error: "timeout" })]);
    expect(lines(items)).toHaveLength(1);
    expect(items.some((item) => item.kind === "tool-call")).toBe(true);
    expect(workRows(items).some((group) => group.kind === "activity" && group.outcome)).toBe(true);
  });

  test("turns a person started keep their steps and work row", () => {
    const items = buildTimeline(t, [
      event("user.message", { text: "Check T-2" }, "chat"),
      event("turn.started", {}, "chat"),
      event("agent.toolCall.created", { id: "c2", name: "get_ticket", arguments: {} }, "chat"),
      event("agent.toolCall.output", { id: "c2", output: "{}" }, "chat"),
      event("agent.message.completed", { phase: "final", text: "Open." }, "chat"),
      event("turn.completed", {}, "chat"),
      ...run("Contoso wants a refund."),
    ]);
    expect(items.filter((item) => item.kind === "tool-call").map((item) => item.turnId)).toEqual([
      "chat",
    ]);
    expect(workRows(items)).toHaveLength(1);
  });
});

describe("automation runs for a person who never sees the agent's work", () => {
  test("read as the timeline draws them: the line and the answer", () => {
    const built = buildTimeline(t, run("Contoso wants a refund."));
    const items = automationRunOutcomesOnly(built);
    expect(items).toBe(built);
    expect(kinds(items)).toEqual(["machine-input-batch", "agent-message", "turn-end"]);
    expect(readableWorkRows(items)).toEqual([]);
  });

  test("a failure only an operator can act on leaves only the line", () => {
    const items = automationRunOutcomesOnly(
      buildTimeline(t, [...earlier(), ...run(null), event("turn.failed", { error: "timeout" })]),
    );
    expect(lines(items)).toHaveLength(1);
    expect(items.some((item) => item.kind === "tool-call")).toBe(false);
    expect(items.some((item) => item.kind === "turn-end" && item.outcome === "failed")).toBe(false);
    expect(readableWorkRows(items)).toEqual([]);
  });

  test("leaves turns a person started as they are", () => {
    const built = buildTimeline(t, [
      event("user.message", { text: "Check T-2" }, "chat"),
      event("turn.started", {}, "chat"),
      event("agent.toolCall.created", { id: "c2", name: "get_ticket", arguments: {} }, "chat"),
      event("agent.toolCall.output", { id: "c2", output: "{}" }, "chat"),
      event("agent.message.completed", { phase: "final", text: "Open." }, "chat"),
      event("turn.failed", { error: "timeout" }, "chat"),
    ]);
    expect(automationRunOutcomesOnly(built)).toBe(built);
  });
});
