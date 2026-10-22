import { expect, test } from "bun:test";
import { compactionPrefixCuts, fitCompactionPrefix } from "../src/anthropic-compaction";
import { anthropicMessages } from "../src/anthropic-messages";
import type { CompactionItem } from "../src/context-compaction";
import type { ModelRequest } from "@openai/agents";

const user = (content: string): CompactionItem => ({ type: "message", role: "user", content });
const assistant = (content: string): CompactionItem => ({
  type: "message",
  role: "assistant",
  content,
});
const reasoning = {
  type: "reasoning",
  providerData: {
    anthropic: {
      block: { type: "thinking", thinking: "Keep the batch", signature: "synthetic-signature" },
    },
  },
};
const call = (id: string): CompactionItem => ({
  type: "function_call",
  callId: id,
  name: "inspect",
  arguments: "{}",
});
const result = (id: string): CompactionItem => ({
  type: "function_call_result",
  callId: id,
  output: "retained image receipt",
});

test("cuts preserve parallel tools, signed reasoning and the complete unread user phase", async () => {
  const items = [
    user("first"),
    assistant("old response"),
    user("continue"),
    reasoning,
    call("a"),
    call("b"),
    result("b"),
    result("a"),
    user("new direction"),
  ];
  expect(compactionPrefixCuts(items)).toEqual([1, 2, 3]);
  const cut = await fitCompactionPrefix(items, async () => true, true);
  expect(cut).toBe(3);
  const suffix = items.slice(cut!);
  expect(suffix).toEqual([
    reasoning,
    call("a"),
    call("b"),
    result("b"),
    result("a"),
    user("new direction"),
  ]);
  expect(() => anthropicMessages(items.slice(0, cut!) as ModelRequest["input"])).not.toThrow();
  expect(() => anthropicMessages(suffix as ModelRequest["input"])).not.toThrow();
  expect(reasoning.providerData.anthropic.block.signature).toBe("synthetic-signature");
});

test("fits the largest whole prefix and does not modify or silently drop its suffix", async () => {
  const items = [user("one"), assistant("old"), user("two"), assistant("old two"), user("current")];
  const before = structuredClone(items);
  let measurements = 0;
  expect(
    await fitCompactionPrefix(
      items,
      async (prefix) => {
        measurements++;
        return prefix.length <= 3;
      },
      true,
    ),
  ).toBe(3);
  expect(measurements).toBeLessThanOrEqual(3);
  expect(items).toEqual(before);
  expect(await fitCompactionPrefix(items, async () => true, false)).toBe(items.length);
});

test("irreducible input and unfinished tool batches cannot manufacture a checkpoint source", async () => {
  expect(
    await fitCompactionPrefix([user("single huge new image")], async () => false, true),
  ).toBeNull();
  expect(
    compactionPrefixCuts([
      user("inspect"),
      reasoning,
      call("a"),
      call("b"),
      result("a"),
      user("pending"),
    ]),
  ).toEqual([1]);
  expect(
    await fitCompactionPrefix([user("huge"), assistant("reply")], async () => false, true),
  ).toBeNull();
});

test("native provider correlation is preserved and unidentified tool calls stop later cuts", () => {
  const native = [
    user("search"),
    { type: "tool_search_call", id: "stream-call", providerData: { call_id: "native-call" } },
    { type: "tool_search_output", id: "stream-output", providerData: { call_id: "native-call" } },
    assistant("found"),
    user("next"),
  ];
  expect(compactionPrefixCuts(native)).toEqual([1, 3, 4]);
  expect(
    compactionPrefixCuts([
      user("search"),
      { type: "tool_search_call" },
      user("next"),
      assistant("done"),
    ]),
  ).toEqual([1]);
});
