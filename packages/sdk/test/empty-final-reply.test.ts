import { expect, test } from "bun:test";
import { EMPTY_FINAL_REPLY_NOTICE, turnCompletedWithEmptyFinalReply } from "../src/index";
import { ChatTurnFold } from "../src/chat/fold";
import type { SessionEvent } from "../src/types";

test("typed empty final completes SDK chat without an error and exposes the notice", () => {
  const fold = new ChatTurnFold("workspace", "session", "turn");
  const event = {
    id: "event",
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    sequence: 1,
    type: "turn.completed",
    payload: { output: "", emptyFinalReply: true },
    occurredAt: "2026-09-30T17:30:00.000Z",
  } as SessionEvent;
  expect(fold.push(event)).toEqual({ chunks: [], terminal: "completed" });
  expect(fold.failure).toBeNull();
  expect(fold.reply("completed")).toMatchObject({
    status: "completed",
    text: "",
    emptyFinalReply: true,
    notice: EMPTY_FINAL_REPLY_NOTICE,
  });
});

test("ordinary completed turns and wait outputs are not classified as empty-final notices", () => {
  expect(turnCompletedWithEmptyFinalReply({ output: "" })).toBe(false);
  expect(turnCompletedWithEmptyFinalReply({ emptyFinalReply: "true" })).toBe(false);
  expect(turnCompletedWithEmptyFinalReply(null)).toBe(false);
});

test("marked completion does not promote preceding commentary into a final answer", () => {
  const fold = new ChatTurnFold("workspace", "session", "turn");
  const base = {
    workspaceId: "workspace",
    sessionId: "session",
    turnId: "turn",
    occurredAt: "2026-09-30T17:30:00.000Z",
  };
  expect(
    fold.push({
      ...base,
      id: "commentary",
      sequence: 1,
      type: "agent.message.completed",
      payload: { text: "I will verify the result.", phase: "commentary", messageId: "progress" },
    } as SessionEvent).chunks,
  ).toEqual([]);
  for (let sequence = 2; sequence <= 3; sequence++)
    expect(
      fold.push({
        ...base,
        id: `empty-${sequence}`,
        sequence,
        type: "agent.message.completed",
        payload: { text: "", phase: "final_answer", messageId: `final-${sequence}` },
      } as SessionEvent).chunks,
    ).toEqual([]);
  expect(
    fold.push({
      ...base,
      id: "completed",
      sequence: 4,
      type: "turn.completed",
      payload: { output: "", emptyFinalReply: true },
    } as SessionEvent),
  ).toEqual({ chunks: [], terminal: "completed" });
  expect(fold.reply("completed")).toMatchObject({
    text: "",
    emptyFinalReply: true,
    notice: EMPTY_FINAL_REPLY_NOTICE,
  });
});
