import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import {
  buildTimeline,
  groupTimeline,
  type AgentMessageItem,
  type TimelineGroup,
} from "../src/timeline";
import recorded from "./fixtures/exchange-answer-before-machine-turns.json";

/*
 * Answers stay visible; settled progress joins only its own turn's work. A settled answer is
 * never demoted into the row because more machine-triggered turns (agent
 * messages, child results, wait timeouts, goal continuations, background
 * command results) followed it in the same exchange.
 */

let sequence = 0;

function event(type: string, payload: unknown, turnId: string | null = "turn-1"): SessionEvent {
  sequence += 1;
  return {
    id: `answer-evt-${sequence}`,
    workspaceId: "ws-1",
    sessionId: "session-1",
    sequence,
    type,
    payload,
    occurredAt: new Date(Date.UTC(2026, 0, 5, 9, 0, 0) + sequence * 5_000).toISOString(),
    turnId,
  };
}

function tool(id: string, name: string, turnId: string, output: unknown = "ok"): SessionEvent[] {
  return [
    event("agent.toolCall.created", { id, name, arguments: {} }, turnId),
    event("agent.toolCall.output", { id, output }, turnId),
  ];
}

function note(text: string, turnId: string): SessionEvent[] {
  return [
    event(
      "agent.message.delta",
      { text, phase: "commentary", messageId: `${turnId}-note` },
      turnId,
    ),
    event("agent.message.completed", { text, phase: "commentary" }, turnId),
  ];
}

/** An answer as the runtime records it with a provider-declared phase. */
function answer(text: string, turnId: string): SessionEvent[] {
  return [
    event(
      "agent.message.delta",
      { text, phase: "final_answer", messageId: `${turnId}-answer` },
      turnId,
    ),
    event("agent.message.completed", { text, phase: "final_answer" }, turnId),
    event("turn.completed", { output: text }, turnId),
  ];
}

/** An answer as recorded without a phase: deltas plus the final output receipt. */
function phaseLessAnswer(text: string, turnId: string): SessionEvent[] {
  return [
    event("agent.message.delta", { text, messageId: `${turnId}-answer` }, turnId),
    event("agent.message.completed", { text }, turnId),
    event("turn.completed", { output: text }, turnId),
  ];
}

function machineInput(
  kind: string,
  turnId: string,
  sourceId = "5f0c1a2e-7b3d-4c8e-9a61-000000000001",
) {
  return event(
    "system.update.delivered",
    {
      count: 1,
      members: [
        {
          id: `update-${sequence + 1}`,
          kind,
          classification: "info",
          sourceId,
          summary: `A ${kind} update arrived.`,
        },
      ],
    },
    turnId,
  );
}

/** A short machine-triggered turn that re-arms its wait and ends without prose. */
function quietTurn(turnId: string): SessionEvent[] {
  return [
    event("turn.started", {}, turnId),
    event("agent.reasoning.delta", { text: "**Still waiting**" }, turnId),
    event(
      "agent.toolCall.created",
      { id: `${turnId}-park`, name: "opengeni__wait_for_input", arguments: {} },
      turnId,
    ),
    event(
      "session.wait.started",
      { actor: "agent", reason: "Waiting for approval.", waitTurnId: turnId },
      turnId,
    ),
    event(
      "agent.toolCall.output",
      { id: `${turnId}-park`, output: { status: "waiting_for_input" } },
      turnId,
    ),
    event("turn.completed", { output: "" }, turnId),
  ];
}

/** A machine-triggered turn whose only output is an empty final message. */
function emptyTurn(turnId: string): SessionEvent[] {
  return [
    event("turn.started", {}, turnId),
    event("agent.reasoning.delta", { text: "**Nothing new to report**" }, turnId),
    event("agent.message.completed", { text: "" }, turnId),
    event("turn.completed", { output: "" }, turnId),
  ];
}

function fold(events: SessionEvent[]): TimelineGroup[] {
  const groups = groupTimeline(buildTimeline(events), { readableTurns: true });
  if (
    events.some(
      (entry) => (entry.payload as { text?: string }).text === "Querying the regional tables.",
    )
  ) {
    const work = groups.find((group) => group.kind === "activity" && group.id === "work-turn-1");
    // Every answer-preservation variant also pins where its earlier progress
    // went: retained verbatim in the same turn, never dropped or cross-folded.
    expect(work?.kind === "activity" && visibleMessages(work.work!.details)).toContain(
      "Querying the regional tables.",
    );
  }
  return groups;
}

