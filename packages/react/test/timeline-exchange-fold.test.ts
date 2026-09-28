import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline, type TimelineGroup } from "../src/timeline";

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
    event("agent.message.delta", { text, ...(phase ? { phase } : {}) }, { turnId }),
    event("agent.message.completed", { text, ...(phase ? { phase } : {}) }, { turnId }),
  ];
}

/**
 * A message as the runtime records it today: identified deltas without a
 * phase. The only completion is the phase-less final output receipt that the
 * worker writes together with `turn.completed`.
 */
function recordedDelta(text: string, messageId: string, turnId = "turn-1"): SessionEvent {
  return event("agent.message.delta", { text, messageId }, { turnId });
}

function recordedTurnEnd(output: string, turnId = "turn-1"): SessionEvent[] {
  return [
    event("agent.message.completed", { text: output }, { turnId }),
    event("turn.completed", { output }, { turnId }),
  ];
}

function kinds(groups: TimelineGroup[]): string[] {
  return groups.map((group) => (group.kind === "item" ? group.item.kind : group.kind));
}

function fold(events: SessionEvent[]): TimelineGroup[] {
  return groupTimeline(buildTimeline(events), { foldExchanges: true });
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

const visibleProse = (groups: TimelineGroup[]) =>
  groups.flatMap((group) =>
    group.kind === "item" && group.item.kind === "agent-message" ? [group.item.text] : [],
  );
const workRows = (groups: TimelineGroup[]) =>
  groups.filter((group) => group.kind === "activity" && group.work);

describe("readable per-turn grouping", () => {
  test("late commentary cannot change a settled phase-less response duration", () => {
    sequence = 0;
    const work = tool("read", "exec_command", "turn-1");
    const start = event("agent.message.delta", { text: "Answer", messageId: "a" });
    const events = [
      ...work,
      start,
      event("agent.message.completed", { text: "Answer", messageId: "a" }),
      event("turn.completed", {}),
    ];
    const before = workRows(fold(events))[0];
    const groups = fold([
      ...events,
      event("agent.message.completed", {
        text: "Late note",
        messageId: "late",
        phase: "commentary",
      }),
    ]);
    const after = workRows(groups)[0];
    expect(after?.kind === "activity" ? after.work?.responseStartedAt : null).toBe(
      before?.kind === "activity" ? before.work?.responseStartedAt : null,
    );
    expect(visibleProse(groups)).toEqual(["Answer", "Late note"]);
  });

  test("a late final cannot move settled work across a newer turn or extend its clock", () => {
    sequence = 0;
    const first = [event("turn.started", {}), ...tool("read", "exec_command", "turn-1")];
    const ended = event("turn.completed", {});
    const resumed = event(
      "system.update.delivered",
      {
        members: [
          {
            id: "u",
            sourceId: "worker",
            kind: "agent_message",
            classification: "info",
            summary: "Follow up",
          },
        ],
      },
      { turnId: "turn-2" },
    );
    const events = [
      ...first,
      ended,
      resumed,
      ...tool("next", "exec_command", "turn-2"),
      event(
        "agent.message.completed",
        { text: "Late final", phase: "final_answer", messageId: "late" },
        { turnId: "turn-1" },
      ),
    ];
    const groups = fold(events);
    expect(visibleProse(groups)).toEqual(["Late final"]);
    expect(kinds(groups)).toEqual(["activity", "machine-input-batch", "activity", "agent-message"]);
    const row = workRows(groups)[0];
    expect(row?.kind === "activity" ? row.work?.responseStartedAt : null).toBe(ended.occurredAt);
    expect(workRows(groups).map((group) => group.kind === "activity" && group.id)).toEqual([
      "work-turn-1",
      "work-turn-2",
    ]);
  });

  test("classic grouping retains its original turn and wait boundaries", () => {
    const x = delegatedExchange();
    expect(
      kinds(
        groupTimeline(
          buildTimeline([
            x.prompt,
            ...x.first,
            x.result,
            ...x.secondStart,
            ...x.answer,
            ...x.secondEnd,
          ]),
        ),
      ),
    ).toEqual([
      "user-message",
      "turn",
      "agent-message",
      "notice",
      "machine-input-batch",
      "turn",
      "agent-message",
    ]);
  });

  for (const phase of [undefined, "commentary", "final_answer"] as const) {
    for (const length of [12, 999, 1000, 1001, 2400]) {
      test(`${phase ?? "phase-less"} prose streams visibly at ${length} characters`, () => {
        sequence = 0;
        const text = "x".repeat(length);
        const events = [
          event("turn.started", {}),
          ...tool("read", "exec_command", "turn-1"),
          event("agent.message.delta", { text, messageId: "m1", ...(phase ? { phase } : {}) }),
        ];
        expect(visibleProse(fold(events))).toEqual([text]);
        expect(visibleProse(fold([...events, ...tool("next", "exec_command", "turn-1")]))).toEqual([
          text,
        ]);
        const row = workRows(fold(events))[0];
        expect(
          row?.kind === "activity" && row.items.every((item) => item.kind !== "agent-message"),
        ).toBe(true);
      });
    }
  }

  test("every progress message and turn-ending reply survives machine resumption", () => {
    const x = delegatedExchange();
    const first = fold([x.prompt, ...x.first]);
    const resumed = fold([
      x.prompt,
      ...x.first,
      x.result,
      ...x.secondStart,
      ...x.answer,
      ...x.secondEnd,
    ]);
    expect(visibleProse(first)).toEqual([
      "I'll run the replica check in a worker.",
      "The worker is still running; I'll wait for its result.",
    ]);
    expect(visibleProse(resumed)).toEqual([
      ...visibleProse(first),
      "312 new users signed up in the last 48 hours.",
    ]);
    expect(workRows(resumed).map((row) => row.kind === "activity" && row.id)).toEqual([
      "work-turn-1",
      "work-turn-2",
    ]);
    expect(resumed.some((group) => group.kind !== "item" && group.id.startsWith("exchange-"))).toBe(
      false,
    );
  });

  test("a settled work row ends at the first answer delta and retains its identity", () => {
    sequence = 0;
    const events = [event("turn.started", {}), ...tool("read", "exec_command", "turn-1")];
    const start = event("agent.message.delta", {
      messageId: "a",
      text: "Answer",
      phase: "final_answer",
    });
    const live = workRows(fold([...events, start]))[0];
    const settled = workRows(
      fold([
        ...events,
        start,
        event("agent.message.completed", { text: "Answer", phase: "final_answer" }),
        event("turn.completed", {}),
      ]),
    )[0];
    expect(live?.kind === "activity" ? live.work?.responseStartedAt : null).toBe(start.occurredAt);
    expect(settled?.kind === "activity" ? settled.work?.responseStartedAt : null).toBe(
      start.occurredAt,
    );
    expect(settled?.kind === "activity" ? settled.id : null).toBe(
      live?.kind === "activity" ? live.id : null,
    );
  });

  test("a phase-less final output settles without changing its visible text", () => {
    sequence = 0;
    const events = [
      event("turn.started", {}),
      ...tool("read", "exec_command", "turn-1"),
      recordedDelta("312 users", "a"),
    ];
    expect(visibleProse(fold(events))).toEqual(["312 users"]);
    expect(visibleProse(fold([...events, ...recordedTurnEnd("312 users")]))).toEqual(["312 users"]);
  });

  test("routine deliveries coalesce once per resumed turn without losing payloads", () => {
    const x = delegatedExchange();
    const more = event(
      "system.update.delivered",
      {
        members: [
          {
            id: "another",
            kind: "child_progress",
            sourceId: "worker-2",
            classification: "info",
            summary: "Still checking",
          },
        ],
      },
      { turnId: "turn-2" },
    );
    const groups = fold([x.prompt, ...x.first, x.result, more, ...x.secondStart]);
    const batches = groups.flatMap((group) =>
      group.kind === "item" && group.item.kind === "machine-input-batch" ? [group.item] : [],
    );
    expect(batches).toHaveLength(1);
    expect(batches[0]?.members.map((member) => member.id)).toEqual(["update-1", "another"]);
  });

  for (const status of ["paused", "cancelled", "failed"]) {
    test(`${status} ends a recorded wait while preserving its reason and worker count`, () => {
      const x = delegatedExchange();
      const end = event(
        status === "paused" ? "session.control.paused" : "session.status.changed",
        { status },
        { turnId: null },
      );
      const groups = fold([x.prompt, ...x.first, end]);
      const wait = groups.find(
        (group) =>
          group.kind === "item" && group.item.kind === "notice" && group.item.recordedOutcome,
      );
      expect(wait?.kind === "item" ? wait.item : null).toMatchObject({
        waitingAgents: 1,
        waitEndedAt: end.occurredAt,
        text: "Waiting for the replica worker.",
      });
    });
  }

  test("completed compaction has accessible per-turn details", () => {
    sequence = 0;
    const groups = fold([
      event("turn.started", {}),
      ...tool("read", "exec_command", "turn-1"),
      event("session.context.compacted", {
        trigger: "auto",
        estimatedTokensBefore: 240000,
        estimatedTokensAfter: 40000,
      }),
      ...answer("Done", "turn-1", "final_answer"),
      event("turn.completed", {}),
    ]);
    const row = workRows(groups)[0];
    expect(row?.kind === "activity" ? kinds(row.work!.details) : []).toEqual([
      "context-compaction",
    ]);
    expect(visibleProse(groups)).toEqual(["Done"]);
  });

  test("failure stays on its own work row and scheduled input stays visible", () => {
    sequence = 0;
    const groups = fold([
      event("turn.started", {}),
      ...tool("try", "exec_command", "turn-1"),
      event("turn.failed", { error: "provider timeout" }),
      event(
        "system.update.delivered",
        {
          members: [
            {
              id: "schedule",
              kind: "scheduled_occurrence",
              sourceId: "schedule-1",
              classification: "info",
              summary: "Nightly check",
            },
          ],
        },
        { turnId: "turn-2" },
      ),
    ]);
    const row = workRows(groups)[0];
    expect(row?.kind === "activity" ? row.outcome : null).toBe("failed");
    expect(kinds(groups)).toContain("machine-input-batch");
  });
});
