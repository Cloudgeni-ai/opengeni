/**
 * Client-side conversation context compaction (the Azure path).
 *
 * OpenGeni runs long-lived agent sessions whose conversation truth
 * (`session_history_items`) grows unbounded. On the OpenAI platform the
 * Responses API compacts server-side (the SDK's `compaction()` capability). On
 * Azure that capability 400s (`unsupported_parameter`), so the session
 * eventually overflows the model context window and hard-fails every turn.
 *
 * This module is the Azure-safe replacement. It is built from two pure pieces
 * plus one impure step the caller wires in:
 *
 *  1. `planCompaction` — given the active history items, the last turn's actual
 *     input-token count, and the token budget, decide WHETHER to compact and,
 *     if so, WHERE the orphan-safe cut boundary is (the prefix to summarize vs
 *     the recent tail to keep verbatim). Pure, exhaustively testable.
 *  2. (caller) summarize the prefix into ONE plain user `message` item via a
 *     model call — see `buildCompactionMessages` / `SUMMARY_PREFIX`.
 *  3. `applyCompaction` shape — the storage write the caller performs:
 *     supersede the prefix rows, insert the summary at the boundary position.
 *
 * Design constraints (non-negotiable):
 *  - The summary is a PLAIN user message, NOT the SDK `compaction` item type
 *    (that requires server-minted `encrypted_content`; a hand-rolled one risks
 *    an Azure 400).
 *  - ORPHAN SAFETY: the cut lands only at a clean turn boundary (start of a
 *    user message). No tool call_id may straddle the cut — for every
 *    `function_call` dropped, its `function_call_result` is also dropped, and
 *    vice versa. Reasoning items drop/keep with their whole turn.
 *  - SINGLE LIVE SUMMARY: each compaction folds the prior summary forward
 *    (summarize [prior summary] + [items since]); prior summaries are excluded
 *    from re-collection so drift stays bounded.
 */

export type CompactionItem = Record<string, unknown>;

/**
 * Marker stored on the synthetic summary item so it can be recognized on the
 * next compaction (to fold it forward) and excluded from re-summarization. It
 * lives in the item JSON, not a DB column, so it survives verbatim replay.
 */
export const COMPACTION_SUMMARY_MARKER = "opengeni_context_summary";

/**
 * Bridge text prepended to the summary body in the synthetic user message. It
 * tells the model the preceding conversation was compacted and that durable
 * facts live in the notebook — so it treats the summary as a working-memory
 * pointer, not the whole truth.
 */
export const SUMMARY_PREFIX = [
  "[CONTEXT CHECKPOINT] The earlier part of this conversation was automatically compacted to stay within the model context window.",
  "Durable facts already live in the workspace notebook / document bases (via MCP) — the summary below is a light working-memory bridge, not a full transcript.",
  "Trust it for current objective, decisions, blockers, deployed/infra state, and next steps; re-read the notebook for anything authoritative.",
  "",
  "SUMMARY:",
].join("\n");

const RESULT_TYPE_BY_CALL_TYPE: Record<string, string> = {
  function_call: "function_call_result",
  computer_call: "computer_call_result",
  shell_call: "shell_call_output",
  apply_patch_call: "apply_patch_call_output",
};
const RESULT_TYPES = new Set(Object.values(RESULT_TYPE_BY_CALL_TYPE));

