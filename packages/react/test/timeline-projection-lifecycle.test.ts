import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline } from "../src/timeline/projection";
import type { TimelineGroup } from "../src/timeline/types";
import { createOpenGeniText } from "../src/messages/runtime";
import { coalesceSessionEventDeltas } from "@opengeni/events";

const englishText = createOpenGeniText();

test("an explicit empty-workspace selection is a durable notice, not an agent reply", () => {
  const text = "An empty workspace was selected. The old archive is retained.";
  const items = buildTimeline(englishText, [
    event(1, "sandbox.recovery.selected", {
      mode: "fresh_workspace",
      text,
    }),
  ]);
  expect(items).toContainEqual(expect.objectContaining({ kind: "notice", text }));
  expect(items.some((item) => item.kind === "agent-message")).toBe(false);
});

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
  groupTimeline(englishText, buildTimeline(englishText, events), { readableTurns: true });
const work = (groups: TimelineGroup[]) => groups.filter((group) => group.kind === "activity");
const prose = (groups: TimelineGroup[]) =>
  groups.flatMap((group) =>
    group.kind === "item" && group.item.kind === "agent-message" ? [group.item.text] : [],
  );

describe("projection lifecycle audit regressions", () => {
  test("coalesced Steers keep their user bubbles without empty agent turns", () => {
    const items = buildTimeline(englishText, [
      event(
        1,
        "user.message",
        { text: "First direction", routing: "accepted_for_steering" },
        "steer-1",
      ),
      event(
        2,
        "user.message",
        { text: "Second direction", routing: "accepted_for_steering" },
        "steer-2",
      ),
      event(
        3,
        "turn.superseded",
        { reason: "steer", targetTurnId: "steer-2", beforeAttempt: true },
        "steer-1",
      ),
      event(4, "turn.started", {}, "steer-2"),
      event(
        5,
        "agent.message.completed",
        { messageId: "answer", phase: "final_answer", text: "Both handled." },
        "steer-2",
      ),
      event(6, "turn.completed", {}, "steer-2"),
    ]);
    expect(items.filter((item) => item.kind === "user-message")).toHaveLength(2);
    expect(items.filter((item) => item.kind === "agent-message")).toHaveLength(1);
    expect(items.some((item) => item.kind === "turn-end" && item.turnId === "steer-1")).toBe(false);
  });
  test("a partial history retains a real handover's cut-off text without its start", () => {
    const items = buildTimeline(englishText, [
      event(10, "turn.superseded", {
        reason: "steer",
        atModelStep: true,
        cutOffText: "Preserved partial answer",
      }),
    ]);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "agent-message",
        text: "Preserved partial answer",
      }),
    );
    expect(items).toContainEqual(expect.objectContaining({ kind: "turn-end", turnId: "turn-1" }));
  });
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

  test("a Steer read at the next model step closes the old turn quietly, not as interrupted", () => {
    const handover = event(5, "turn.superseded", { reason: "steer", atModelStep: true });
    const events = [
      event(1, "turn.started"),
      event(2, "agent.message.completed", { messageId: "before", text: "Checking" }),
      event(3, "agent.toolCall.created", { id: "read", name: "exec_command", arguments: {} }),
      event(4, "agent.toolCall.output", { id: "read", output: "ok" }),
      handover,
    ];
    const groups = fold(events);
    expect(work(groups)[0]!.work!.endedAt).toBe(handover.occurredAt);
    expect(work(groups)[0]!.outcome).toBe("complete");
    expect(work(groups)[0]!.items[0]).toMatchObject({ kind: "tool-call", status: "complete" });
    const timeline = buildTimeline(englishText, events);
    expect(timeline.some((item) => item.kind === "notice")).toBe(false);
  });

  test("a Steer that cut the answer short keeps the streamed partial text once, never as an error", () => {
    const handover = event(5, "turn.superseded", {
      reason: "steer",
      atModelStep: true,
      cutOffText: "Looking through the",
    });
    const streamed = [
      event(1, "turn.started"),
      event(2, "agent.message.completed", { messageId: "before", text: "Checking" }),
      event(3, "agent.message.delta", { messageId: "cut", text: "Looking through the" }),
      handover,
    ];
    const live = buildTimeline(englishText, streamed);
    const liveMessages = live.filter((item) => item.kind === "agent-message");
    expect(liveMessages.map((item) => item.text)).toEqual(["Checking", "Looking through the"]);
    expect(liveMessages.every((item) => !item.streaming)).toBe(true);
    expect(live.some((item) => item.kind === "notice")).toBe(false);

    // Without the deltas (an archived history) the recorded cut-off text
    // stands in, as a finished progress note.
    const archived = buildTimeline(englishText, [streamed[0]!, streamed[1]!, handover]);
    const archivedMessages = archived.filter((item) => item.kind === "agent-message");
    expect(archivedMessages.map((item) => item.text)).toEqual(["Checking", "Looking through the"]);
    expect(archivedMessages[1]).toMatchObject({ phase: "commentary", streaming: false });
    expect(work(fold([streamed[0]!, streamed[1]!, handover]))[0]!.outcome).toBe("complete");
  });

  test("cut-off text stays above the Steer that cut it, live or archived", () => {
    const steer = event(
      4,
      "user.message",
      { text: "What is the status?", delivery: "steer", routing: "accepted_for_steering" },
      "turn-2",
    );
    const handover = event(5, "turn.superseded", {
      reason: "steer",
      atModelStep: true,
      cutOffText: "Looking through the",
    });
    const order = (events: SessionEvent[]) =>
      buildTimeline(englishText, events).flatMap((item) =>
        item.kind === "agent-message" || item.kind === "user-message" ? [item.text] : [],
      );
    const started = event(1, "turn.started");
    const finished = event(2, "agent.message.completed", { messageId: "a", text: "Checking" });
    const cut = event(3, "agent.message.delta", { messageId: "b", text: "Looking through the" });
    const expected = ["Checking", "Looking through the", "What is the status?"];
    expect(order([started, finished, cut, steer, handover])).toEqual(expected);
    expect(order([started, finished, steer, handover])).toEqual(expected);
    // Only the cut message streamed in this turn.
    expect(order([started, cut, steer, handover])).toEqual([
      "Looking through the",
      "What is the status?",
    ]);
    // Archived, and nothing else from this turn is in view.
    expect(order([started, steer, handover])).toEqual([
      "Looking through the",
      "What is the status?",
    ]);
  });

  test("a finished message completing after the Steer bubble still stays above it", () => {
    // Claude settles completions only when the cut request ends, which is
    // after the Steer bubble was drawn.
    const timeline = buildTimeline(englishText, [
      event(1, "turn.started"),
      event(2, "agent.message.delta", { messageId: "a", text: "Checking" }),
      event(3, "agent.message.delta", { messageId: "b", text: "Next I wi" }),
      event(
        4,
        "user.message",
        { text: "What is the status?", delivery: "steer", routing: "accepted_for_steering" },
        "turn-2",
      ),
      event(5, "agent.message.completed", {
        messageId: "a",
        text: "Checking",
        phase: "commentary",
      }),
      event(6, "turn.superseded", { reason: "steer", atModelStep: true, cutOffText: "Next I wi" }),
    ]);
    expect(
      timeline.flatMap((item) =>
        item.kind === "agent-message" || item.kind === "user-message" ? [item.text] : [],
      ),
    ).toEqual(["Checking", "Next I wi", "What is the status?"]);
  });

  test("a Steer bubble from an earlier, finished turn does not reorder a later handover", () => {
    const order = buildTimeline(englishText, [
      event(1, "turn.started"),
      event(
        2,
        "user.message",
        { text: "Also check prices", delivery: "steer", routing: "accepted_for_steering" },
        "turn-2",
      ),
      event(3, "agent.message.completed", { messageId: "a", text: "Done" }),
      event(4, "turn.completed"),
      event(5, "turn.started", {}, "turn-2"),
      event(6, "agent.message.completed", { messageId: "b", text: "Prices look fine" }, "turn-2"),
      event(
        7,
        "turn.superseded",
        { reason: "steer", atModelStep: true, cutOffText: "Then I" },
        "turn-2",
      ),
    ]).flatMap((item) =>
      item.kind === "agent-message" || item.kind === "user-message" ? [item.text] : [],
    );
    expect(order).toEqual(["Also check prices", "Done", "Prices look fine", "Then I"]);
  });

  test("a Steer bubble drawn during a compaction turn does not reorder the next handover", () => {
    const steer = (seq: number, text: string, turnId: string) =>
      event(
        seq,
        "user.message",
        { text, delivery: "steer", routing: "accepted_for_steering" },
        turnId,
      );
    const order = buildTimeline(englishText, [
      event(1, "turn.started", {}, "compact"),
      steer(2, "Start the report", "turn-a"),
      event(3, "turn.completed", { maintenance: "context_compaction" }, "compact"),
      event(4, "turn.started", {}, "turn-a"),
      event(5, "agent.message.completed", { messageId: "a", text: "Answer A" }, "turn-a"),
      steer(6, "Shorter please", "turn-b"),
      event(
        7,
        "turn.superseded",
        { reason: "steer", atModelStep: true, cutOffText: "Partial A" },
        "turn-a",
      ),
    ]).flatMap((item) =>
      item.kind === "agent-message" || item.kind === "user-message" ? [item.text] : [],
    );
    expect(order).toEqual(["Start the report", "Answer A", "Partial A", "Shorter please"]);
  });

  test("a Steer that replaces an approval wait closes the turn quietly; the hard interrupt does not", () => {
    const waiting = [
      event(1, "turn.started"),
      event(2, "agent.toolCall.created", { id: "deploy", name: "deploy", arguments: {} }),
      event(3, "session.requiresAction", { approvals: [{ id: "deploy", name: "deploy" }] }),
      event(4, "user.message", { text: "Do the staging one first", delivery: "steer" }, "turn-2"),
    ];
    const replaced = [
      ...waiting,
      event(5, "turn.superseded", { reason: "steer", targetTurnId: "turn-2" }),
    ];
    expect(work(fold(replaced))[0]!.outcome).toBe("complete");
    // Only the historical approval note; nothing reads as interrupted.
    expect(
      buildTimeline(englishText, replaced).filter(
        (item) => item.kind === "notice" && item.tone !== "waiting",
      ),
    ).toEqual([]);
    // The API hard interrupt stops a live attempt and still reads as stopped.
    const interrupted = [...waiting, event(5, "turn.superseded", { reason: "steer" })];
    expect(work(fold(interrupted))[0]!.outcome).toBe("cancelled");
  });

  test("a finished message completing after the cut-off one keeps stream order, without repeating it", () => {
    // Claude settles completions only when the cut request ends, after the
    // unfinished message's deltas.
    const timeline = buildTimeline(englishText, [
      event(1, "turn.started"),
      event(2, "agent.message.delta", { messageId: "a", text: "Checking" }),
      event(3, "agent.message.delta", { messageId: "b", text: "Next I wi" }),
      event(4, "agent.message.completed", {
        messageId: "a",
        text: "Checking",
        phase: "commentary",
      }),
      event(5, "turn.superseded", { reason: "steer", atModelStep: true, cutOffText: "Next I wi" }),
    ]);
    expect(
      timeline.filter((item) => item.kind === "agent-message").map((item) => item.text),
    ).toEqual(["Checking", "Next I wi"]);
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
    // The retried attempt's unclassified failure names its outcome and keeps
    // the recorded text behind Details.
    expect(
      work(completed)[0]!.work!.details.some(
        (group) =>
          group.kind === "item" &&
          group.item.kind === "notice" &&
          group.item.text === "The turn stopped unexpectedly" &&
          group.item.details?.value === "Provider unavailable",
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

  test("reasoning summary parts streamed as separate bold deltas become paragraphs", () => {
    const items = buildTimeline(englishText, [
      event(1, "agent.reasoning.delta", { text: "**Checking the workspace first**" }),
      event(2, "agent.reasoning.delta", { text: "**Inspecting guidance**" }),
      event(3, "agent.reasoning.delta", { text: " and then **more**" }),
    ]);
    const reasoning = items.filter((item) => item.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.kind === "reasoning" && reasoning[0]!.text).toBe(
      "**Checking the workspace first**\n\n**Inspecting guidance** and then **more**",
    );
  });

  test("reasoning renders the same whether its parts arrive merged or as fragments", () => {
    const expected =
      "**Checking the workspace first**\n\n**Inspecting guidance** and then **more**";
    // The worker stores adjacent fragments as one delta, joined with the same
    // separator (`reasoningDeltaSeparator`); a row boundary may fall anywhere.
    for (const rows of [
      [expected],
      ["**Checking the workspace first**\n\n**Inspecting guidance**", " and then **more**"],
      ["**Checking the workspace first**", "**Inspecting guidance** and then **more**"],
    ]) {
      const items = buildTimeline(
        englishText,
        rows.map((text, index) => event(index + 1, "agent.reasoning.delta", { text })),
      );
      const reasoning = items.filter((item) => item.kind === "reasoning");
      expect(reasoning).toHaveLength(1);
      expect(reasoning[0]!.kind === "reasoning" && reasoning[0]!.text).toBe(expected);
    }
  });

  test("split bold markers retain reasoning text across read-page coalescing boundaries", () => {
    for (const parts of [
      ["*", "*", "**b"],
      ["**", "*", "*b"],
    ]) {
      const rows = parts.map((text, index) => ({
        ...event(index + 1, "agent.reasoning.delta", { text }),
        type: "agent.reasoning.delta" as const,
      }));
      const reasoning = (events: SessionEvent[]) =>
        buildTimeline(englishText, events).flatMap((item) =>
          item.kind === "reasoning" ? [item.text] : [],
        );
      const expected = reasoning(rows);
      for (let split = 0; split <= rows.length; split++) {
        expect(
          reasoning([
            ...coalesceSessionEventDeltas(rows.slice(0, split)),
            ...coalesceSessionEventDeltas(rows.slice(split)),
          ]),
        ).toEqual(expected);
      }
    }
  });
});
