import { describe, expect, test } from "bun:test";
import { SHARED_SESSION_MAX_MESSAGES } from "@opengeni/contracts";

import {
  buildSharedSessionSnapshot,
  sharedMessageText,
} from "../src/application/session-share-links";

type Event = Parameters<typeof buildSharedSessionSnapshot>[0][number];

function event(
  sequence: number,
  type: string,
  payload: unknown,
  turnId: string | null = null,
): Event {
  return { sequence, type, turnId, payload } as Event;
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
