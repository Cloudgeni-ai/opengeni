import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import {
  buildTimeline,
  groupTimeline,
  type AgentMessageItem,
  type NoticeItem,
  type TimelineGroup,
} from "../src/timeline";

let sequence = 0;

function event(
  type: string,
  payload: unknown,
  options: { turnId?: string | null } = {},
): SessionEvent {
  sequence += 1;
  return {
    id: `evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(Date.UTC(2026, 8, 26, 7, 51, 20) + sequence * 1000).toISOString(),
    turnId: options.turnId === undefined ? "turn-1" : options.turnId,
  };
}

function tool(id: string, name: string, turnId: string, output: unknown = "ok"): SessionEvent[] {
  return [
    event("agent.toolCall.created", { id, name, arguments: {} }, { turnId }),
    event("agent.toolCall.output", { id, output }, { turnId }),
  ];
}

/**
 * A progress note as recorded today: streamed deltas without a completion or
 * phase. The completion carries a phase only when the provider declared one.
 */
function note(text: string, turnId: string, phase?: "commentary") {
  return [
    event("agent.message.delta", { text }, { turnId }),
    ...(phase ? [event("agent.message.completed", { text, phase }, { turnId })] : []),
  ];
}

function answer(text: string, turnId: string, phase?: "final_answer") {
  return [
    event("agent.message.delta", { text }, { turnId }),
    event("agent.message.completed", { text, ...(phase ? { phase } : {}) }, { turnId }),
  ];
}

function kinds(groups: TimelineGroup[]): string[] {
  return groups.map((group) => (group.kind === "item" ? group.item.kind : group.kind));
}

function fold(events: SessionEvent[]): TimelineGroup[] {
  return groupTimeline(buildTimeline(events), { foldExchanges: true });
}

/** Rows a reader sees between the prompt and the answer. */
function rowsBetweenPromptAndAnswer(groups: TimelineGroup[]): number {
  const prompt = groups.findIndex(
    (group) => group.kind === "item" && group.item.kind === "user-message",
  );
  let answerIndex = groups.length;
  for (let index = groups.length - 1; index > prompt; index -= 1) {
    const group = groups[index];
    if (group?.kind === "item" && group.item.kind === "agent-message") {
      answerIndex = index;
      break;
    }
  }
  return answerIndex - prompt - 1;
}

/**
 * The delegated "check users" exchange from the latency study: a preamble, a
 * worker spawn and polling, a still-running note, a recorded wait, the child
 * result, and a second turn that writes the answer.
 */
function delegatedExchange() {
  sequence = 0;
  const prompt = event(
    "user.message",
    { text: "check users last 48 hours", routing: "accepted_for_execution" },
    { turnId: null },
  );
  const first = [
    event("turn.started", { triggerEventId: prompt.id }, { turnId: "turn-1" }),
    ...note("I'll run the replica check in a worker.", "turn-1"),
    ...tool("skill", "skill_read", "turn-1"),
    event(
      "agent.toolCall.created",
      { id: "spawn", name: "opengeni__session_create", arguments: { initialMessage: "Count" } },
      { turnId: "turn-1" },
    ),
    event(
      "agent.toolCall.output",
      { id: "spawn", output: { sessionId: "8a5b0c2e-1111-4222-8333-944455556666" } },
      { turnId: "turn-1" },
    ),
    ...tool("wait-1", "opengeni__session_wait", "turn-1"),
    ...tool("get-1", "opengeni__session_get", "turn-1"),
    ...note("The worker is still running; I'll wait for its result.", "turn-1"),
    event(
      "agent.toolCall.created",
      { id: "park", name: "wait_for_input", arguments: { reason: "worker running" } },
      { turnId: "turn-1" },
    ),
    event(
      "session.wait.started",
      { actor: "agent", reason: "Waiting for the replica worker.", waitTurnId: "turn-1" },
      { turnId: "turn-1" },
    ),
    event(
      "agent.toolCall.output",
      { id: "park", output: { status: "waiting_for_input" } },
      { turnId: "turn-1" },
    ),
    // Recorded waits end their turn without a final output.
    event("turn.completed", { output: "" }, { turnId: "turn-1" }),
  ];
  const result = event(
    "system.update.delivered",
    {
      members: [
        {
          id: "update-1",
          kind: "child_terminal_result",
          classification: "success",
          sourceId: "8a5b0c2e-1111-4222-8333-944455556666",
          summary: "A worker session you spawned has COMPLETED its goal.",
        },
      ],
    },
    { turnId: "turn-2" },
  );
  const secondStart = [
    event("turn.started", {}, { turnId: "turn-2" }),
    ...tool("wait-2", "opengeni__session_wait", "turn-2"),
    ...tool("events", "opengeni__session_events", "turn-2"),
  ];
  const reply = answer("312 new users signed up in the last 48 hours.", "turn-2", "final_answer");
  const secondEnd = [event("turn.completed", {}, { turnId: "turn-2" })];
  return { prompt, first, result, secondStart, answer: reply, secondEnd };
}

describe("exchange fold", () => {
  test("default grouping is unchanged: every note and wait stays a separate row", () => {
    const exchange = delegatedExchange();
    const events = [
      exchange.prompt,
      ...exchange.first,
      exchange.result,
      ...exchange.secondStart,
      ...exchange.answer,
      ...exchange.secondEnd,
    ];
    // The row flood this fold removes: turn chip, lifted note, recorded wait,
    // child result, second turn chip, then the answer.
    expect(kinds(groupTimeline(buildTimeline(events)))).toEqual([
      "user-message",
      "turn",
      "agent-message",
      "notice",
      "machine-input-batch",
      "turn",
      "agent-message",
    ]);
    expect(rowsBetweenPromptAndAnswer(fold(events))).toBe(1);
  });

  test("commentary joins its cluster while the first turn works", () => {
    const exchange = delegatedExchange();
    // Through the wait tool call, so the second note has activity after it.
    const live = [exchange.prompt, ...exchange.first.slice(0, 12)];
    const groups = fold(live);
    expect(kinds(groups)).toEqual(["user-message", "activity"]);
    const activity = groups[1];
    if (activity?.kind !== "activity") throw new Error("expected the live cluster");
    expect(activity.outcome).toBeUndefined();
    expect(
      activity.items
        .filter((item): item is AgentMessageItem => item.kind === "agent-message")
        .map((item) => item.text),
    ).toEqual([
      "I'll run the replica check in a worker.",
      "The worker is still running; I'll wait for its result.",
    ]);
  });

  test("a phase-less message stays an answer candidate until activity follows it", () => {
    sequence = 0;
    const streaming = [
      event("turn.started", {}),
      ...tool("read", "exec_command", "turn-1"),
      event("agent.message.delta", { text: "Checking the next file" }),
    ];
    expect(kinds(fold(streaming))).toEqual(["activity", "agent-message"]);
    const followed = [...streaming, ...tool("next", "exec_command", "turn-1")];
    expect(kinds(fold(followed))).toEqual(["activity"]);
  });

  test("a stream that declares commentary joins the cluster while it streams", () => {
    sequence = 0;
    const groups = fold([
      event("turn.started", {}),
      ...tool("read", "exec_command", "turn-1"),
      event("agent.message.delta", {
        text: "Reading the schema next",
        messageId: "note-1",
        phase: "commentary",
      }),
    ]);
    expect(kinds(groups)).toEqual(["activity"]);
    const activity = groups[0];
    expect(activity?.kind === "activity" ? activity.items.at(-1) : null).toMatchObject({
      kind: "agent-message",
      phase: "commentary",
      streaming: true,
    });
  });

  test("a parked exchange is one waiting row that knows its agents", () => {
    const exchange = delegatedExchange();
    const groups = fold([exchange.prompt, ...exchange.first]);
    expect(kinds(groups)).toEqual(["user-message", "turn"]);
    const row = groups[1];
    if (row?.kind !== "turn") throw new Error("expected the exchange row");
    expect(row.id).toBe("exchange-turn-turn-1");
    expect(kinds(row.groups)).toEqual(["turn", "agent-message", "notice"]);
    const wait = row.groups[2];
    expect(wait?.kind === "item" ? wait.item : null).toMatchObject({
      kind: "notice",
      recordedOutcome: true,
      waitingAgents: 1,
      text: "Waiting for the replica worker.",
    });
    expect((wait as { item: NoticeItem }).item.waitEndedAt).toBeUndefined();
  });

  test("the resumed turn continues the same live row with the earlier work behind it", () => {
    const exchange = delegatedExchange();
    const groups = fold([
      exchange.prompt,
      ...exchange.first,
      exchange.result,
      ...exchange.secondStart,
    ]);
    expect(kinds(groups)).toEqual(["user-message", "activity"]);
    const row = groups[1];
    if (row?.kind !== "activity") throw new Error("expected the live row");
    expect(row.id).toBe("exchange-turn-turn-1");
    expect(row.outcome).toBeUndefined();
    expect(kinds(row.earlier ?? [])).toEqual([
      "turn",
      "agent-message",
      "notice",
      "machine-input-batch",
    ]);
    const wait = row.earlier?.[2];
    // The child result ended the recorded wait.
    expect(
      wait?.kind === "item" && wait.item.kind === "notice" ? wait.item.waitEndedAt : null,
    ).toBe(exchange.result.occurredAt);
  });

  test("the answer streams below the live row", () => {
    const exchange = delegatedExchange();
    const groups = fold([
      exchange.prompt,
      ...exchange.first,
      exchange.result,
      ...exchange.secondStart,
      exchange.answer[0]!,
    ]);
    expect(kinds(groups)).toEqual(["user-message", "activity", "agent-message"]);
    expect(rowsBetweenPromptAndAnswer(groups)).toBe(1);
  });

  test("a settled exchange is one row followed by its answer", () => {
    const exchange = delegatedExchange();
    const groups = fold([
      exchange.prompt,
      ...exchange.first,
      exchange.result,
      ...exchange.secondStart,
      ...exchange.answer,
      ...exchange.secondEnd,
    ]);
    expect(kinds(groups)).toEqual(["user-message", "turn", "agent-message"]);
    const row = groups[1];
    if (row?.kind !== "turn") throw new Error("expected the exchange row");
    expect(row.id).toBe("exchange-turn-turn-1");
    expect(row.outcome).toBe("complete");
    expect(kinds(row.groups)).toEqual([
      "turn",
      "agent-message",
      "notice",
      "machine-input-batch",
      "turn",
    ]);
    expect(groups[2]?.kind === "item" ? groups[2].item : null).toMatchObject({
      kind: "agent-message",
      text: "312 new users signed up in the last 48 hours.",
    });
  });

  test("a turn without an answer still surfaces its latest note", () => {
    sequence = 0;
    const groups = fold([
      event("user.message", { text: "tidy up" }, { turnId: null }),
      event("turn.started", {}),
      ...tool("fix", "exec_command", "turn-1"),
      ...note("Done: the formatter is clean.", "turn-1"),
      // A trailing tool call makes the phase-less message commentary.
      ...tool("title", "opengeni__set_session_title", "turn-1"),
      event("turn.completed", {}),
    ]);
    expect(kinds(groups)).toEqual(["user-message", "turn", "agent-message"]);
    expect(groups[2]?.kind === "item" ? groups[2].item : null).toMatchObject({
      text: "Done: the formatter is clean.",
    });
    const turn = groups[1];
    if (turn?.kind !== "turn") throw new Error("expected the turn");
    expect(
      turn.groups.flatMap((group) =>
        group.kind === "activity" ? group.items.map((item) => item.kind) : [],
      ),
    ).toEqual(["tool-call", "tool-call"]);
  });

  test("compaction folds into the row as a facet count", () => {
    sequence = 0;
    const groups = fold([
      event("user.message", { text: "refactor" }, { turnId: null }),
      event("turn.started", {}),
      ...tool("before", "exec_command", "turn-1"),
      event("session.context.compaction.started", { trigger: "auto" }),
      event("session.context.compacted", {
        trigger: "auto",
        estimatedTokensBefore: 240_000,
        estimatedTokensAfter: 40_000,
      }),
      ...tool("after", "exec_command", "turn-1"),
      ...answer("Refactor complete.", "turn-1", "final_answer"),
      event("turn.completed", {}),
    ]);
    expect(kinds(groups)).toEqual(["user-message", "turn", "agent-message"]);
    const row = groups[1];
    if (row?.kind !== "turn") throw new Error("expected the exchange row");
    expect(row.contextCompactionCount).toBe(1);
    expect(kinds(row.groups)).toEqual(["activity", "context-compaction", "turn"]);
  });

  test("failures, human input, and scheduled prompts stay visible", () => {
    sequence = 0;
    const groups = fold([
      event("user.message", { text: "deploy" }, { turnId: null }),
      event("turn.started", {}, { turnId: "turn-1" }),
      ...tool("try", "exec_command", "turn-1"),
      event("turn.failed", { error: "provider timeout" }, { turnId: "turn-1" }),
      event(
        "system.update.delivered",
        {
          members: [
            {
              id: "tick",
              kind: "scheduled_occurrence",
              classification: "info",
              sourceId: "schedule-1",
              summary: "Nightly deploy check",
            },
          ],
        },
        { turnId: "turn-2" },
      ),
      event("turn.started", {}, { turnId: "turn-2" }),
      ...tool("retry", "exec_command", "turn-2"),
      ...answer("Deployed.", "turn-2", "final_answer"),
      event("turn.completed", {}, { turnId: "turn-2" }),
    ]);
    expect(kinds(groups)).toEqual([
      "user-message",
      "turn",
      "machine-input-batch",
      "turn",
      "agent-message",
    ]);
    expect(groups[1]?.kind === "turn" ? groups[1].outcome : null).toBe("failed");
  });

  test("a later human prompt ends the fold and starts a new exchange", () => {
    const exchange = delegatedExchange();
    const followUp = event("user.message", { text: "and yesterday?" }, { turnId: null });
    const groups = fold([
      exchange.prompt,
      ...exchange.first,
      followUp,
      event("turn.started", { triggerEventId: followUp.id }, { turnId: "turn-3" }),
      ...tool("query", "exec_command", "turn-3"),
      ...answer("140 users yesterday.", "turn-3", "final_answer"),
      event("turn.completed", {}, { turnId: "turn-3" }),
    ]);
    expect(kinds(groups)).toEqual([
      "user-message",
      "turn",
      "user-message",
      "turn",
      "agent-message",
    ]);
    // The human prompt ended the earlier wait.
    const parked = groups[1];
    const wait = parked?.kind === "turn" ? parked.groups[parked.groups.length - 1] : undefined;
    expect(
      wait?.kind === "item" && wait.item.kind === "notice" ? wait.item.waitEndedAt : null,
    ).toBe(followUp.occurredAt);
  });
});
