import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@opengeni/sdk";
import { buildTimeline, groupTimeline } from "../src/timeline/projection";
import { toolRowPresentation } from "../src/timeline/tool-presentation";
import { approvalHistoryTitle, noticeDisplayText } from "../src/timeline/notice-presentation";
import type {
  NoticeItem,
  SessionStatusItem,
  TimelineGroup,
  ToolCallItem,
} from "../src/timeline/types";
import { createOpenGeniText } from "../src/messages/runtime";
import { coalesceSessionEventDeltas } from "@opengeni/events";

const englishText = createOpenGeniText();

describe("a tool call waiting for approval", () => {
  const waiting = [
    event(1, "turn.started"),
    event(2, "agent.toolCall.created", { id: "call-1", name: "deploy_preview", arguments: {} }),
    event(3, "session.requiresAction", {
      approvals: [{ id: "approval-1", name: "deploy_preview", rawItem: { callId: "call-1" } }],
    }),
  ];
  const call = (items: ReturnType<typeof buildTimeline>) =>
    items.find((item): item is ToolCallItem => item.kind === "tool-call")!;

  test("says it is waiting for the person, not that it is done", () => {
    const item = call(buildTimeline(englishText, waiting));
    expect(item.awaitingApproval).toBe(true);
    const row = toolRowPresentation(englishText, item);
    expect(row.preview).toEqual({ kind: "text", text: "Waiting for your approval" });
    expect(row.running).toBe(false);
    expect(row.iconTone).toBe("accent");
  });

  test("settles normally once its output arrives", () => {
    const item = call(
      buildTimeline(englishText, [
        ...waiting,
        event(4, "agent.toolCall.output", { id: "call-1", output: "Deployed" }),
      ]),
    );
    expect(item.awaitingApproval).toBeUndefined();
    expect(item.status).toBe("complete");
  });

  test("reads as not run when its turn is cancelled before a decision", () => {
    const item = call(buildTimeline(englishText, [...waiting, event(4, "turn.cancelled")]));
    expect(item.awaitingApproval).toBeUndefined();
    expect(item.status).toBe("cancelled");
  });

  // Decisions carry no turn id on the wire.
  const decide = (decision: "approve" | "reject") =>
    event(
      4,
      "user.approvalDecision",
      { approvalId: "call-1", decision },
      null as unknown as string,
    );

  test("reads as running as soon as it is approved, before its output arrives", () => {
    const item = call(buildTimeline(englishText, [...waiting, decide("approve")]));
    expect(item.awaitingApproval).toBeUndefined();
    expect(item.status).toBe("running");
    expect(toolRowPresentation(englishText, item).running).toBe(true);
  });

  test("says it was rejected as soon as it is rejected, and after the rejection output", () => {
    const rejected = [...waiting, decide("reject")];
    const item = call(buildTimeline(englishText, rejected));
    expect(item.awaitingApproval).toBeUndefined();
    const row = toolRowPresentation(englishText, item);
    expect(row.preview).toEqual({ kind: "text", text: "You declined this" });
    expect(row.running).toBe(false);
    expect(row.cancelled).toBe(false);
    const settled = call(
      buildTimeline(englishText, [
        ...rejected,
        event(5, "agent.toolCall.output", {
          id: "call-1",
          output: "Tool approval was rejected. This proposed tool call was not run.",
        }),
        event(6, "turn.completed"),
      ]),
    );
    expect(toolRowPresentation(englishText, settled).preview).toEqual({
      kind: "text",
      text: "You declined this",
    });
  });
});

