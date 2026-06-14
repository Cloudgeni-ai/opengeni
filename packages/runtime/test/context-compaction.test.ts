import { describe, expect, test } from "bun:test";
import {
  COMPACTION_SUMMARY_MARKER,
  SUMMARY_PREFIX,
  buildCompactionMessages,
  buildSummaryItem,
  compactionSummaryText,
  estimateTokens,
  findKeepBoundary,
  isCompactionSummary,
  isUserMessage,
  planCompaction,
  type CompactionItem,
} from "../src/context-compaction";
import { extractResponseOutputText } from "../src/index";
import { sanitizeHistoryItemsForModel } from "../src/history-sanitizer";

// --- builders for readable fixtures ---
function user(text: string): CompactionItem {
  return { type: "message", role: "user", content: text };
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
function reasoning(): CompactionItem {
  return { type: "reasoning", content: [] };
}

// Pad an item so its char/4 estimate is ~`tokens`.
function bigItem(role: "user" | "assistant", tokens: number): CompactionItem {
  const body = "x".repeat(tokens * 4);
  return role === "user" ? user(body) : assistant(body);
}

const BUDGET = 922_000;
const SOFT = 0.7;
const HARD = 0.85;

describe("item predicates", () => {
  test("isUserMessage only matches user-role messages", () => {
    expect(isUserMessage(user("hi"))).toBe(true);
    expect(isUserMessage(assistant("hi"))).toBe(false);
    expect(isUserMessage(call("c1"))).toBe(false);
  });

  test("buildSummaryItem is a marked user message recognized by isCompactionSummary", () => {
    const item = buildSummaryItem("the summary body");
    expect(isUserMessage(item)).toBe(true);
    expect(isCompactionSummary(item)).toBe(true);
    expect(item[COMPACTION_SUMMARY_MARKER]).toBe(true);
    expect(String(item.content)).toContain(SUMMARY_PREFIX);
    expect(String(item.content)).toContain("the summary body");
    // A plain user message is NOT a compaction summary.
    expect(isCompactionSummary(user("the summary body"))).toBe(false);
  });

  test("compactionSummaryText strips the bridge prefix and returns the body", () => {
    const item = buildSummaryItem("body-X");
    expect(compactionSummaryText(item)).toBe("body-X");
    expect(compactionSummaryText(null)).toBe("");
  });
});

describe("findKeepBoundary", () => {
  test("keeps the most recent whole turns within the budget, cutting at a user boundary", () => {
    const items: CompactionItem[] = [
      user("turn 1"), assistant("a1"),
      user("turn 2"), assistant("a2"),
      user("turn 3"), assistant("a3"),
    ];
    // Budget large enough for all -> boundary at first user message (index 0).
    expect(findKeepBoundary(items, 1_000_000)).toBe(0);
    // Tiny budget -> latest user boundary whose tail fits; the last turn alone.
    const boundary = findKeepBoundary(items, estimateTokens(items.slice(4)) );
    expect(boundary).toBe(4);
    expect(isUserMessage(items[boundary]!)).toBe(true);
  });

  test("returns 0 when there is no user-message boundary", () => {
    expect(findKeepBoundary([assistant("a"), call("c"), result("c")], 10)).toBe(0);
  });
});

describe("planCompaction trigger", () => {
  test("does not compact below the soft threshold (real last-turn tokens)", () => {
    const items = [user("hi"), assistant("there")];
    const plan = planCompaction({
      items,
      lastInputTokens: Math.floor(BUDGET * SOFT) - 1,
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: 32_000,
    });
    expect(plan.shouldCompact).toBe(false);
    expect(plan.reason).toBe("below_threshold");
  });

  test("compacts at/above the soft threshold", () => {
    const items: CompactionItem[] = [
      user("old 1"), assistant("a1"),
      user("old 2"), assistant("a2"),
      user("recent"), assistant("a3"),
    ];
    const plan = planCompaction({
      items,
      lastInputTokens: Math.floor(BUDGET * SOFT),
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      // Keep only the last turn verbatim so a real prefix exists to summarize.
      keepRecentTokens: estimateTokens(items.slice(4)),
    });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.reason).toBe("compact");
    expect(plan.boundaryIndex).toBe(4);
    expect(plan.tailItems).toEqual(items.slice(4));
  });

  test("falls back to a char/4 estimate when last-turn tokens are unknown", () => {
    // Two big turns whose estimate crosses the soft threshold; keep only the
    // last one so there is a prefix to summarize.
    const items: CompactionItem[] = [
      bigItem("user", Math.ceil(BUDGET * SOFT)), assistant("a1"),
      user("recent"), assistant("a2"),
    ];
    const plan = planCompaction({
      items,
      lastInputTokens: null,
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(2)),
    });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.boundaryIndex).toBe(2);
  });

  test("force bypasses the budget trigger but still respects the structural guards", () => {
    const items: CompactionItem[] = [
      user("old 1"), assistant("a1"),
      user("recent"), assistant("a2"),
    ];
    // Far below the soft threshold: without force this is a no-op.
    const base = {
      items,
      lastInputTokens: 1,
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(2)),
    } as const;
    expect(planCompaction(base).shouldCompact).toBe(false);
    const forced = planCompaction({ ...base, force: true });
    expect(forced.shouldCompact).toBe(true);
    expect(forced.boundaryIndex).toBe(2);

    // Force with nothing to summarize (whole transcript kept) is still a no-op.
    const noPrefix = planCompaction({ ...base, force: true, keepRecentTokens: estimateTokens(items) });
    expect(noPrefix.shouldCompact).toBe(false);
  });
});

