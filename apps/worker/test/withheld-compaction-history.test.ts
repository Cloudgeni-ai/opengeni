import { expect, test } from "bun:test";
import { withheldHistoryCovers } from "../src/activities/context-compaction";

const user = (text: string) => ({ type: "message", role: "user", content: text });
const call = (callId: string) => ({ type: "function_call", callId, name: "read", arguments: "{}" });
const result = (callId: string, output = "ok") => ({
  type: "function_call_result",
  callId,
  name: "read",
  output,
});
const disclosure = { type: "message", role: "developer", content: "Tools are now available." };

const durable = [user("start"), call("a"), result("a"), user("next"), call("b"), result("b")];

test("a withheld request covers durable history when it only adds request-local items", () => {
  expect(
    withheldHistoryCovers([...durable.slice(0, 3), disclosure, ...durable.slice(3)], durable),
  ).toBe(true);
  // Contents may be rewritten in place (bounded tool output) without losing coverage.
  expect(withheldHistoryCovers([...durable.slice(0, 5), result("b", "[bounded]")], durable)).toBe(
    true,
  );
});

test("a tool result or user message the request lacks means it is stale", () => {
  expect(withheldHistoryCovers(durable.slice(0, -1), durable)).toBe(false);
  expect(withheldHistoryCovers(durable, [...durable, user("steer")])).toBe(false);
});
