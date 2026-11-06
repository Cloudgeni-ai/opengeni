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
          event("agent.message.completed", { phase: "final", text: answer }, turnId),
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
/** Turn rows a reader who never sees the agent's work is shown. */
const workRows = (items: TimelineItem[]): TimelineGroup[] =>
  groupTimeline(t, items, { readableTurns: true }).filter(
    (group) => group.kind === "activity" && !readableWorkIsEmpty(group),
  );

describe("automation runs with nothing for the person", () => {
  test("a run that settles with NO_REPLY leaves the chat entirely", () => {
    const items = buildTimeline(t, [...earlier(), ...run("NO_REPLY")]);
    expect(answers(items)).toEqual(["Done."]);
    expect(items.some((item) => item.kind === "machine-input-batch")).toBe(false);
    expect(items.some((item) => item.kind === "tool-call")).toBe(false);
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
    const streaming = (delta: string) =>
      buildTimeline(t, [
        ...run(null),
        event("agent.message.delta", { text: delta, messageId: "run-answer" }),
      ]);
    expect(answers(streaming("NO_"))).toEqual([]);
    expect(answers(streaming("Not much changed"))).toEqual(["Not much changed"]);
  });

  test("a run that asks the person something stays", () => {
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
      event("agent.message.completed", { phase: "final", text: "NO_REPLY" }),
      event("turn.completed", {}),
    ]);
    expect(kinds(items)).toContain("machine-input-batch");
    expect(answers(items)).toEqual([]);
  });

  test("a useful answer stays with its line", () => {
    const items = buildTimeline(t, run("Contoso wants a refund."));
    expect(kinds(items)).toContain("machine-input-batch");
    expect(answers(items)).toEqual(["Contoso wants a refund."]);
  });
});

describe("automation runs for a person who never sees the agent's work", () => {
  test("keeps the line and the answer, without steps or a work row", () => {
    const items = automationRunOutcomesOnly(buildTimeline(t, run("Contoso wants a refund.")));
    expect(kinds(items)).toContain("machine-input-batch");
    expect(items.some((item) => item.kind === "tool-call")).toBe(false);
    expect(answers(items)).toEqual(["Contoso wants a refund."]);
    expect(workRows(items)).toEqual([]);
  });

  test("a run still working shows nothing yet", () => {
    const items = automationRunOutcomesOnly(buildTimeline(t, [...earlier(), ...run(null)]));
    expect(items.some((item) => item.kind === "machine-input-batch")).toBe(false);
    expect(items.some((item) => item.kind === "tool-call")).toBe(false);
    expect(answers(items)).toEqual(["Done."]);
  });

  test("a failure only an operator can act on draws nothing", () => {
    const items = automationRunOutcomesOnly(
      buildTimeline(t, [...earlier(), ...run(null), event("turn.failed", { error: "timeout" })]),
    );
    expect(items.some((item) => item.kind === "machine-input-batch")).toBe(false);
    expect(items.some((item) => item.kind === "turn-end" && item.outcome === "failed")).toBe(false);
    expect(workRows(items)).toEqual([]);
  });

  test("leaves turns a person started as they are", () => {
    const built = buildTimeline(t, [
      event("user.message", { text: "Check T-2" }, "chat"),
      event("turn.started", {}, "chat"),
      event("agent.toolCall.created", { id: "c2", name: "get_ticket", arguments: {} }, "chat"),
      event("agent.toolCall.output", { id: "c2", output: "{}" }, "chat"),
      event("agent.message.completed", { phase: "final", text: "Open." }, "chat"),
      event("turn.completed", {}, "chat"),
    ]);
    expect(automationRunOutcomesOnly(built)).toBe(built);
  });
});
