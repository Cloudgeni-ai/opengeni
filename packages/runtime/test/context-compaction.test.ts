import { describe, expect, test } from "bun:test";
import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  COMPACTION_PROMPT,
  COMPACTION_SUMMARY_MARKER,
  CompactionNeededError,
  SUMMARY_BUFFER_TOKENS,
  SUMMARY_PREFIX,
  USER_MESSAGE_TRUNCATION_MARKER,
  buildCompactionPromptInput,
  buildCompactionReplacementHistory,
  buildSummaryItem,
  clientCompactionThresholdTokens,
  decideClientCompaction,
  enforceInputBudget,
  estimateTokens,
  findCompactionNeededError,
  findKeepBoundary,
  isCompactionSummary,
  isUserMessage,
  type CompactionItem,
} from "../src/context-compaction";
import { extractResponseOutputText } from "../src/index";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";

function user(text: string): CompactionItem {
  return { type: "message", role: "user", content: text };
}

function userParts(parts: unknown[]): CompactionItem {
  return { type: "message", role: "user", content: parts };
}

function assistant(text: string): CompactionItem {
  return { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] };
}

function call(id: string, name = "shell"): CompactionItem {
  return { type: "function_call", callId: id, name, arguments: "{}" };
}

function result(id: string, output = "ok"): CompactionItem {
  return { type: "function_call_result", callId: id, status: "completed", output };
}

function bigUser(tokens: number, char: string): CompactionItem {
  return user(char.repeat(tokens * 4));
}

const WINDOW = 1_050_000;
const RESERVED_OUTPUT = 128_000;
const THRESHOLD = Math.floor((WINDOW - RESERVED_OUTPUT - SUMMARY_BUFFER_TOKENS) * 0.9);

describe("codex-parity constants and summary marker", () => {
  test("uses Codex's checkpoint prompt and summary prefix verbatim", () => {
    expect(COMPACTION_PROMPT).toBe([
      "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
      "",
      "Include:",
      "- Current progress and key decisions made",
      "- Important context, constraints, or user preferences",
      "- What remains to be done (clear next steps)",
      "- Any critical data, examples, or references needed to continue",
      "",
      "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
    ].join("\n"));
    expect(SUMMARY_PREFIX).toBe(
      "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:",
    );
  });

  test("buildSummaryItem preserves the OpenGeni marker for UI rendering", () => {
    const item = buildSummaryItem("handoff body");
    expect(isUserMessage(item)).toBe(true);
    expect(isCompactionSummary(item)).toBe(true);
    expect(item[COMPACTION_SUMMARY_MARKER]).toBe(true);
    expect(item.content).toBe(`${SUMMARY_PREFIX}\nhandoff body`);
  });
});

describe("single client compaction threshold", () => {
  test("computes 90 percent of window minus reserved output minus summary buffer", () => {
    expect(clientCompactionThresholdTokens({
      contextWindowTokens: WINDOW,
      contextReservedOutputTokens: RESERVED_OUTPUT,
    })).toBe(THRESHOLD);
  });

  test("prefers provider-reported input tokens over the estimate", () => {
    const items = [bigUser(900_000, "x")];
    const decision = decideClientCompaction({
      items,
      lastInputTokens: 10,
      contextWindowTokens: WINDOW,
      contextReservedOutputTokens: RESERVED_OUTPUT,
    });
    expect(decision.signalTokens).toBe(10);
    expect(decision.shouldCompact).toBe(false);
  });

  test("uses char/4 estimate only when there is no provider signal yet", () => {
    const items = [bigUser(THRESHOLD + 1, "x")];
    const decision = decideClientCompaction({
      items,
      lastInputTokens: null,
      contextWindowTokens: WINDOW,
      contextReservedOutputTokens: RESERVED_OUTPUT,
    });
    expect(decision.signalTokens).toBeGreaterThan(THRESHOLD);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("above_threshold");
  });

  test("force keeps manual /compact working below the threshold", () => {
    const decision = decideClientCompaction({
      items: [user("small")],
      lastInputTokens: 1,
      contextWindowTokens: WINDOW,
      contextReservedOutputTokens: RESERVED_OUTPUT,
      force: true,
    });
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("force");
  });
});

