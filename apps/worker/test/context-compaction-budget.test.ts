import { expect, test } from "bun:test";
import {
  EmptyCompactionSummaryError,
  estimateTokens,
  type CompactionItem,
} from "@opengeni/runtime";
import { testSettings } from "@opengeni/testing";
import {
  summarizeWithCodexOverflowTrimming,
  type CompactionSummarizer,
} from "../src/activities/context-compaction";

const settings = testSettings({ contextWindowTokens: 26_000 });
const user = (content: string): CompactionItem => ({ type: "message", role: "user", content });

test("portable compaction reserves the prepared prefix before fitting history", async () => {
  const old = user(`old ${"a".repeat(7_500)}`);
  const recent = user(`recent ${"b".repeat(7_500)}`);
  const history = [old, recent];
  const original = JSON.stringify(history);
  const seen: CompactionItem[][] = [];
  const summarize: CompactionSummarizer = async (_settings, input) => {
    seen.push(input);
    return "checkpoint";
  };

  await summarizeWithCodexOverflowTrimming(summarize, settings, history);
  summarize.estimatePrefixTokens = () => 3_000;
  await summarizeWithCodexOverflowTrimming(summarize, settings, history);

  expect(seen[0]!.slice(0, -1)).toEqual(history);
  expect(seen[1]!.slice(0, -1)).toEqual([recent]);
  expect(JSON.stringify(history)).toBe(original);
});

test("one conservative retry fits a provider counting more than twice the local estimate", async () => {
  const old = user(`old ${"a".repeat(12_000)}`);
  const recent = user(`recent ${"b".repeat(600)}`);
  const history = [old, recent];
  const seen: CompactionItem[][] = [];
  const summarize: CompactionSummarizer = async (_settings, input) => {
    seen.push(input);
    if (estimateTokens(input) * 2.1 + 1_000 > 6_000) {
      throw Object.assign(new Error("context overflow"), { code: "context_length_exceeded" });
    }
    return "checkpoint";
  };
  summarize.estimatePrefixTokens = () => 1_000;

  const result = await summarizeWithCodexOverflowTrimming(summarize, settings, history);

  expect(result.summaryBody).toBe("checkpoint");
  expect(result.providerCalls).toBe(2);
  expect(seen[0]!.slice(0, -1)).toEqual(history);
  expect(seen[1]!.slice(0, -1)).toEqual([recent]);
  expect(history).toEqual([old, recent]);
});

test("a prefix that leaves no history room fails before asking for a summary", async () => {
  const history = [user("preserve this history")];
  let calls = 0;
  const summarize: CompactionSummarizer = async () => {
    calls += 1;
    return "unsupported checkpoint";
  };
  summarize.estimatePrefixTokens = () => 6_000;

  await expect(
    summarizeWithCodexOverflowTrimming(summarize, settings, history),
  ).rejects.toMatchObject({
    name: "EmptyCompactionSummaryError",
    diagnostics: { stage: "portable_input_budget", reason: "no_history_fit" },
  });
  expect(calls).toBe(0);
  expect(history).toEqual([user("preserve this history")]);
});

test("a retry that leaves no source history fails closed", async () => {
  const history = [user("only source history")];
  let calls = 0;
  const summarize: CompactionSummarizer = async () => {
    calls += 1;
    throw Object.assign(new Error("context overflow"), { code: "context_length_exceeded" });
  };

  await expect(
    summarizeWithCodexOverflowTrimming(summarize, settings, history),
  ).rejects.toBeInstanceOf(EmptyCompactionSummaryError);
  expect(calls).toBe(1);
  expect(history).toEqual([user("only source history")]);
});

test("opaque-only history cannot be replaced by a checkpoint the model never saw", async () => {
  const history: CompactionItem[] = [
    { type: "reasoning", providerData: { encrypted_content: "opaque" } },
  ];
  let calls = 0;
  const summarize: CompactionSummarizer = async () => {
    calls += 1;
    return "unsupported checkpoint";
  };

  await expect(
    summarizeWithCodexOverflowTrimming(summarize, settings, history),
  ).rejects.toBeInstanceOf(EmptyCompactionSummaryError);
  expect(calls).toBe(0);
});
