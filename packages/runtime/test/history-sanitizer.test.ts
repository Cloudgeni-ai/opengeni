import { describe, expect, test } from "bun:test";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";

// Item shapes mirror the SDK's canonical history representation
// (`type` discriminator, camelCase `callId`) that is persisted verbatim into
// session_history_items and replayed into the Responses API.
function reasoning(id: string) {
  return { type: "reasoning", id, content: [{ type: "input_text", text: "thinking" }] };
}
function userMessage(text: string) {
  return { type: "message", role: "user", content: text };
}
function assistantMessage(text: string) {
  return { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
}
function functionCall(callId: string, name = "tool") {
  return { type: "function_call", callId, name, arguments: "{}", status: "completed" };
}
function functionResult(callId: string) {
  return { type: "function_call_result", callId, status: "completed", output: { type: "text", text: "ok" } };
}

describe("sanitizeHistoryItemsForModel", () => {
  test("drops an orphaned function_call_result whose function_call is absent", () => {
    // This is the session-bricking corruption: a tool output replayed without
    // its tool call (observed live for journal / goal-pause tools near turn
    // boundaries). The API 400s on the whole request until it is removed.
    const items = [
      userMessage("do the thing"),
      functionResult("call_orphan"),
      assistantMessage("done"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    expect(result).toEqual([items[0], items[2]]);
    expect(result.some((item) => (item as any).type === "function_call_result")).toBe(false);
  });

  test("drops a result whose call appears only AFTER it (still an orphan to the API)", () => {
    const call = functionCall("call_late");
    const result = functionResult("call_late");
    // Result before its call: the API still rejects it.
    const items = [userMessage("hi"), result, call];
    const sanitized = sanitizeHistoryItemsForModel(items);
    // The result is dropped; the now-dangling call is dropped too (no result
    // after it), leaving just the user message.
    expect(sanitized).toEqual([items[0]]);
  });

  test("drops a dangling function_call that has no result", () => {
    const items = [
      userMessage("hi"),
      reasoning("rs_1"),
      functionCall("call_dangling"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    // The dangling call is dropped, and the reasoning item that produced it is
    // dropped with it (Responses API ties reasoning to its following call).
    expect(result).toEqual([items[0]]);
  });

  test("keeps reasoning when its following call is well-formed", () => {
    const items = [
      userMessage("hi"),
      reasoning("rs_keep"),
      functionCall("call_ok"),
      functionResult("call_ok"),
      assistantMessage("done"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    expect(result).toEqual(items);
  });

  test("leaves a well-formed history byte-identical (same references and order)", () => {
    const items = [
      userMessage("first"),
      functionCall("call_a"),
      functionResult("call_a"),
      assistantMessage("a done"),
      userMessage("second"),
      reasoning("rs_b"),
      functionCall("call_b"),
      functionResult("call_b"),
      assistantMessage("b done"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    expect(result).toHaveLength(items.length);
    result.forEach((item, index) => {
      // Same reference, not a clone — the valid items pass through untouched.
      expect(item).toBe(items[index]);
    });
  });

  test("keeps valid pairs while dropping an orphan in a parallel tool-call batch", () => {
    // Parallel batch where one call/result pair is intact and a second result
    // was orphaned (its call lost to a write-path desync). Only the orphan goes.
    const items = [
      userMessage("go"),
      functionCall("call_a"),
      functionCall("call_b"),
      functionResult("call_a"),
      functionResult("call_b"),
      functionResult("call_ghost"),
      assistantMessage("done"),
    ];
    const result = sanitizeHistoryItemsForModel(items);
    expect(result).toEqual([
      items[0], items[1], items[2], items[3], items[4], items[6],
    ]);
  });

  test("accepts snake_case call_id correlation as well as camelCase callId", () => {
    const call = { type: "function_call", call_id: "call_snake", name: "t", arguments: "{}" };
    const orphan = { type: "function_call_result", call_id: "call_missing", output: { type: "text", text: "x" } };
    const result = { type: "function_call_result", call_id: "call_snake", output: { type: "text", text: "ok" } };
    const items = [userMessage("hi"), call, result, orphan];
    const sanitized = sanitizeHistoryItemsForModel(items);
    expect(sanitized).toEqual([items[0], call, result]);
  });

  test("empty input returns empty", () => {
    expect(sanitizeHistoryItemsForModel([])).toEqual([]);
  });

  test("does not mutate the input array or its items", () => {
    const orphan = functionResult("call_x");
    const items = [userMessage("hi"), orphan];
    const snapshot = JSON.stringify(items);
    sanitizeHistoryItemsForModel(items);
    expect(items).toHaveLength(2);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});