/** Assistant prose a reader sees without expanding anything. */
function visibleMessages(groups: TimelineGroup[]): string[] {
  return groups.flatMap((group) =>
    group.kind === "item" && group.item.kind === "agent-message" && group.item.text.trim()
      ? [group.item.text]
      : [],
  );
}

function topLevelKinds(groups: TimelineGroup[]): string[] {
  return groups.map((group) => (group.kind === "item" ? group.item.kind : group.kind));
}

const ANSWER_A = "The report is ready. **3 regions** grew.\n\nShall I publish it?";
const ANSWER_B = "Published the report to the team folder.";

function answeredFirstTurn(settle: typeof answer = answer): SessionEvent[] {
  sequence = 0;
  return [
    event("user.message", { text: "Build the regional report" }, null),
    event("turn.started", {}, "turn-1"),
    ...note("Querying the regional tables.", "turn-1"),
    ...tool("query", "exec_command", "turn-1"),
    ...tool("render", "exec_command", "turn-1"),
    ...settle(ANSWER_A, "turn-1"),
  ];
}

describe("answers stay visible across readable turns", () => {
  test("recorded exchange: an agent message after the answer starts one more short turn", () => {
    const events = recorded as SessionEvent[];
    const final = buildTimeline(events).find(
      (item): item is AgentMessageItem =>
        item.kind === "agent-message" && item.phase === "final_answer",
    );
    expect(final?.text).toContain("![Layout approval preview](artifact:");
    expect(final?.text).toContain("Do you approve this four-at-a-time layout?");
    const groups = fold(events);
    // The answer, with its image and its question, is a normal visible message.
    expect(visibleMessages(groups)).toContain(final!.text);
    // Turn boundaries and recorded waits remain inspectable, never one exchange fold.
    expect(topLevelKinds(groups)).toContain("machine-input-batch");
    expect(topLevelKinds(groups)).toContain("notice");
    expect(groups.some((group) => group.kind !== "item" && group.id.startsWith("exchange-"))).toBe(
      false,
    );
  });

  for (const kind of [
    "agent_message",
    "child_terminal_result",
    "session_wait_timeout",
    "background_command_result",
    "agent_steer_instruction",
  ]) {
    test(`an answer followed by a ${kind} turn without prose stays visible`, () => {
      const events = [...answeredFirstTurn(), machineInput(kind, "turn-2"), ...quietTurn("turn-2")];
      expect(visibleMessages(fold(events))).toEqual([ANSWER_A]);
    });

    test(`an answer followed by a ${kind} turn that answers again keeps both answers`, () => {
      const events = [
        ...answeredFirstTurn(),
        machineInput(kind, "turn-2"),
        event("turn.started", {}, "turn-2"),
        ...tool("publish", "exec_command", "turn-2"),
        ...answer(ANSWER_B, "turn-2"),
      ];
      expect(visibleMessages(fold(events))).toEqual([ANSWER_A, ANSWER_B]);
    });
  }

  test("an answer followed by a goal continuation turn stays visible", () => {
    const events = [
      ...answeredFirstTurn(),
      event("goal.continuation", { goalId: "goal-1", objective: "Ship the report" }, null),
      machineInput("goal_continuation", "turn-2"),
      event("turn.started", {}, "turn-2"),
      ...tool("check", "exec_command", "turn-2"),
      ...answer(ANSWER_B, "turn-2"),
    ];
    expect(visibleMessages(fold(events))).toEqual([ANSWER_A, ANSWER_B]);
  });

  test("an answer followed by repeated wait timeouts stays visible", () => {
    const events = [...answeredFirstTurn()];
    for (const turnId of ["turn-2", "turn-3", "turn-4"]) {
      events.push(machineInput("session_wait_timeout", turnId), ...quietTurn(turnId));
    }
    expect(visibleMessages(fold(events))).toEqual([ANSWER_A]);
  });

  test("an answer followed by a turn whose final message is empty stays visible", () => {
    const events = [
      ...answeredFirstTurn(),
      machineInput("agent_message", "turn-2"),
      ...emptyTurn("turn-2"),
    ];
    expect(visibleMessages(fold(events))).toEqual([ANSWER_A]);
  });

  test("a phase-less answer followed by a machine turn stays visible", () => {
    const events = [
      ...answeredFirstTurn(phaseLessAnswer),
      machineInput("child_terminal_result", "turn-2"),
      ...quietTurn("turn-2"),
    ];
    expect(visibleMessages(fold(events))).toEqual([ANSWER_A]);
  });

  test("the answer stays visible while the next machine-triggered turn works", () => {
    const events = [
      ...answeredFirstTurn(),
      machineInput("child_terminal_result", "turn-2"),
      event("turn.started", {}, "turn-2"),
      ...tool("follow-up", "exec_command", "turn-2"),
    ];
    const groups = fold(events);
    expect(visibleMessages(groups)).toEqual([ANSWER_A]);
    // The later turn is one live row below the answer.
    expect(topLevelKinds(groups).at(-1)).toBe("activity");
  });

  test("an answer after a published image stays visible when a machine turn follows", () => {
    sequence = 0;
    const receipt = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type: "sandbox_file",
            sandboxPath: "/workspace/chart.png",
            filename: "chart.png",
            artifact: {
              available: true,
              artifactId: "9c1e4b7a-5d2f-4e3a-8b6c-0f1a2b3c4d5f",
              kind: "file",
              contentType: "image/png",
              originalBytes: 1200,
              sha256: "0".repeat(64),
              retainedAt: "2026-01-05T09:00:30.000Z",
              retention: { policy: "workspace_file", expiresAt: null },
              retrieval: {
                method: "GET",
                path: "/v1/workspaces/ws-1/artifacts/9c1e4b7a-5d2f-4e3a-8b6c-0f1a2b3c4d5f/content",
                acceptRanges: "bytes",
                maxRangeBytes: 1048576,
              },
            },
          }),
        },
      ],
    };
    const events = [
      event("user.message", { text: "Chart the regions" }, null),
      event("turn.started", {}, "turn-1"),
      ...tool("render", "exec_command", "turn-1"),
      ...tool("publish", "opengeni__sandbox_file_publish", "turn-1", receipt),
      ...answer(ANSWER_A, "turn-1"),
      machineInput("agent_message", "turn-2"),
      ...quietTurn("turn-2"),
    ];
    expect(visibleMessages(fold(events))).toEqual([ANSWER_A]);
  });

  test("input delivered after an answer opens the next row below it at once", () => {
    const answered = answeredFirstTurn();
    const input = machineInput("agent_message", "turn-2");
    const groups = fold([...answered, input]);
    expect(topLevelKinds(groups)).toEqual([
      "user-message",
      "activity",
      "agent-message",
      "machine-input-batch",
    ]);
    expect(visibleMessages(groups)).toEqual([ANSWER_A]);
    // One small reason identifies the new turn before its work starts.
    const opened = groups.at(-1);
    expect(opened?.kind === "item" ? opened.item.id : null).toBe(input.id);
    const working = fold([
      ...answered,
      input,
      event("turn.started", {}, "turn-2"),
      ...tool("follow-up", "exec_command", "turn-2"),
    ]);
    const live = working.at(-1);
    expect(live?.kind === "activity" ? live.id : null).toBe("work-turn-2");
  });

  test("a later turn that writes only a note keeps the answer and folds its own work", () => {
    const events = [
      ...answeredFirstTurn(),
      machineInput("child_terminal_result", "turn-2"),
      event("turn.started", {}, "turn-2"),
      ...tool("check", "exec_command", "turn-2"),
      ...note("The worker finished; nothing else changed.", "turn-2"),
      ...tool("title", "opengeni__set_session_title", "turn-2"),
      event("turn.completed", { output: "" }, "turn-2"),
    ];
    const groups = fold(events);
    // The note stands in for the later turn's missing answer, below its row.
    expect(topLevelKinds(groups)).toEqual([
      "user-message",
      "activity",
      "agent-message",
      "machine-input-batch",
      "activity",
      "agent-message",
    ]);
    expect(visibleMessages(groups)).toEqual([
      ANSWER_A,
      "The worker finished; nothing else changed.",
    ]);
  });

  test("live progress stays visible and is also listed, in order, in its work history", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Build the regional report" }, null),
      event("turn.started", {}, "turn-1"),
      ...note("Querying the regional tables.", "turn-1"),
      ...tool("query", "exec_command", "turn-1"),
      event(
        "agent.message.completed",
        { text: "Rendering the chart.", phase: "commentary", messageId: "turn-1-second" },
        "turn-1",
      ),
      ...tool("render", "exec_command", "turn-1"),
    ];
    const groups = groupTimeline(buildTimeline(events), { readableTurns: true });
    expect(visibleMessages(groups)).toEqual([
      "Querying the regional tables.",
      "Rendering the chart.",
    ]);
    const work = groups.find((group) => group.kind === "activity" && group.work);
    if (work?.kind !== "activity") throw new Error("expected a live work row");
    expect(work.work!.endedAt).toBeUndefined();
    const noteIds = groups.flatMap((group) =>
      group.kind === "item" && group.item.kind === "agent-message" ? [group.item.id] : [],
    );
    expect(work.work!.liveNoteIds).toEqual(noteIds);
    expect(
      work.work!.details.map((entry) =>
        entry.kind === "item" && entry.item.kind === "agent-message" ? entry.item.text : entry.kind,
      ),
    ).toEqual(["Querying the regional tables.", "activity", "Rendering the chart.", "activity"]);
  });

  test("a note that more work followed stays visible beside the earlier answer", () => {
    const events = [
      ...answeredFirstTurn(),
      machineInput("child_terminal_result", "turn-2"),
      event("turn.started", {}, "turn-2"),
      ...note("Checking the worker result.", "turn-2"),
      ...tool("check", "exec_command", "turn-2"),
      event("turn.completed", { output: "" }, "turn-2"),
      ...[machineInput("session_wait_timeout", "turn-3"), ...quietTurn("turn-3")],
    ];
    const groups = fold(events);
    expect(visibleMessages(groups)).toEqual([ANSWER_A, "Checking the worker result."]);
    expect(topLevelKinds(groups)).toEqual([
      "user-message",
      "activity",
      "agent-message",
      "machine-input-batch",
      "activity",
      "agent-message",
      "machine-input-batch",
      "activity",
      "notice",
    ]);
  });

  test("a declared final answer that a trailing step of its turn follows stays visible", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Build the regional report" }, null),
      event("turn.started", {}, "turn-1"),
      ...note("Querying the regional tables.", "turn-1"),
      ...tool("query", "exec_command", "turn-1"),
      event(
        "agent.message.delta",
        { text: ANSWER_A, phase: "final_answer", messageId: "turn-1-answer" },
        "turn-1",
      ),
      event("agent.message.completed", { text: ANSWER_A, phase: "final_answer" }, "turn-1"),
      ...tool("title", "opengeni__set_session_title", "turn-1"),
      event("turn.completed", { output: "" }, "turn-1"),
      machineInput("agent_message", "turn-2"),
      ...quietTurn("turn-2"),
    ];
    const groups = fold(events);
    // The answer, not the earlier progress note, is the turn's visible reply.
    expect(visibleMessages(groups)).toEqual([ANSWER_A]);
    expect(topLevelKinds(groups)).toEqual([
      "user-message",
      "activity",
      "agent-message",
      "machine-input-batch",
      "activity",
      "notice",
    ]);
  });

  test("the classic grouping is unchanged", () => {
    const events = [
      ...answeredFirstTurn(),
      machineInput("agent_message", "turn-2"),
      ...quietTurn("turn-2"),
    ];
    expect(topLevelKinds(groupTimeline(buildTimeline(events)))).toEqual([
      "user-message",
      "turn",
      "agent-message",
      "machine-input-batch",
      "turn",
      "notice",
    ]);
  });

  test("a structured human-input answer and the answer after it stay visible", () => {
    sequence = 0;
    const request = {
      id: "request-1",
      toolCallId: "ask",
      questions: [
        {
          id: "q1",
          header: "Region",
          question: "Which region should the report cover?",
          options: [
            { label: "EU", description: "Europe" },
            { label: "US", description: "United States" },
          ],
        },
      ],
    };
    const events = [
      event("user.message", { text: "Build the regional report" }, null),
      event("turn.started", {}, "turn-1"),
      event("agent.toolCall.created", {
        id: "ask",
        name: "request_human_input",
        arguments: {},
      }),
      event("session.humanInput.requested", { request }),
      event("user.humanInputResponse", {
        response: {
          requestId: "request-1",
          outcome: "answered",
          answers: [{ questionId: "q1", selectedOptionLabels: ["EU"] }],
        },
      }),
      event("agent.toolCall.output", { id: "ask", output: "EU" }),
      ...tool("query", "exec_command", "turn-1"),
      ...answer(ANSWER_A, "turn-1"),
      machineInput("agent_message", "turn-2"),
      ...quietTurn("turn-2"),
    ];
    const groups = fold(events);
    expect(topLevelKinds(groups)).toContain("human-input");
    expect(visibleMessages(groups)).toEqual([ANSWER_A]);
  });
});