function itemType(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const type = (item as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function itemRole(item: unknown): string | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const role = (item as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

/** A user-authored `message` item is the only legal turn boundary. */
export function isUserMessage(item: unknown): boolean {
  return itemType(item) === "message" && itemRole(item) === "user";
}

/** True for our synthetic compaction summary item. */
export function isCompactionSummary(item: unknown): boolean {
  return (
    isUserMessage(item) &&
    (item as Record<string, unknown>)[COMPACTION_SUMMARY_MARKER] === true
  );
}

/**
 * Rough token estimate for an item: char/4 over its serialized text. Used only
 * for the tail-budget walk; the trigger decision uses the real last-turn input
 * token count, falling back to this when that is unavailable.
 */
export function estimateItemTokens(item: CompactionItem): number {
  let text: string;
  try {
    text = JSON.stringify(item);
  } catch {
    text = String(item);
  }
  return Math.ceil(text.length / 4);
}

export function estimateTokens(items: readonly CompactionItem[]): number {
  let total = 0;
  for (const item of items) {
    total += estimateItemTokens(item);
  }
  return total;
}

/**
 * Walk backwards from the end of `items` keeping whole turns until the kept
 * tail would exceed `keepRecentTokens`, and return the index of the first kept
 * item. The returned index is always the start of a user message (a clean turn
 * boundary), so the prefix [0, index) never splits a tool-call pair.
 *
 * Returns `items.length` when nothing fits within the budget yet a boundary is
 * required (degenerate); callers treat an index of 0 or length as "no useful
 * cut".
 */
export function findKeepBoundary(items: readonly CompactionItem[], keepRecentTokens: number): number {
  // Indices that begin a user message (candidate boundaries). The first item is
  // a boundary even if it is not a user message, so a cut at 0 is meaningful.
  const boundaries: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (isUserMessage(items[i])) {
      boundaries.push(i);
    }
  }
  if (boundaries.length === 0) {
    // No user-message boundary at all — cannot cut safely.
    return 0;
  }
  // keepRecentTokens is a CAP on how much recent history is kept verbatim. We
  // keep as much as fits: the EARLIEST user-message boundary whose tail
  // [boundary, end) is still within the cap. Walking earliest -> latest, the
  // first boundary that fits is that earliest one (tails only shrink as the
  // boundary moves later). If even the last boundary's tail exceeds the cap we
  // fall back to it (keep at least the final turn).
  for (let b = 0; b < boundaries.length; b += 1) {
    const boundary = boundaries[b]!;
    if (estimateTokens(items.slice(boundary)) <= keepRecentTokens) {
      return boundary;
    }
  }
  return boundaries[boundaries.length - 1]!;
}

/**
 * READ-PATH BUDGET GUARD (last-resort backstop).
 *
 * Pre-turn compaction is best-effort: it can no-op (summarizer model call
 * fails, "client" mode off, a fresh user message arrives after a turn already
 * ballooned the history) and STILL leave an assembled input that exceeds the
 * model context window. The #61 orphan sanitizer is purely structural — it has
 * NO size awareness — so without this guard an over-budget input is sent and
 * 400s every turn, re-bricking the session.
 *
 * `enforceInputBudget` drops the OLDEST history at a clean turn boundary until
 * the estimated input fits `maxTokens`, ALWAYS keeping the most recent turn(s).
 * It is orphan-safe by construction: it only ever cuts at the start of a user
 * message (via `findKeepBoundary`), so no tool-call pair is split. It is a
 * crude data-loss fallback (no summary is generated) that exists solely so a
 * single over-budget assembled input is never put on the wire — real context
 * preservation is the summarizing pre-turn path; this is the airbag.
 *
 * Pure: returns a new array (same item references, in order) with an oldest
 * prefix omitted, or the input unchanged when it already fits. The provided
 * `trailingTokens` accounts for the un-stored part of the assembled input (the
 * new user/continuation message + fixed system/tool overhead) so the cap is
 * measured against the WHOLE request, not just the stored history.
 */
export function enforceInputBudget<T extends CompactionItem>(
  items: readonly T[],
  maxTokens: number,
  trailingTokens = 0,
): { items: T[]; trimmed: boolean; droppedCount: number; estimatedTokens: number } {
  const total = estimateTokens(items) + Math.max(0, trailingTokens);
  if (items.length === 0 || total <= maxTokens) {
    return { items: items.slice(), trimmed: false, droppedCount: 0, estimatedTokens: total };
  }
  // Budget left for the stored history once the fixed trailing cost is paid.
  const historyBudget = Math.max(0, maxTokens - Math.max(0, trailingTokens));
  // Find the EARLIEST user-message boundary whose tail fits historyBudget; that
  // boundary's prefix is the oldest history we drop. findKeepBoundary already
  // returns a clean turn boundary (start of a user message), so the cut is
  // orphan-safe. A boundary of 0 means nothing could be dropped safely (no
  // earlier boundary) — we leave the input as-is rather than orphan a pair.
  const boundary = findKeepBoundary(items, historyBudget);
  if (boundary <= 0) {
    return { items: items.slice(), trimmed: false, droppedCount: 0, estimatedTokens: total };
  }
  const kept = items.slice(boundary);
  return {
    items: kept,
    trimmed: true,
    droppedCount: boundary,
    estimatedTokens: estimateTokens(kept) + Math.max(0, trailingTokens),
  };
}

export type CompactionPlan = {
  /** Whether a compaction should run this turn. */
  shouldCompact: boolean;
  /** Why not, when shouldCompact is false (for logs/tests). */
  reason: "below_threshold" | "no_boundary" | "nothing_to_summarize" | "compact";
  /**
   * The signal-token count the trigger decision was made on:
   * max(actual last-turn input tokens, char/4 estimate of the active items).
   * Recorded for logging / metrics and so a caller can reason about pressure.
   */
  signalTokens: number;
  /**
   * True when the signal reached hardFraction*B — the session is at/over the
   * hard ceiling and compaction was forced even if the recorded last-turn count
   * was stale-low. The boundary walk is run with a SHRUNK keep-recent budget in
   * this case so an over-budget history always yields a non-empty prefix to
   * summarize (the everything-is-"recent" deadlock can't strand it un-compacted).
   */
  hardForced: boolean;
  /** Index (into the active items) where the kept tail begins. */
  boundaryIndex: number;
  /**
   * The prefix items to summarize: active[0, boundaryIndex), EXCLUDING any
   * prior compaction summary (which is folded forward via `priorSummaryItem`).
   */
  prefixItems: CompactionItem[];
  /** The prior live summary item folded into this compaction, if any. */
  priorSummaryItem: CompactionItem | null;
  /** Items kept verbatim: active[boundaryIndex, end). */
  tailItems: CompactionItem[];
};

export type PlanCompactionInput = {
  /** Active history items in position order (already excludes superseded rows). */
  items: readonly CompactionItem[];
  /**
   * Actual input tokens reported for the last model call of the previous turn.
   * Null/undefined falls back to a char/4 estimate over `items`.
   */
  lastInputTokens?: number | null;
  /** Usable input budget B = window - reserved output. */
  inputBudgetTokens: number;
  softFraction: number;
  hardFraction: number;
  keepRecentTokens: number;
  /**
   * Operator-forced compaction (the /compact command): bypass the soft-limit
   * token trigger and compact now if there is anything to summarize. The
   * boundary / nothing-to-summarize guards still apply — force never invents a
   * cut that would orphan a tool-call pair or summarize an empty prefix.
   */
  force?: boolean;
};

/**
 * Decide whether and where to compact. Pure.
 *
 * Trigger: signal tokens >= softFraction*B (soft) or hardFraction*B (hard).
 * Signal = MAX(actual last-turn input tokens, char/4 estimate of the active
 * items). The max — not "trust the recorded count, estimate only when it's
 * null" — is the self-heal fix: `sessions.last_input_tokens` is written ONLY
 * when a model response reports usage, so a turn that OVERFLOWS on its first
 * model call records NOTHING and the column keeps a STALE-POSITIVE value from
 * the last good turn (e.g. ~600k). Trusting that stale-low number let an
 * actually-over-budget history (>1.05M) slip under the soft limit and overflow
 * again, re-bricking with no self-heal. Taking the max means a bloated history
 * triggers compaction regardless of a stale recorded count.
 *
 * Hard force (hardFraction*B): at/over the hard ceiling we compact even if the
 * recorded count was stale-low, AND we run the boundary walk with a shrunk
 * keep-recent budget so an over-budget history always yields a non-empty prefix
 * — otherwise a history where the whole thing reads as "recent" (tail within
 * keepRecentTokens) would find no prefix and strand the session over budget.
 *
 * Boundary: the earliest user-message boundary whose kept tail fits the
 * (possibly shrunk) keep-recent budget. The prefix before it (minus any prior
 * summary, which is folded forward) is what gets summarized.
 */
export function planCompaction(input: PlanCompactionInput): CompactionPlan {
  const softLimit = Math.floor(input.inputBudgetTokens * input.softFraction);
  const hardLimit = Math.floor(input.inputBudgetTokens * input.hardFraction);
  // Signal = MAX(recorded last-turn input tokens, estimate of the actual
  // history). See the doc comment: the max is what defeats the stale-positive
  // re-brick — a bloated history wins over a stale-low recorded count.
  const recorded =
    typeof input.lastInputTokens === "number" && input.lastInputTokens > 0
      ? input.lastInputTokens
      : 0;
  const signalTokens = Math.max(recorded, estimateTokens(input.items));
  const hardForced = signalTokens >= hardLimit;

  const empty: CompactionPlan = {
    shouldCompact: false,
    reason: "below_threshold",
    signalTokens,
    hardForced,
    boundaryIndex: input.items.length,
    prefixItems: [],
    priorSummaryItem: null,
    tailItems: [...input.items],
  };

  // force (operator /compact) bypasses the budget trigger; the structural
  // guards below still run, so a forced compaction with nothing to summarize is
  // still a no-op. A hard-forced compaction is, like soft, gated by those
  // guards but additionally shrinks the keep-recent budget (below) so it can
  // actually find a prefix when the whole history is over budget.
  if (!input.force && signalTokens < softLimit) {
    return empty;
  }

  // Under hard pressure, cap the verbatim tail well below B so the boundary walk
  // is forced to leave a summarizable prefix even when last_input_tokens was
  // stale-low and the history exceeds the window. We keep at most HALF the
  // configured keep-recent budget (and never more than a quarter of B) — enough
  // recent context to stay coherent, little enough that a real prefix always
  // remains to compact. Soft compactions keep the full configured budget.
  const effectiveKeepRecent = hardForced
    ? Math.min(
        Math.floor(input.keepRecentTokens / 2),
        Math.floor(input.inputBudgetTokens / 4),
      )
    : input.keepRecentTokens;

  const boundaryIndex = findKeepBoundary(input.items, effectiveKeepRecent);
  if (boundaryIndex <= 0) {
    // No prefix to summarize (cut at the very start) — nothing to do.
    return { ...empty, reason: "no_boundary", boundaryIndex };
  }

  const prefix = input.items.slice(0, boundaryIndex);
  const tailItems = input.items.slice(boundaryIndex);

  // Fold the prior live summary forward: pull it out of the prefix so it is not
  // re-summarized verbatim, and hand it to the summarizer as prior context.
  let priorSummaryItem: CompactionItem | null = null;
  const prefixItems: CompactionItem[] = [];
  for (const item of prefix) {
    if (isCompactionSummary(item)) {
      priorSummaryItem = item;
      continue;
    }
    prefixItems.push(item);
  }

  // Nothing real to summarize. This fires both when the prefix is genuinely
  // empty AND when the prefix contains ONLY a prior summary (boundary landed
  // immediately after it): folding a summary forward over zero new items would
  // burn a summarizer call to re-wrap identical content, emit a spurious
  // compaction event, and — if the next turn is still above the soft threshold
  // — loop. The single live summary already sits at the boundary, so leaving it
  // in place is correct.
  if (prefixItems.length === 0) {
    return { ...empty, reason: "nothing_to_summarize", boundaryIndex };
  }

  return {
    shouldCompact: true,
    reason: "compact",
    signalTokens,
    hardForced,
    boundaryIndex,
    prefixItems,
    priorSummaryItem,
    tailItems,
  };
}

/** Extract the plain-text body of the prior summary item, if any. */
export function compactionSummaryText(item: CompactionItem | null): string {
  if (!item) {
    return "";
  }
  const content = (item as { content?: unknown }).content;
  if (typeof content === "string") {
    return stripSummaryPrefix(content);
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (part && typeof part === "object") {
          const t = (part as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
    return stripSummaryPrefix(text);
  }
  return "";
}

function stripSummaryPrefix(text: string): string {
  const marker = "SUMMARY:";
  const idx = text.indexOf(marker);
  return idx >= 0 ? text.slice(idx + marker.length) : text;
}

/**
 * Build the synthetic summary item (a plain user message) to insert at the
 * boundary. `summaryBody` is the model-generated working-memory bridge.
 */
export function buildSummaryItem(summaryBody: string): CompactionItem {
  return {
    type: "message",
    role: "user",
    content: `${SUMMARY_PREFIX}${summaryBody}`,
    [COMPACTION_SUMMARY_MARKER]: true,
  };
}

/**
 * Instruction prompt for the summarizer model call. Leans on OpenGeni's durable
 * structured memory (the notebook) so the summary stays a light working-memory
 * bridge, never a place secret values get copied.
 */
export const SUMMARY_INSTRUCTIONS = [
  "You are compacting the earlier part of a long-running agent conversation into a compact working-memory checkpoint so the agent can continue past the model's context limit.",
  "Durable facts already live in the workspace notebook and document bases (via MCP). Do NOT re-derive or copy those; summarize POINTERS, not contents.",
  "Capture, concisely and factually:",
  "- The current objective and the key decisions made so far.",
  "- Open blockers and anything in-progress.",
  "- Deployed / infrastructure state that has changed (what exists now).",
  "- Environment and credential facts BY REFERENCE ONLY — name the env var keys, secret names, or notebook/document ids; NEVER copy a secret value, token, key, or password.",
  "- Concrete next steps.",
  "Say explicitly that durable facts are in the notebook and that this summary lists pointers, not contents.",
  "Output only the summary body — no preamble, no markdown headers, plain prose or terse bullets.",
].join("\n");

/**
 * Render the prefix items into a transcript the summarizer reads. Keeps it
 * bounded by truncating individual items; the model call itself is what
 * produces the compact result.
 */
export function renderPrefixTranscript(items: readonly CompactionItem[], priorSummaryText: string): string {
  const lines: string[] = [];
  if (priorSummaryText.trim().length > 0) {
    lines.push("PRIOR CHECKPOINT SUMMARY (fold this forward; it already replaced even older history):");
    lines.push(priorSummaryText.trim());
    lines.push("");
    lines.push("CONVERSATION SINCE THAT CHECKPOINT:");
  } else {
    lines.push("CONVERSATION TO SUMMARIZE:");
  }
  for (const item of items) {
    lines.push(renderItem(item));
  }
  return lines.join("\n");
}

function renderItem(item: CompactionItem): string {
  const type = itemType(item) ?? "unknown";
  if (type === "message") {
    const role = itemRole(item) ?? "assistant";
    return `[${role}] ${truncate(messageText(item), 4000)}`;
  }
  if (type === "reasoning") {
    return "[reasoning] (omitted)";
  }
  if (RESULT_TYPES.has(type)) {
    return `[tool_result] ${truncate(resultText(item), 2000)}`;
  }
  if (RESULT_TYPE_BY_CALL_TYPE[type]) {
    return `[tool_call ${type}] ${truncate(callText(item), 1000)}`;
  }
  return `[${type}] ${truncate(safeStringify(item), 1000)}`;
}

function messageText(item: CompactionItem): string {
  const content = (item as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object") {
          const t = (part as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

function resultText(item: CompactionItem): string {
  const output = (item as { output?: unknown }).output;
  if (typeof output === "string") {
    return output;
  }
  return safeStringify(output ?? item);
}

function callText(item: CompactionItem): string {
  const name = (item as { name?: unknown }).name;
  const args = (item as { arguments?: unknown }).arguments;
  const namePart = typeof name === "string" ? name : "";
  const argPart = typeof args === "string" ? args : safeStringify(args ?? {});
  return `${namePart} ${argPart}`.trim();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}… (${text.length - max} more chars)`;
}

/**
 * The summarizer model call payload: a system instruction plus the rendered
 * prefix transcript. The caller turns this into a single model request (no
 * tools, no streaming) and feeds the text result into `buildSummaryItem`.
 */
export function buildCompactionMessages(plan: CompactionPlan): { system: string; user: string } {
  const priorText = compactionSummaryText(plan.priorSummaryItem);
  return {
    system: SUMMARY_INSTRUCTIONS,
    user: renderPrefixTranscript(plan.prefixItems, priorText),
  };
}