describe("planCompaction orphan safety (the boundary rule)", () => {
  test("never splits a tool-call pair: the dropped prefix keeps call+result together", () => {
    // turn 0: user + call/result pair. turn 1 (recent): user + call/result pair.
    const items: CompactionItem[] = [
      user("turn 0"), reasoning(), call("c0"), result("c0"), assistant("done 0"),
      user("turn 1"), reasoning(), call("c1"), result("c1"), assistant("done 1"),
    ];
    const plan = planCompaction({
      items,
      lastInputTokens: Math.floor(BUDGET * SOFT),
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(5)),
    });
    expect(plan.shouldCompact).toBe(true);
    // Boundary lands on the recent user message — turn 0's whole pair is in the
    // prefix, turn 1's whole pair is in the tail. Neither straddles.
    expect(plan.boundaryIndex).toBe(5);
    const prefixCallIds = plan.prefixItems.filter((i) => i.callId === "c0");
    const tailCallIds = plan.tailItems.filter((i) => i.callId === "c1");
    expect(prefixCallIds.length).toBe(2); // call + result both in prefix
    expect(tailCallIds.length).toBe(2); // call + result both in tail
    expect(plan.tailItems.some((i) => i.callId === "c0")).toBe(false);
    expect(plan.prefixItems.some((i) => i.callId === "c1")).toBe(false);
  });

  test("the post-compaction active history is orphan-clean (summary + tail survive the sanitizer)", () => {
    const items: CompactionItem[] = [
      user("turn 0"), call("c0"), result("c0"), assistant("done 0"),
      user("turn 1"), call("c1"), result("c1"), assistant("done 1"),
    ];
    const plan = planCompaction({
      items,
      lastInputTokens: Math.floor(BUDGET * SOFT),
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(4)),
    });
    expect(plan.shouldCompact).toBe(true);
    const active: CompactionItem[] = [buildSummaryItem("summary"), ...plan.tailItems];
    // The sanitizer (the read-path orphan guard) must leave it byte-identical:
    // no orphaned result, no dangling call.
    expect(sanitizeHistoryItemsForModel(active)).toEqual(active);
  });
});

describe("planCompaction fold-forward (single live summary)", () => {
  test("a prior summary in the prefix is pulled out and folded forward, not re-collected", () => {
    const prior = buildSummaryItem("PRIOR FACTS");
    const items: CompactionItem[] = [
      prior,
      user("turn since"), assistant("a1"),
      user("recent"), assistant("a2"),
    ];
    const plan = planCompaction({
      items,
      lastInputTokens: Math.floor(BUDGET * SOFT),
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(3)),
    });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.priorSummaryItem).toBe(prior);
    // The prior summary is NOT among the items to re-summarize.
    expect(plan.prefixItems.some(isCompactionSummary)).toBe(false);
    // The summarizer prompt carries the prior summary body forward.
    const messages = buildCompactionMessages(plan);
    expect(messages.user).toContain("PRIOR FACTS");
    expect(messages.user).toContain("PRIOR CHECKPOINT SUMMARY");
  });

  test("a boundary landing immediately after a prior summary does NOT compact (no empty re-wrap / loop)", () => {
    // prefix = [prior summary only]; kept tail = the recent turn. There is
    // nothing NEW to fold in, so re-summarizing would just re-wrap the existing
    // summary, emit a spurious event, and risk looping turn after turn.
    const prior = buildSummaryItem("PRIOR FACTS");
    const items: CompactionItem[] = [
      prior,
      user("recent"), assistant("a-recent"),
    ];
    const plan = planCompaction({
      items,
      // Above the soft threshold so the trigger fires and we reach the boundary
      // logic (the signal includes system/tool overhead the items don't show).
      lastInputTokens: Math.floor(BUDGET * SOFT),
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      // Keep only the recent turn verbatim, so the boundary lands at index 1
      // (right after the prior summary at index 0).
      keepRecentTokens: estimateTokens(items.slice(1)),
    });
    expect(plan.boundaryIndex).toBe(1);
    expect(plan.shouldCompact).toBe(false);
    expect(plan.reason).toBe("nothing_to_summarize");
  });
});

describe("buildCompactionMessages", () => {
  test("system prompt references the notebook (pointers not contents) and credential-by-reference", () => {
    const plan = planCompaction({
      items: [user("turn 0"), assistant("a0"), user("recent"), assistant("a1")],
      lastInputTokens: Math.floor(BUDGET * SOFT),
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: 1,
    });
    const messages = buildCompactionMessages(plan);
    expect(messages.system.toLowerCase()).toContain("notebook");
    expect(messages.system).toContain("NEVER copy a secret value");
  });
});

describe("extractResponseOutputText", () => {
  test("reads output_text directly", () => {
    expect(extractResponseOutputText({ output_text: "hello" })).toBe("hello");
  });
  test("reads message content parts", () => {
    const response = {
      output: [
        { type: "reasoning", content: [] },
        { type: "message", content: [{ type: "output_text", text: "part-A" }, { type: "output_text", text: "-B" }] },
      ],
    };
    expect(extractResponseOutputText(response)).toBe("part-A-B");
  });
  test("returns empty string for unknown shapes", () => {
    expect(extractResponseOutputText(null)).toBe("");
    expect(extractResponseOutputText({})).toBe("");
  });
});