describe("a person's question answered before a wait", () => {
  const ANSWER = "**Yes, 28 versus 128 costs the same** if the actual node count stays the same.";
  const CORRECTION = "Please disregard the citation links above; the conclusion stands.";

  function commentary(text: string, id: string, turnId: string): SessionEvent[] {
    return [
      event("agent.message.delta", { text, phase: "commentary", messageId: id }, turnId),
      event("agent.message.completed", { text, phase: "commentary", messageId: id }, turnId),
    ];
  }

  function waitThenSettle(turnId: string): SessionEvent[] {
    return [
      event(
        "agent.toolCall.created",
        { id: `${turnId}-wait`, name: "opengeni__wait_for_input", arguments: {} },
        turnId,
      ),
      event(
        "session.wait.started",
        { actor: "agent", reason: "Waiting for the reviews.", waitTurnId: turnId },
        turnId,
      ),
      event(
        "agent.toolCall.output",
        { id: `${turnId}-wait`, output: { status: "waiting_for_input" } },
        turnId,
      ),
      event("turn.completed", { output: "", reply: CORRECTION }, turnId),
    ];
  }

  /** The recorded shape: answer as commentary, more tools, a short note, then a wait. */
  function answeredThenWaited(opener: SessionEvent): SessionEvent[] {
    return [
      opener,
      event("turn.started", {}, "turn-q"),
      ...tool("search", "web_search_call", "turn-q"),
      ...commentary(ANSWER, "answer", "turn-q"),
      ...tool("search-2", "web_search_call", "turn-q"),
      ...tool("clock", "exec_command", "turn-q"),
      ...commentary(CORRECTION, "correction", "turn-q"),
      ...tool("clock-2", "exec_command", "turn-q"),
      ...waitThenSettle("turn-q"),
    ];
  }

  test("the answer stays visible after the work row instead of folding into it", () => {
    sequence = 0;
    const events = answeredThenWaited(
      event("user.message", { text: "Does the scaler maximum change what we pay?" }, null),
    );
    const groups = groupTimeline(buildTimeline(events), { readableTurns: true });
    expect(visibleMessages(groups)).toEqual([ANSWER, CORRECTION]);
    const kinds = topLevelKinds(groups);
    expect(kinds.slice(0, 4)).toEqual([
      "user-message",
      "activity",
      "agent-message",
      "agent-message",
    ]);
    const work = groups[1];
    expect(work?.kind === "activity" && visibleMessages(work.work!.details)).toEqual([]);
  });

  test("progress between the immediate answer and the latest word still folds", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Roll out the new bounds" }, null),
      event("turn.started", {}, "turn-q"),
      ...commentary("I'll use 2 to 28 in production.", "first", "turn-q"),
      ...tool("read", "exec_command", "turn-q"),
      ...commentary("Checking the rollout gates.", "middle", "turn-q"),
      ...tool("check", "exec_command", "turn-q"),
      ...commentary(CORRECTION, "last", "turn-q"),
      ...waitThenSettle("turn-q"),
    ];
    const groups = groupTimeline(buildTimeline(events), { readableTurns: true });
    expect(visibleMessages(groups)).toEqual(["I'll use 2 to 28 in production.", CORRECTION]);
    const work = groups.find((group) => group.kind === "activity");
    expect(work?.kind === "activity" && visibleMessages(work.work!.details)).toEqual([
      "Checking the rollout gates.",
    ]);
  });

  test("a machine-started turn that ends waiting keeps only its latest note visible", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Build the regional report" }, null),
      event("turn.started", {}, "turn-1"),
      ...answer(ANSWER_A, "turn-1"),
      machineInput("child_progress", "turn-q"),
      event("turn.started", {}, "turn-q"),
      ...commentary("Checking the worker result.", "first", "turn-q"),
      ...tool("check", "exec_command", "turn-q"),
      ...commentary(CORRECTION, "last", "turn-q"),
      ...waitThenSettle("turn-q"),
    ];
    const groups = groupTimeline(buildTimeline(events), { readableTurns: true });
    expect(visibleMessages(groups)).toEqual([ANSWER_A, CORRECTION]);
  });

  for (const readableTurns of [true, false]) {
    test(`an absorbed steer does not make the next machine turn answer a person (readable=${readableTurns})`, () => {
      sequence = 0;
      const events = [
        event("user.message", { text: "Build the report" }, null),
        event("turn.started", {}, "turn-1"),
        ...tool("t1", "exec_command", "turn-1"),
        event("user.message", { text: "Also include the EU", delivery: "steer" }, "turn-1"),
        ...tool("t2", "exec_command", "turn-1"),
        ...answer(ANSWER_A, "turn-1"),
        machineInput("child_progress", "turn-m"),
        event("turn.started", {}, "turn-m"),
        ...commentary("Checking the worker result.", "first", "turn-m"),
        ...tool("t3", "exec_command", "turn-m"),
        ...commentary(CORRECTION, "last", "turn-m"),
        ...waitThenSettle("turn-m"),
      ];
      const groups = groupTimeline(buildTimeline(events), { readableTurns });
      expect(visibleMessages(groups)).toEqual([ANSWER_A, CORRECTION]);
    });

    test(`a person's turn that compacts before answering keeps the answer (readable=${readableTurns})`, () => {
      sequence = 0;
      const events = [
        event("user.message", { text: "Status?" }, null),
        event("turn.started", {}, "turn-q"),
        event("session.context.compacted", { trigger: "auto" }, "turn-q"),
        ...commentary(ANSWER, "first", "turn-q"),
        ...tool("t3", "exec_command", "turn-q"),
        ...commentary(CORRECTION, "last", "turn-q"),
        ...waitThenSettle("turn-q"),
      ];
      const groups = groupTimeline(buildTimeline(events), { readableTurns });
      expect(visibleMessages(groups)).toEqual([ANSWER, CORRECTION]);
    });
  }

  test("a person's message that supersedes a live turn is answered by the next turn", () => {
    sequence = 0;
    const events = [
      event("user.message", { text: "Lower the floor to two" }, null),
      event("turn.started", {}, "turn-1"),
      ...tool("t1", "exec_command", "turn-1"),
      event("user.message", { text: "Does the scaler maximum change what we pay?" }, null),
      event("turn.superseded", { reason: "steer" }, "turn-1"),
      event("turn.started", {}, "turn-q"),
      ...tool("search", "web_search_call", "turn-q"),
      ...commentary(ANSWER, "answer", "turn-q"),
      ...tool("clock", "exec_command", "turn-q"),
      ...commentary(CORRECTION, "correction", "turn-q"),
      ...waitThenSettle("turn-q"),
    ];
    const groups = groupTimeline(buildTimeline(events), { readableTurns: true });
    expect(visibleMessages(groups)).toEqual([ANSWER, CORRECTION]);
  });

  test("the classic grouping also keeps the answer outside the folded turn", () => {
    sequence = 0;
    const events = answeredThenWaited(
      event("user.message", { text: "Does the scaler maximum change what we pay?" }, null),
    );
    const groups = groupTimeline(buildTimeline(events));
    expect(visibleMessages(groups)).toEqual([ANSWER, CORRECTION]);
    expect(topLevelKinds(groups).slice(0, 4)).toEqual([
      "user-message",
      "turn",
      "agent-message",
      "agent-message",
    ]);
  });
});