describe("codex-parity rebuild", () => {
  test("summarizer input is current active history plus the checkpoint prompt", () => {
    const active = [user("u1"), assistant("a1"), call("c1"), result("c1")];
    const promptInput = buildCompactionPromptInput(active);
    expect(promptInput.slice(0, -1)).toEqual(active);
    expect(promptInput.at(-1)).toEqual({ type: "message", role: "user", content: COMPACTION_PROMPT });
  });

  test("replacement history keeps only real user messages plus one summary", () => {
    const prior = buildSummaryItem("prior summary");
    const active = [
      user("first user"),
      assistant("assistant dropped"),
      call("c1"),
      result("c1"),
      prior,
      user("second user"),
    ];
    const rebuilt = buildCompactionReplacementHistory(active, "new summary");
    expect(rebuilt).toHaveLength(3);
    expect(rebuilt[0]).toMatchObject(user("first user"));
    expect(rebuilt[1]).toMatchObject(user("second user"));
    expect(rebuilt[2]).toMatchObject({
      type: "message",
      role: "user",
      [COMPACTION_SUMMARY_MARKER]: true,
    });
    expect(rebuilt.some((item) => item === prior)).toBe(false);
    expect(rebuilt.some((item) => item.type === "function_call")).toBe(false);
  });

  test("drops images from retained user messages", () => {
    const rebuilt = buildCompactionReplacementHistory([
      userParts([
        { type: "input_text", text: "look at this" },
        { type: "input_image", image_url: "data:image/png;base64,abc" },
      ]),
    ], "summary");
    expect((rebuilt[0] as { content?: unknown }).content).toEqual([{ type: "input_text", text: "look at this" }]);
  });

  test("caps each retained user message at 20k estimated tokens with a middle marker", () => {
    const long = `${"a".repeat((COMPACT_USER_MESSAGE_MAX_TOKENS * 2) * 4)}TAIL`;
    const rebuilt = buildCompactionReplacementHistory([user(long)], "summary");
    const content = String(rebuilt[0]!.content);
    expect(content).toContain(USER_MESSAGE_TRUNCATION_MARKER.trim());
    expect(content.startsWith("aaaa")).toBe(true);
    expect(content.endsWith("TAIL")).toBe(true);
    expect(Math.ceil(content.length / 4)).toBeLessThanOrEqual(COMPACT_USER_MESSAGE_MAX_TOKENS);
  });

  test("rebuilt active history is orphan-clean because tool items are dropped", () => {
    const rebuilt = buildCompactionReplacementHistory([
      user("old"),
      call("c0"),
      result("c0"),
      assistant("done"),
      user("new"),
    ], "summary");
    expect(sanitizeHistoryItemsForModel(rebuilt)).toEqual(rebuilt);
  });
});

describe("CompactionNeededError", () => {
  test("carries signal metadata and can be found through causes", () => {
    const error = new CompactionNeededError({
      signalTokens: 12,
      thresholdTokens: 10,
      signalSource: "provider",
    });
    expect(error.signalTokens).toBe(12);
    expect(findCompactionNeededError({ cause: error })).toBe(error);
  });
});

describe("enforceInputBudget (read-path guard backstop)", () => {
  test("leaves an in-budget input untouched", () => {
    const items: CompactionItem[] = [user("a"), assistant("b"), user("c"), assistant("d")];
    const out = enforceInputBudget(items, 1_000_000);
    expect(out.trimmed).toBe(false);
    expect(out.items).toEqual(items);
  });

  test("trims the oldest history at a clean boundary until it fits", () => {
    const items: CompactionItem[] = [
      user("old turn"), assistant("x".repeat(1_000_000)),
      user("recent turn"), assistant("kept"),
    ];
    const out = enforceInputBudget(items, 100);
    expect(out.trimmed).toBe(true);
    expect(out.items).toContainEqual(user("recent turn"));
    expect(out.items).not.toContainEqual(user("old turn"));
  });

  test("accounts for trailing tokens", () => {
    const items: CompactionItem[] = [
      user("old"), assistant("x".repeat(400)),
      user("recent"), assistant("a"),
    ];
    const out = enforceInputBudget(items, estimateTokens(items), 200);
    expect(out.trimmed).toBe(true);
  });

  test("does not split tool-call pairs", () => {
    const items: CompactionItem[] = [
      user("old"), call("c0"), result("c0"), assistant("x".repeat(1_000_000)),
      user("recent"), call("c1"), result("c1"), assistant("done"),
    ];
    const out = enforceInputBudget(items, 100);
    expect(sanitizeHistoryItemsForModel(out.items)).toEqual(out.items);
    expect(out.items.some((item) => item.callId === "c0")).toBe(false);
    expect(out.items.filter((item) => item.callId === "c1")).toHaveLength(2);
  });

  test("findKeepBoundary returns 0 when no user boundary exists", () => {
    expect(findKeepBoundary([assistant("a"), call("c"), result("c")], 10)).toBe(0);
  });
});

describe("extractResponseOutputText", () => {
  test("reads output_text directly", () => {
    expect(extractResponseOutputText({ output_text: "hello" })).toBe("hello");
  });

  test("reads assistant message content parts", () => {
    const response = {
      output: [
        { type: "reasoning", content: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "part-A" }, { type: "output_text", text: "-B" }] },
      ],
    };
    expect(extractResponseOutputText(response)).toBe("part-A-B");
  });

  test("skips input-echo message items", () => {
    const response = {
      output: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "ECHOED PROMPT" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "real-summary" }] },
      ],
    };
    expect(extractResponseOutputText(response)).toBe("real-summary");
  });

  test("returns empty string for unknown shapes", () => {
    expect(extractResponseOutputText(null)).toBe("");
    expect(extractResponseOutputText({})).toBe("");
  });
});