describe("an answered approval", () => {
  const asking = (approvals: unknown[]) => [
    event(1, "turn.started"),
    event(2, "session.requiresAction", { approvals }),
    event(3, "session.status.changed", { status: "requires_action" }),
  ];
  const sendEmail = {
    id: "call-1",
    name: "send_message",
    display: { title: "Send email" },
    rawItem: { callId: "call-1" },
  };
  const notice = (items: ReturnType<typeof buildTimeline>) =>
    items.find((item): item is NoticeItem => item.kind === "notice" && item.approval === true)!;
  // Decisions carry no turn id on the wire.
  const decide = (sequence: number, approvalId: string, decision: "approve" | "reject") =>
    event(sequence, "user.approvalDecision", { approvalId, decision }, null as unknown as string);

  test("says what the person decided as soon as the decision is recorded", () => {
    const items = buildTimeline(englishText, [
      ...asking([sendEmail]),
      decide(4, "call-1", "approve"),
    ]);
    const item = notice(items);
    // Answered before the run resumes: no longer a live wait.
    expect(item.resolvedAt).toBe(new Date(Date.UTC(2026, 8, 30) + 4000).toISOString());
    expect(noticeDisplayText(englishText, item)).toBe("You approved “Send email”.");
    const status = items.find((each): each is SessionStatusItem => each.kind === "session-status");
    expect(status?.resolvedAt).toBe(item.resolvedAt);
  });

  test("says a rejection, and stays answered when the run resumes", () => {
    const items = buildTimeline(englishText, [
      ...asking([sendEmail]),
      decide(4, "call-1", "reject"),
      event(5, "session.status.changed", { status: "running" }),
    ]);
    const item = notice(items);
    expect(noticeDisplayText(englishText, item)).toBe("You declined “Send email”.");
    expect(item.resolvedAt).toBe(new Date(Date.UTC(2026, 8, 30) + 4000).toISOString());
  });

  test("waits for every action of the request before reading as answered", () => {
    const deploy = { id: "call-2", name: "deploy", rawItem: { callId: "call-2" } };
    const partial = buildTimeline(englishText, [
      ...asking([sendEmail, deploy]),
      decide(4, "call-1", "approve"),
    ]);
    expect(notice(partial).resolvedAt).toBeUndefined();
    const answered = buildTimeline(englishText, [
      ...asking([sendEmail, deploy]),
      decide(4, "call-1", "approve"),
      decide(5, "call-2", "reject"),
    ]);
    expect(noticeDisplayText(englishText, notice(answered))).toBe("You approved 1 and declined 1.");
  });

  test("without a recorded decision, says only that it was answered", () => {
    const item = notice(
      buildTimeline(englishText, [
        ...asking([sendEmail]),
        event(4, "session.status.changed", { status: "running" }),
      ]),
    );
    expect(noticeDisplayText(englishText, item)).toBe("You responded to this approval.");
  });

  test("parallel app-action approvals say what was decided, one line each, told apart", () => {
    const removal = (callId: string, title: string, added: string) => ({
      id: callId,
      name: "opengeni__admin_action_call",
      display: {
        toolName: "admin_action_call",
        title,
        facts: [
          { label: "Who can use it", value: "Only you" },
          { label: "Added", value: added },
        ],
      },
      rawItem: { callId },
    });
    const gmail = removal("c-1", "Remove the Gmail connection for bendik@cloudgeni.ai?", "14 Oct");
    const drive = removal(
      "c-2",
      "Remove the Google Drive connection for bendik@cloudgeni.ai?",
      "18 Aug",
    );
    const linearA = removal("c-3", "Remove the Linear connection for Bendik · Cloudgeni?", "2 Oct");
    const linearB = removal("c-4", "Remove the Linear connection for Bendik · Cloudgeni?", "9 Oct");
    const items = buildTimeline(englishText, [
      ...asking([gmail, drive, linearA, linearB]),
      decide(4, "c-1", "approve"),
      decide(5, "c-2", "reject"),
      decide(6, "c-3", "approve"),
      decide(7, "c-4", "approve"),
    ]);
    // Before, this read "You responded to this approval." whenever more than one was asked.
    expect(noticeDisplayText(englishText, notice(items)).split("\n")).toEqual([
      "You approved “Remove the Gmail connection for bendik@cloudgeni.ai”.",
      "You declined “Remove the Google Drive connection for bendik@cloudgeni.ai”.",
      "You approved “Remove the Linear connection for Bendik · Cloudgeni” (Added: 2 Oct).",
      "You approved “Remove the Linear connection for Bendik · Cloudgeni” (Added: 9 Oct).",
    ]);
    // A wait that resumed after one answer says that answer; the rest are asked again later.
    const resumed = buildTimeline(englishText, [
      ...asking([gmail, drive, linearA]),
      decide(4, "c-1", "approve"),
      event(5, "session.status.changed", { status: "running" }),
    ]);
    expect(noticeDisplayText(englishText, notice(resumed))).toBe(
      "You approved “Remove the Gmail connection for bendik@cloudgeni.ai”.",
    );
  });

  test("history keeps a quoted name's own question mark", () => {
    expect(approvalHistoryTitle("Delete Site “Why?”? It can't be undone.")).toBe(
      "Delete Site “Why?”",
    );
    expect(approvalHistoryTitle("Send email")).toBe("Send email");
  });

  test("a rejection Opengeni made itself is never the person's", () => {
    // An approval that expired, and a request Opengeni refused.
    const expired = {
      ...decide(4, "call-1", "reject"),
      clientEventId: "system:interaction-intervention-expired:intervention-1",
    };
    const refused = event(
      4,
      "user.approvalDecision",
      { approvalId: "call-1", decision: "reject", refusal: { code: "not_allowed" } },
      null as unknown as string,
    );
    for (const decision of [expired, refused]) {
      const items = buildTimeline(englishText, [
        ...asking([sendEmail]),
        event(5, "agent.toolCall.created", { id: "call-1", name: "send_message", arguments: {} }),
        decision,
      ]);
      expect(noticeDisplayText(englishText, notice(items))).toBe(
        "Declined automatically: “Send email”.",
      );
    }
    const mixed = buildTimeline(englishText, [
      ...asking([sendEmail, { id: "call-2", name: "deploy", rawItem: { callId: "call-2" } }]),
      decide(4, "call-1", "approve"),
      { ...decide(5, "call-2", "reject"), clientEventId: "system:interaction-request-refused:r" },
    ]);
    expect(noticeDisplayText(englishText, notice(mixed))).toBe("You responded to this approval.");
  });
});

test("a call Opengeni declined itself says so, not that the person rejected it", () => {
  const declined = buildTimeline(englishText, [
    event(1, "turn.started"),
    event(2, "agent.toolCall.created", { id: "call-1", name: "send_message", arguments: {} }),
    event(3, "session.requiresAction", {
      approvals: [{ id: "call-1", name: "send_message", rawItem: { callId: "call-1" } }],
    }),
    {
      ...event(
        4,
        "user.approvalDecision",
        { approvalId: "call-1", decision: "reject" },
        null as unknown as string,
      ),
      clientEventId: "system:interaction-intervention-expired:intervention-1",
    },
  ]);
  const item = declined.find((each): each is ToolCallItem => each.kind === "tool-call")!;
  expect(toolRowPresentation(englishText, item).preview).toEqual({
    kind: "text",
    text: "Declined automatically",
  });
});

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
