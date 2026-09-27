import { describe, expect, test } from "bun:test";
import {
  assistantMessagePhase,
  isStreamedAssistantMessageCompletion,
  turnCompletedReply,
} from "../src/index";

const completed = (payload: unknown) => ({ type: "agent.message.completed", payload });

describe("assistant message phase helpers", () => {
  test("reads only the two declared phases", () => {
    expect(assistantMessagePhase({ phase: "commentary" })).toBe("commentary");
    expect(assistantMessagePhase({ phase: "final_answer" })).toBe("final_answer");
    for (const payload of [{ phase: "final" }, { phase: null }, {}, null, "commentary", []]) {
      expect(assistantMessagePhase(payload)).toBeNull();
    }
  });

  test("a streamed completion carries a provider id or a phase; the settlement copy neither", () => {
    expect(isStreamedAssistantMessageCompletion(completed({ text: "a", messageId: "msg_1" }))).toBe(
      true,
    );
    expect(
      isStreamedAssistantMessageCompletion(completed({ text: "a", phase: "final_answer" })),
    ).toBe(true);
    expect(isStreamedAssistantMessageCompletion(completed({ text: "a" }))).toBe(false);
    expect(isStreamedAssistantMessageCompletion(completed({ text: "a", messageId: "" }))).toBe(
      false,
    );
    expect(
      isStreamedAssistantMessageCompletion({ type: "turn.completed", payload: { messageId: "x" } }),
    ).toBe(false);
  });

  test("a wait-ended turn's reply is a nonblank string beside its empty output", () => {
    expect(turnCompletedReply({ output: "", reply: "Two of ten are done." })).toBe(
      "Two of ten are done.",
    );
    for (const payload of [{ output: "" }, { output: "", reply: " \n" }, { reply: 1 }, null, []]) {
      expect(turnCompletedReply(payload)).toBeNull();
    }
  });
});
