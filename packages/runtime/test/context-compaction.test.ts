import { describe, expect, test } from "bun:test";
import {
  COMPACTION_SUMMARY_MARKER,
  SUMMARY_PREFIX,
  buildCompactionMessages,
  buildSummaryItem,
  compactionSummaryText,
  enforceInputBudget,
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

describe("planCompaction self-heal: trigger on max(actual, estimate)", () => {
  // The stale-positive re-brick: `sessions.last_input_tokens` is written ONLY
  // when usage is observed, so a turn that overflows on its first model call
  // records nothing and the column keeps a stale-low value from the last good
  // turn. The old trigger TRUSTED that positive number and only estimated when
  // it was null — so an actually-over-budget history slipped under the soft
  // limit and overflowed again, permanently. These tests pin the fix: the
  // trigger is max(recorded, estimate), so a bloated history compacts regardless
  // of a stale-low recorded count.
  test("stale-positive last_input_tokens + over-budget history MUST compact (re-brick prevented)", () => {
    // Recorded count is a stale ~600k from the last good turn — comfortably
    // UNDER the soft limit (645,400). But the ACTUAL history estimates ABOVE the
    // budget (the turn ballooned the history past the window). The old code
    // trusted 600k and did NOT compact; the new code takes the max and must.
    const STALE = 600_000;
    expect(STALE).toBeLessThan(Math.floor(BUDGET * SOFT)); // would slip past the old trigger
    const items: CompactionItem[] = [
      bigItem("user", BUDGET), assistant("a-old"), // a single over-budget prefix turn
      user("recent"), assistant("a-recent"),
    ];
    expect(estimateTokens(items)).toBeGreaterThan(BUDGET); // history truly exceeds B
    const plan = planCompaction({
      items,
      lastInputTokens: STALE, // STALE-POSITIVE, under the soft limit
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(2)),
    });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.reason).toBe("compact");
    // The estimate (not the stale count) drove the decision.
    expect(plan.signalTokens).toBe(estimateTokens(items));
    expect(plan.signalTokens).toBeGreaterThan(STALE);
  });

  test("post-overflow session self-heals on the next turn (estimate triggers despite stale count)", () => {
    // Model the turn AFTER an overflow: last_input_tokens is whatever the last
    // SUCCESSFUL turn recorded (stale, under soft), and the active history is the
    // bloated set that just 400'd. The next pre-turn check must compact so the
    // turn after that fits — i.e. the session heals itself with no operator.
    const STALE_FROM_LAST_GOOD_TURN = 500_000;
    const items: CompactionItem[] = [
      bigItem("assistant", Math.ceil(BUDGET * 0.9)), // bloated prefix from the overflow turn
      user("turn that will retry"), assistant("a"),
    ];
    const plan = planCompaction({
      items,
      lastInputTokens: STALE_FROM_LAST_GOOD_TURN,
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(1)),
    });
    expect(plan.shouldCompact).toBe(true);
    // After applying the plan the active history shrinks below the soft limit,
    // so the FOLLOWING turn would not re-trigger — the heal converges.
    const healed: CompactionItem[] = [buildSummaryItem("s"), ...plan.tailItems];
    expect(estimateTokens(healed)).toBeLessThan(Math.floor(BUDGET * SOFT));
  });

  test("signalTokens never trusts a stale-low count when the real history is larger", () => {
    const items: CompactionItem[] = [bigItem("user", 700_000), user("recent"), assistant("a")];
    const plan = planCompaction({
      items,
      lastInputTokens: 10, // absurdly stale-low
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(1)),
    });
    expect(plan.signalTokens).toBe(estimateTokens(items));
    expect(plan.shouldCompact).toBe(true);
  });

  test("an accurate recorded count above the estimate still wins (system+tool overhead the items don't show)", () => {
    // The recorded last-turn input includes system prompt + tool schemas the
    // stored items don't contain, so it can legitimately exceed the item
    // estimate. max() keeps trusting it — we never UNDER-count by switching to
    // the estimate.
    const items: CompactionItem[] = [user("old"), assistant("a"), user("recent"), assistant("b")];
    const accurate = Math.floor(BUDGET * SOFT) + 5_000;
    expect(accurate).toBeGreaterThan(estimateTokens(items));
    const plan = planCompaction({
      items,
      lastInputTokens: accurate,
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(2)),
    });
    expect(plan.signalTokens).toBe(accurate);
    expect(plan.shouldCompact).toBe(true);
  });
});

