import { describe, expect, test } from "bun:test";
import { SHARED_SESSION_MAX_MESSAGES, SessionEventType } from "@opengeni/contracts";
import { isTurnExecutionEvidence } from "@opengeni/contracts/timeline-order";

import {
  buildSharedSessionSnapshot,
  plainShareTitle,
  SNAPSHOT_EVENT_TYPES,
  sharedMessageText,
  sharedSenderName,
} from "../src/application/session-share-links";

type Event = Parameters<typeof buildSharedSessionSnapshot>[0][number];

function event(
  sequence: number,
  type: string,
  payload: unknown,
  turnId: string | null = null,
): Event {
  return { id: `e${sequence}`, sequence, type, turnId, payload } as Event;
}

/** A message the person sent while a turn was running: it waits in the queue as its own turn. */
function queued(sequence: number, text: string, turnId: string): Event[] {
  return [
    event(sequence, "user.message", { text, routing: "queued_for_execution" }),
    event(
      sequence + 1,
      "turn.queued",
      { turnId, triggerEventId: `e${sequence}`, routing: "queued_for_execution" },
      turnId,
    ),
  ];
}

describe("chat share link snapshot", () => {
  test("keeps only what the person typed and the replies shown to them", () => {
    const { snapshot, throughSequence } = buildSharedSessionSnapshot([
      event(1, "user.message", {
        text: "Can you check my calendar for Friday?",
        initiator: { kind: "subject", subjectId: "user:a" },
        annotations: [{ quote: "private quote", note: "private note" }],
        modelContext: [{ text: "PRIVATE MODEL CONTEXT" }],
        attachments: [{ name: "passport.pdf" }],
      }),
      event(2, "agent.message.completed", { text: "Let me look.", phase: "commentary" }, "t1"),
      event(3, "tool.call.completed", { output: "PRIVATE CALENDAR ROW: dentist 9:00" }, "t1"),
      event(
        4,
        "agent.message.completed",
        { text: "Friday is free after noon.", phase: "final_answer" },
        "t1",
      ),
      event(5, "turn.completed", {}, "t1"),
      event(6, "user.message", {
        text: "Daily brief",
        initiator: { kind: "schedule", scheduleId: "s1" },
      }),
      event(7, "user.message", { text: "Thanks!" }),
    ]);
    expect(snapshot).toEqual({
      messages: [
        { role: "user", text: "Can you check my calendar for Friday?" },
        { role: "assistant", text: "Friday is free after noon." },
        { role: "user", text: "Thanks!" },
      ],
      omittedMessageCount: 0,
    });
    expect(throughSequence).toBe(7);
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
  });

  test("a finished turn without a final answer shows its first and last notes; a running one shows none", () => {
    const { snapshot } = buildSharedSessionSnapshot([
      event(1, "agent.message.completed", { text: "Starting.", phase: "commentary" }, "done"),
      event(2, "agent.message.completed", { text: "Middle.", phase: "commentary" }, "done"),
      event(3, "agent.message.completed", { text: "Stopped here.", phase: "commentary" }, "done"),
      event(4, "turn.failed", {}, "done"),
      event(5, "agent.message.completed", { text: "Working on it…", phase: "commentary" }, "live"),
    ]);
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "Starting.",
      "Stopped here.",
    ]);
  });

  test("shows exactly what the chat shows: queued messages only once they ran, never one deleted, edited or cancelled first", () => {
    const { snapshot } = buildSharedSessionSnapshot([
      event(1, "user.message", { text: "Plan a dinner", routing: "accepted_for_execution" }),
      event(
        2,
        "turn.queued",
        { turnId: "t1", triggerEventId: "e1", routing: "accepted_for_execution" },
        "t1",
      ),
      event(3, "turn.started", { triggerEventId: "e1" }, "t1"),
      ...queued(4, "My bank PIN is 4321", "t2"),
      ...queued(6, "Book for 6 people", "t3"),
      ...queued(8, "Never mind this one", "t4"),
      // Deleted from the queue, taken back to edit, and cancelled, all before they started.
      event(10, "session.queue.changed", { operation: "delete", turnId: "t2" }, "t2"),
      event(11, "session.queue.changed", { operation: "edit", turnId: "t3" }, "t3"),
      event(12, "turn.cancelled", {}, "t4"),
      event(13, "agent.message.completed", { text: "Here's a plan.", phase: "final_answer" }, "t1"),
      event(14, "turn.completed", {}, "t1"),
      // The edited message, sent again: its final version.
      ...queued(15, "Book for 8 people", "t5"),
      event(17, "turn.started", { triggerEventId: "e15" }, "t5"),
      event(18, "agent.message.completed", { text: "Booked for 8.", phase: "final_answer" }, "t5"),
      event(19, "turn.completed", {}, "t5"),
      // Still waiting in the queue when the chat was shared.
      ...queued(20, "Also order flowers", "t6"),
    ]);
    expect(snapshot.messages).toEqual([
      { role: "user", text: "Plan a dinner" },
      { role: "assistant", text: "Here's a plan." },
      { role: "user", text: "Book for 8 people" },
      { role: "assistant", text: "Booked for 8." },
    ]);
    const published = JSON.stringify(snapshot);
    for (const hidden of ["PIN", "Book for 6", "Never mind", "flowers"]) {
      expect(published).not.toContain(hidden);
    }
  });

  test("a queued message enters where its turn started, as in the chat", () => {
    const { snapshot } = buildSharedSessionSnapshot([
      event(1, "user.message", { text: "First", routing: "accepted_for_execution" }),
      event(
        2,
        "turn.queued",
        { turnId: "t1", triggerEventId: "e1", routing: "accepted_for_execution" },
        "t1",
      ),
      event(3, "turn.started", { triggerEventId: "e1" }, "t1"),
      ...queued(4, "Second, sent while the first ran", "t2"),
      event(6, "agent.message.completed", { text: "First answer.", phase: "final_answer" }, "t1"),
      event(7, "turn.completed", {}, "t1"),
      event(8, "turn.started", { triggerEventId: "e4" }, "t2"),
      event(9, "agent.message.completed", { text: "Second answer.", phase: "final_answer" }, "t2"),
      event(10, "turn.completed", {}, "t2"),
    ]);
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "First",
      "First answer.",
      "Second, sent while the first ran",
      "Second answer.",
    ]);
  });

  test("reads every kind the timeline counts as a turn having run, except bulk that follows a model request", () => {
    const evidence = SessionEventType.options.filter(isTurnExecutionEvidence);
    const skipped = evidence.filter((type) => !SNAPSHOT_EVENT_TYPES.includes(type));
    expect(skipped.sort()).toEqual(
      evidence
        .filter(
          (type) =>
            type.endsWith(".delta") ||
            type.startsWith("agent.toolCall.") ||
            type === "agent.model.usage",
        )
        .sort(),
    );
    expect(SNAPSHOT_EVENT_TYPES).toContain("agent.model.request");
    expect(SNAPSHOT_EVENT_TYPES).toContain("turn.startup.phase.started");
    expect(SNAPSHOT_EVENT_TYPES).toContain("tool.auth_needed");
  });

  test("an older chat without turn.started places a queued message where its turn first ran", () => {
    const { snapshot } = buildSharedSessionSnapshot([
      event(1, "user.message", { text: "First", routing: "accepted_for_execution" }),
      event(
        2,
        "turn.queued",
        { turnId: "t1", triggerEventId: "e1", routing: "accepted_for_execution" },
        "t1",
      ),
      event(3, "turn.started", { triggerEventId: "e1" }, "t1"),
      ...queued(4, "Second, sent while the first ran", "t2"),
      event(6, "agent.message.completed", { text: "First answer.", phase: "final_answer" }, "t1"),
      event(7, "turn.completed", {}, "t1"),
      event(8, "turn.startup.phase.started", {}, "t2"),
      event(9, "agent.message.completed", { text: "Second answer.", phase: "final_answer" }, "t2"),
      event(10, "turn.completed", {}, "t2"),
    ]);
    expect(snapshot.messages.map((message) => message.text)).toEqual([
      "First",
      "First answer.",
      "Second, sent while the first ran",
      "Second answer.",
    ]);
  });

  test("labels each person's messages with the name the chat shows for them", () => {
    const { snapshot } = buildSharedSessionSnapshot(
      [
        event(1, "user.message", { text: "Older message with no initiator" }),
        event(2, "user.message", {
          text: "Hi from the starter",
          initiator: { kind: "subject", subjectId: "user:a", label: "a@example.test" },
        }),
        event(3, "user.message", {
          text: "Hi from a colleague",
          initiator: { kind: "subject", subjectId: "user:b", label: "Kari" },
        }),
        event(4, "user.message", {
          text: "No name known",
          initiator: { kind: "subject", subjectId: "user:c" },
        }),
      ],
      {
        starterSubjectId: "user:a",
        names: new Map([
          ["user:a", "Olav Berg"],
          ["user:b", "Kari Berg"],
        ]),
      },
    );
    expect(snapshot.messages).toEqual([
      { role: "user", text: "Older message with no initiator", sender: "Olav Berg" },
      { role: "user", text: "Hi from the starter", sender: "Olav Berg" },
      { role: "user", text: "Hi from a colleague", sender: "Kari Berg" },
      { role: "user", text: "No name known" },
    ]);
  });

  test("a sender's name is never an email address or an id", () => {
    expect(sharedSenderName("user:a", "Olav Berg", "olav@example.test")).toBe("Olav Berg");
    expect(sharedSenderName("user:a", "olav@example.test", "Olav")).toBe("Olav");
    expect(sharedSenderName("user:a", null, "olav@example.test")).toBeNull();
    expect(sharedSenderName("user:a", "user:a", null)).toBeNull();
    expect(sharedSenderName("user:a", "  ", undefined)).toBeNull();
    expect(sharedSenderName("user:a", "x".repeat(300), null)).toHaveLength(120);
  });

  test("the title is plain words, without markdown", () => {
    expect(plainShareTitle("## **Birthday** _dinner_ plan with `cake`")).toBe(
      "Birthday dinner plan with cake",
    );
    expect(plainShareTitle("See [the menu](https://example.com/menu)")).toBe("See the menu");
    expect(plainShareTitle("snake_case_name stays")).toBe("snake_case_name stays");
  });

  test("reference links and autolinks to the chat's own files keep only their words", () => {
    expect(
      sharedMessageText(
        [
          "See [the report][1] and [notes] and <sandbox:/workspace/plan%20v2.md>.",
          "Also <artifact:0123abcd-0123-4abc-8def-0123456789ab> and [docs][2].",
          "",
          "[1]: artifact:0123abcd-0123-4abc-8def-0123456789ab",
          "[notes]: <sandbox:/workspace/notes.md>",
          "[2]: https://example.com/docs",
        ].join("\n"),
      ),
    ).toBe(
      [
        "See the report and notes and plan v2.md.",
        "Also and [docs][2].",
        "",
        "[2]: https://example.com/docs",
      ].join("\n"),
    );
  });

  test("images and links to the chat's own files keep only their words", () => {
    expect(
      sharedMessageText(
        "Here: ![chart](artifact:abc) and [the report](artifact:0123) or [notes](<sandbox:/workspace/a b.md>), see [docs](https://example.com).",
      ),
    ).toBe("Here: [image not included] and the report or notes, see [docs](https://example.com).");
  });

  test("keeps the newest messages when the chat is larger than a link holds", () => {
    const events = Array.from({ length: SHARED_SESSION_MAX_MESSAGES + 5 }, (_, index) =>
      event(index + 1, "user.message", { text: `message ${index + 1}` }),
    );
    const { snapshot } = buildSharedSessionSnapshot(events);
    expect(snapshot.messages).toHaveLength(SHARED_SESSION_MAX_MESSAGES);
    expect(snapshot.omittedMessageCount).toBe(5);
    expect(snapshot.messages[0]!.text).toBe("message 6");
    expect(snapshot.messages.at(-1)!.text).toBe(`message ${SHARED_SESSION_MAX_MESSAGES + 5}`);
  });
});