describe("planCompaction hard-force backstop (hardFraction*B)", () => {
  test("at/over the hard ceiling, hardForced is set and the plan still compacts", () => {
    const items: CompactionItem[] = [
      bigItem("user", Math.ceil(BUDGET * HARD)), assistant("a-old"),
      user("recent"), assistant("a-recent"),
    ];
    expect(estimateTokens(items)).toBeGreaterThanOrEqual(Math.floor(BUDGET * HARD));
    const plan = planCompaction({
      items,
      lastInputTokens: null,
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(2)),
    });
    expect(plan.hardForced).toBe(true);
    expect(plan.shouldCompact).toBe(true);
    expect(plan.reason).toBe("compact");
  });

  test("below the hard ceiling but above soft: compacts WITHOUT hardForced", () => {
    const items: CompactionItem[] = [
      bigItem("user", Math.ceil(BUDGET * SOFT) + 1_000), assistant("a"),
      user("recent"), assistant("b"),
    ];
    const est = estimateTokens(items);
    expect(est).toBeGreaterThanOrEqual(Math.floor(BUDGET * SOFT));
    expect(est).toBeLessThan(Math.floor(BUDGET * HARD));
    const plan = planCompaction({
      items,
      lastInputTokens: null,
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      keepRecentTokens: estimateTokens(items.slice(2)),
    });
    expect(plan.shouldCompact).toBe(true);
    expect(plan.hardForced).toBe(false);
  });

  test("hard-force shrinks the keep-recent budget so an over-budget 'all recent' history still finds a prefix", () => {
    // The deadlock the shrink defeats: the configured keepRecentTokens is huge
    // (the whole history fits inside it), so a SOFT walk would keep everything
    // verbatim and find NO prefix to summarize — stranding an over-budget
    // session. Under hard pressure the effective keep-recent is capped, forcing
    // a cut that leaves a non-empty prefix.
    const items: CompactionItem[] = [
      user("turn 0"), bigItem("assistant", 300_000),
      user("turn 1"), bigItem("assistant", 300_000),
      user("turn 2"), bigItem("assistant", 300_000),
    ];
    expect(estimateTokens(items)).toBeGreaterThanOrEqual(Math.floor(BUDGET * HARD)); // over the hard ceiling
    const plan = planCompaction({
      items,
      lastInputTokens: null,
      inputBudgetTokens: BUDGET,
      softFraction: SOFT,
      hardFraction: HARD,
      // keepRecentTokens is the WHOLE history — a soft walk keeps everything and
      // would find no prefix (boundary 0). Hard-force must override that.
      keepRecentTokens: estimateTokens(items) + 1,
    });
    expect(plan.hardForced).toBe(true);
    expect(plan.shouldCompact).toBe(true);
    expect(plan.boundaryIndex).toBeGreaterThan(0); // a real prefix WAS found
    expect(plan.prefixItems.length).toBeGreaterThan(0);
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

describe("enforceInputBudget (read-path guard backstop)", () => {
  test("leaves an in-budget input untouched (no trim, byte-identical)", () => {
    const items: CompactionItem[] = [user("a"), assistant("b"), user("c"), assistant("d")];
    const out = enforceInputBudget(items, BUDGET);
    expect(out.trimmed).toBe(false);
    expect(out.droppedCount).toBe(0);
    expect(out.items).toEqual(items);
  });

  test("trims the OLDEST history at a clean boundary until it fits, keeping the recent tail", () => {
    const items: CompactionItem[] = [
      user("old turn"), bigItem("assistant", 1_000_000),
      user("recent turn"), assistant("kept"),
    ];
    expect(estimateTokens(items)).toBeGreaterThan(BUDGET);
    const out = enforceInputBudget(items, BUDGET);
    expect(out.trimmed).toBe(true);
    expect(out.droppedCount).toBeGreaterThan(0);
    // The most recent turn survives; the assembled input now fits.
    expect(out.items).toContainEqual(user("recent turn"));
    expect(out.estimatedTokens).toBeLessThanOrEqual(BUDGET);
  });

  test("an over-budget assembled input can NOT be sent: trailingTokens counts against the cap", () => {
    // The stored history alone fits, but the new user message (trailing) pushes
    // the WHOLE request over budget. The guard must still trim so the request on
    // the wire fits — the guard measures history + trailing, not history alone.
    const items: CompactionItem[] = [
      user("old"), bigItem("assistant", 600_000),
      user("recent"), assistant("a"),
    ];
    const historyOnly = estimateTokens(items);
    expect(historyOnly).toBeLessThan(BUDGET); // history alone fits
    const trailing = BUDGET - historyOnly + 50_000; // trailing blows the budget
    const out = enforceInputBudget(items, BUDGET, trailing);
    expect(out.trimmed).toBe(true);
    expect(out.estimatedTokens).toBeLessThanOrEqual(BUDGET);
  });

  test("the trimmed result is orphan-clean (cut only at user boundaries, no split tool pairs)", () => {
    const items: CompactionItem[] = [
      user("old"), call("c0"), result("c0"), bigItem("assistant", 1_000_000),
      user("recent"), call("c1"), result("c1"), assistant("done"),
    ];
    const out = enforceInputBudget(items, BUDGET);
    expect(out.trimmed).toBe(true);
    // The cut landed at a user-message boundary, so no call/result straddles it:
    // the sanitizer leaves the kept tail byte-identical.
    expect(sanitizeHistoryItemsForModel(out.items)).toEqual(out.items);
    // The old turn's pair was dropped whole; the recent turn's pair is intact.
    expect(out.items.some((i) => i.callId === "c0")).toBe(false);
    expect(out.items.filter((i) => i.callId === "c1").length).toBe(2);
  });

  test("never orphans a pair: when no earlier safe boundary exists it leaves the input as-is", () => {
    // A single over-budget turn with no earlier user boundary to cut at — the
    // guard cannot trim without splitting the turn, so it declines (no-op).
    const items: CompactionItem[] = [user("only turn"), bigItem("assistant", BUDGET * 2)];
    const out = enforceInputBudget(items, BUDGET);
    expect(out.trimmed).toBe(false);
    expect(out.items).toEqual(items);
  });

  test("empty history is a no-op", () => {
    const out = enforceInputBudget([], BUDGET, 1000);
    expect(out.trimmed).toBe(false);
    expect(out.items).toEqual([]);
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
  test("reads assistant message content parts", () => {
    const response = {
      output: [
        { type: "reasoning", content: [] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "part-A" }, { type: "output_text", text: "-B" }] },
      ],
    };
    expect(extractResponseOutputText(response)).toBe("part-A-B");
  });
  test("skips input-echo message items (role !== assistant) so a provider that echoes the prompt back can't corrupt the summary", () => {
    // Fireworks' beta /v1/responses echoes the user input back as an output
    // `message` item (see docs/model-providers.md); only the assistant message
    // is the real completion. The guard must read the assistant message and drop
    // the echoed user/system ones.
    const response = {
      output: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "ECHOED PROMPT" }] },
        { type: "message", role: "system", content: [{ type: "input_text", text: "SYSTEM ECHO" }] },
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
