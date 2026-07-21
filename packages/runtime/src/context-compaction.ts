/**
 * Portable conversation context compaction, following Codex CLI's local path.
 *
 * The checkpoint model sees the current active history plus one fixed
 * checkpoint prompt, then the active history is rebuilt from the newest real
 * user messages within one cumulative 20k-token budget plus one summary.
 * Assistant messages, tool calls/results, reasoning, and images are removed
 * from the active model-facing history; the database audit rows remain.
 */

import {
  TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE,
  sanitizeHistoryItemsForModel,
} from "./history-sanitizer";
import { boundModelToolOutputItem } from "@opengeni/codex";
import { createHash } from "node:crypto";

export type CompactionItem = Record<string, unknown>;

/**
 * Marker stored on the synthetic summary item so the UI can render it and the
 * next rebuild can exclude old summaries from the retained user-message set.
 */
export const COMPACTION_SUMMARY_MARKER = "opengeni_context_summary";

export const SUMMARY_BUFFER_TOKENS = 20_000;
// A single cumulative budget for all retained real user messages, matching
// Codex core's build_compacted_history_with_limit (not a per-message allowance).
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
// 0.9: compact as LATE as possible — retained context is worth more than early
// headroom now that declared per-model windows are honest. Model-catalog
// explicit limits take precedence; the ratio is used for models without one.
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.9;
export const MIN_COMPACTION_THRESHOLD_RATIO = 0.3;
export const MAX_COMPACTION_THRESHOLD_RATIO = 0.9;

// Verbatim from Codex CLI:
// codex-rs/prompts/templates/compact/prompt.md
export const COMPACTION_PROMPT = [
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
  "",
  "Include:",
  "- Current progress and key decisions made",
  "- Important context, constraints, or user preferences",
  "- What remains to be done (clear next steps)",
  "- Any critical data, examples, or references needed to continue",
  "",
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
].join("\n");

// Verbatim from Codex CLI:
// codex-rs/prompts/templates/compact/summary_prefix.md
export const SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export const USER_MESSAGE_TRUNCATION_MARKER =
  "\n[... middle truncated for context compaction ...]\n";

const RESULT_TYPE_BY_CALL_TYPE = TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE;
const RESULT_TYPES = new Set(Object.values(RESULT_TYPE_BY_CALL_TYPE));
const MODEL_GENERATED_ITEM_TYPES = new Set([
  "reasoning",
  "function_call",
  "custom_tool_call",
  "tool_search_call",
  "web_search_call",
  "image_generation_call",
  "computer_call",
  "shell_call",
  "apply_patch_call",
  "compaction",
  "context_compaction",
]);

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
    isUserMessage(item) && (item as Record<string, unknown>)[COMPACTION_SUMMARY_MARKER] === true
  );
}

/** Platform-authored system context exists for one inference and is never persisted. */
export function isEphemeralInternalContext(item: unknown): boolean {
  return itemType(item) === "message" && itemRole(item) === "system";
}

/**
 * Conservative tokenizer-independent text estimate used for every local input
 * budget. Preserve the stable ASCII `chars / 4` heuristic, but never discount
 * Unicode as UTF-16 length/4: each non-ASCII code unit costs at least one token
 * (CJK ≈ 1/code point; an astral emoji's surrogate pair ≈ 2). This intentionally
 * errs toward compaction rather than letting multilingual current input exceed
 * a provider context window before an authoritative usage anchor exists.
 */
export function estimateTextTokens(text: string): number {
  let asciiCodeUnits = 0;
  let nonAsciiCodeUnits = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) <= 0x7f) asciiCodeUnits += 1;
    else nonAsciiCodeUnits += 1;
  }
  return nonAsciiCodeUnits + Math.ceil(asciiCodeUnits / 4);
}

/** Serialized-item estimate for pre-call accounting and retained user budgets. */
export function estimateItemTokens(item: CompactionItem): number {
  let text: string;
  try {
    text = JSON.stringify(item);
  } catch {
    text = String(item);
  }
  return estimateTextTokens(text);
}

export function estimateTokens(items: readonly CompactionItem[]): number {
  let total = 0;
  for (const item of items) {
    total += estimateItemTokens(item);
  }
  return total;
}

export function estimateSerializedValueTokens(value: unknown): number {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return estimateTextTokens(serialized ?? "");
}

export type CompleteModelInputFootprint = {
  input: readonly CompactionItem[];
  instructionsTokens: number;
  toolSchemaTokens: number;
};

export type ProviderContextTokenSignal = {
  /** Monotonic within one sampled run; advances after every model response. */
  revision: number;
  /** Provider total tokens after that response (input + generated output). */
  totalTokens: number;
};

export type CompleteModelInputEstimate = {
  tokens: number;
  source: "complete_estimate" | "provider_plus_local";
  inputTokens: number;
  instructionsTokens: number;
  toolSchemaTokens: number;
  appendedAfterModelTokens: number;
};

/**
 * Match Codex history accounting: after one provider response, start from its
 * authoritative TOTAL token count and add only local items placed after the
 * newest model-generated item. System instructions and tool schemas are
 * compared with the exact request footprint that produced the provider count;
 * positive growth is added. Without a bound anchor, estimate the entire
 * outgoing request rather than trusting stale usage from an earlier turn.
 */
export function estimateCompleteModelInput(input: {
  current: CompleteModelInputFootprint;
  provider?: ProviderContextTokenSignal | null;
  providerRequestFootprint?: CompleteModelInputFootprint | null;
}): CompleteModelInputEstimate {
  const inputTokens = estimateTokens(input.current.input);
  const instructionsTokens = input.current.instructionsTokens;
  const toolSchemaTokens = input.current.toolSchemaTokens;
  if (!input.provider || !input.providerRequestFootprint || input.provider.totalTokens <= 0) {
    return {
      tokens: inputTokens + instructionsTokens + toolSchemaTokens,
      source: "complete_estimate",
      inputTokens,
      instructionsTokens,
      toolSchemaTokens,
      appendedAfterModelTokens: 0,
    };
  }

  const appended = itemsAfterLastModelGeneratedItem(input.current.input);
  const appendedAfterModelTokens = estimateTokens(appended);
  const instructionGrowth = Math.max(
    0,
    instructionsTokens - input.providerRequestFootprint.instructionsTokens,
  );
  const toolSchemaGrowth = Math.max(
    0,
    toolSchemaTokens - input.providerRequestFootprint.toolSchemaTokens,
  );
  return {
    tokens:
      input.provider.totalTokens + appendedAfterModelTokens + instructionGrowth + toolSchemaGrowth,
    source: "provider_plus_local",
    inputTokens,
    instructionsTokens,
    toolSchemaTokens,
    appendedAfterModelTokens,
  };
}

export function itemsAfterLastModelGeneratedItem(
  items: readonly CompactionItem[],
): CompactionItem[] {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isModelGeneratedItem(items[index])) {
      return items.slice(index + 1);
    }
  }
  // Codex treats a provider token anchor without any model-generated item as
  // unbound. Callers therefore fall back to a complete estimate in that case.
  return items.slice();
}

export function hasModelGeneratedItem(items: readonly CompactionItem[]): boolean {
  return items.some(isModelGeneratedItem);
}

function isModelGeneratedItem(item: unknown): boolean {
  const type = itemType(item);
  if (type === "message") return itemRole(item) === "assistant";
  return MODEL_GENERATED_ITEM_TYPES.has(type ?? "");
}

export function clampCompactionThresholdRatio(value: number | undefined | null): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_COMPACTION_THRESHOLD_RATIO;
  return Math.min(
    MAX_COMPACTION_THRESHOLD_RATIO,
    Math.max(MIN_COMPACTION_THRESHOLD_RATIO, numeric),
  );
}

export function compactionThresholdTokens(input: {
  contextWindowTokens: number;
  contextReservedOutputTokens: number;
  contextAutoCompactThresholdTokens?: number | null | undefined;
  contextCompactionThresholdRatio?: number | null | undefined;
}): number {
  const window = Math.max(0, input.contextWindowTokens);
  const codexMaximum = Math.floor(window * MAX_COMPACTION_THRESHOLD_RATIO);
  if (
    typeof input.contextAutoCompactThresholdTokens === "number" &&
    Number.isFinite(input.contextAutoCompactThresholdTokens) &&
    input.contextAutoCompactThresholdTokens > 0
  ) {
    return Math.min(Math.floor(input.contextAutoCompactThresholdTokens), codexMaximum);
  }
  return Math.floor(window * clampCompactionThresholdRatio(input.contextCompactionThresholdRatio));
}

export type CompactionDecision = {
  shouldCompact: boolean;
  reason: "force" | "above_threshold" | "below_threshold" | "no_history";
  signalTokens: number;
  thresholdTokens: number;
};

export function decideCompaction(input: {
  items: readonly CompactionItem[];
  lastInputTokens?: number | null;
  contextWindowTokens: number;
  contextReservedOutputTokens: number;
  contextAutoCompactThresholdTokens?: number | null | undefined;
  contextCompactionThresholdRatio?: number | null | undefined;
  force?: boolean;
}): CompactionDecision {
  const thresholdTokens = compactionThresholdTokens(input);
  const recorded =
    typeof input.lastInputTokens === "number" && input.lastInputTokens > 0
      ? input.lastInputTokens
      : 0;
  const activeHistoryEstimate = estimateTokens(input.items);
  // A durable provider count belongs to an earlier request. The full active
  // estimate is a conservative cross-turn floor until an exact same-run anchor
  // is available in the per-call guard.
  const signalTokens = Math.max(recorded, activeHistoryEstimate);
  if (input.items.length === 0) {
    return {
      shouldCompact: false,
      reason: "no_history",
      signalTokens,
      thresholdTokens,
    };
  }
  if (input.force) {
    return {
      shouldCompact: true,
      reason: "force",
      signalTokens,
      thresholdTokens,
    };
  }
  if (signalTokens >= thresholdTokens) {
    return {
      shouldCompact: true,
      reason: "above_threshold",
      signalTokens,
      thresholdTokens,
    };
  }
  return {
    shouldCompact: false,
    reason: "below_threshold",
    signalTokens,
    thresholdTokens,
  };
}

export class CompactionNeededError extends Error {
  readonly signalTokens: number;
  readonly thresholdTokens: number;
  readonly signalSource: "provider" | "estimate";
  readonly trigger: "threshold" | "operator";

  constructor(input: {
    signalTokens: number;
    thresholdTokens: number;
    signalSource: "provider" | "estimate";
    trigger?: "threshold" | "operator";
  }) {
    const trigger = input.trigger ?? "threshold";
    super(
      trigger === "operator"
        ? "Context compaction requested by the operator"
        : `Context compaction needed: signal ${input.signalTokens} tokens exceeded threshold ${input.thresholdTokens}`,
    );
    this.name = "CompactionNeededError";
    this.signalTokens = input.signalTokens;
    this.thresholdTokens = input.thresholdTokens;
    this.signalSource = input.signalSource;
    this.trigger = trigger;
  }
}

export class EmptyCompactionSummaryError extends Error {
  readonly diagnostics: Record<string, unknown>;

  constructor(diagnostics: Record<string, unknown> = {}) {
    const compact = JSON.stringify(diagnostics).slice(0, 2_000);
    super(
      `Compaction summarizer returned no assistant text; active history was preserved${compact ? ` (${compact})` : ""}`,
    );
    this.name = "EmptyCompactionSummaryError";
    this.diagnostics = diagnostics;
  }
}

/**
 * The checkpoint model request ended in a provider/transport failure rather
 * than a successful response with an empty assistant message. Diagnostics are
 * deliberately bounded and content-free so this error can be persisted on a
 * turn without copying provider messages or conversation input into events.
 */
export class CompactionProviderResponseError extends Error {
  readonly diagnostics: Record<string, unknown>;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  override readonly cause?: unknown;

  constructor(diagnostics: Record<string, unknown> = {}, cause?: unknown) {
    const compact = JSON.stringify(diagnostics).slice(0, 2_000);
    super(
      `Compaction provider request failed; active history was preserved${compact ? ` (${compact})` : ""}`,
    );
    this.name = "CompactionProviderResponseError";
    this.diagnostics = diagnostics;
    if (typeof diagnostics.httpStatus === "number") this.status = diagnostics.httpStatus;
    if (typeof diagnostics.code === "string") this.code = diagnostics.code;
    if (typeof diagnostics.type === "string") this.type = diagnostics.type;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, enumerable: false });
    }
  }
}

export function findCompactionNeededError(
  error: unknown,
  seen = new WeakSet<object>(),
): CompactionNeededError | null {
  if (error instanceof CompactionNeededError) {
    return error;
  }
  if (!error || typeof error !== "object") {
    return null;
  }
  if (seen.has(error)) {
    return null;
  }
  seen.add(error);
  const record = error as Record<string, unknown>;
  return (
    findCompactionNeededError(record.cause, seen) ?? findCompactionNeededError(record.error, seen)
  );
}

/**
 * The exact checkpoint input shape: current active history followed by Codex's
 * checkpoint prompt as a synthesized user message.
 */
export function buildCompactionPromptInput(items: readonly CompactionItem[]): CompactionItem[] {
  return [
    ...items,
    {
      type: "message",
      role: "user",
      content: COMPACTION_PROMPT,
    },
  ];
}

export type PreparedCompactionPromptInput = {
  input: CompactionItem[];
  estimatedInputTokens: number;
  rewrittenToolOutputs: number;
  droppedHistoryItems: number;
};

/**
 * Fit the explicit checkpoint request without mutating canonical history.
 *
 * Codex first replaces oversized tool outputs in its temporary remote-
 * compaction input. OpenGeni does the same oldest-first, preserving the most
 * recent tool detail for the plaintext summary. If that is still insufficient,
 * whole oldest user-delimited work units are removed and the remaining suffix
 * is protocol-sanitized so no call/result/reasoning fragment is orphaned.
 * The raw active history is still the source for the eventual replacement and
 * remains unchanged if the provider call fails.
 */
export function prepareCompactionPromptInput(
  items: readonly CompactionItem[],
  maxInputTokens: number,
): PreparedCompactionPromptInput {
  const budget = Math.max(0, Math.floor(maxInputTokens));
  let history = items.slice();
  let estimatedInputTokens = estimateTokens(buildCompactionPromptInput(history));
  let rewrittenToolOutputs = 0;

  for (let index = 0; index < history.length && estimatedInputTokens > budget; index += 1) {
    const current = history[index]!;
    const replacement = minimalToolResultForCompaction(current);
    if (replacement === current) continue;
    const before = estimateItemTokens(current);
    const after = estimateItemTokens(replacement);
    if (after >= before) continue;
    history[index] = replacement;
    estimatedInputTokens -= before - after;
    rewrittenToolOutputs += 1;
  }

  const beforeDropLength = history.length;
  if (estimatedInputTokens > budget && history.length > 0) {
    const prefixTokens = new Array<number>(history.length + 1).fill(0);
    for (let index = 0; index < history.length; index += 1) {
      prefixTokens[index + 1] = prefixTokens[index]! + estimateItemTokens(history[index]!);
    }
    const cuts = oldestLogicalUnitCuts(history);
    const cut =
      cuts.find((candidate) => estimatedInputTokens - prefixTokens[candidate]! <= budget) ??
      history.length;
    history = sanitizeHistoryItemsForModel(history.slice(cut));
    estimatedInputTokens = estimateTokens(buildCompactionPromptInput(history));
    // The synthesized checkpoint instruction is the irreducible floor. The
    // real model budgets are far above it, but keep the helper total for tests
    // and malformed configuration instead of constructing invalid fragments.
    if (estimatedInputTokens > budget) {
      history = [];
      estimatedInputTokens = estimateTokens(buildCompactionPromptInput(history));
    }
  }

  return {
    input: buildCompactionPromptInput(history),
    estimatedInputTokens,
    rewrittenToolOutputs,
    droppedHistoryItems: beforeDropLength - history.length,
  };
}

function minimalToolResultForCompaction(item: CompactionItem): CompactionItem {
  const type = itemType(item);
  if (!type || !RESULT_TYPES.has(type)) return item;
  if (type === "tool_search_output" && Array.isArray(item.tools) && item.tools.length > 0) {
    return { ...item, tools: [] };
  }
  return boundModelToolOutputItem(item, 0);
}

function oldestLogicalUnitCuts(items: readonly CompactionItem[]): number[] {
  const userMessageIndexes: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (isUserMessage(items[index])) userMessageIndexes.push(index);
  }
  const cuts: number[] = [];
  if (userMessageIndexes.length === 0) {
    return [items.length];
  }
  if (userMessageIndexes[0]! > 0) cuts.push(userMessageIndexes[0]!);
  for (const index of userMessageIndexes.slice(1)) cuts.push(index);
  cuts.push(items.length);
  return cuts;
}

/**
 * Build the active history after compaction:
 * the newest real user messages that fit one cumulative 20k-token budget
 * (prior summaries excluded, images removed) plus one marked summary item.
 */
export function buildCompactionReplacementHistory(
  items: readonly CompactionItem[],
  summaryBody: string,
): CompactionItem[] {
  const retainedReversed: CompactionItem[] = [];
  let remaining = COMPACT_USER_MESSAGE_MAX_TOKENS;
  for (let index = items.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = items[index]!;
    if (!isUserMessage(item) || isCompactionSummary(item)) {
      continue;
    }
    const textTokens = estimateTextTokens(messageText(item));
    retainedReversed.push(compactMessageToTokenBudget(item, remaining));
    if (textTokens > remaining) {
      remaining = 0;
      break;
    }
    remaining -= textTokens;
  }
  const history = retainedReversed.reverse();
  history.push(buildSummaryItem(summaryBody));
  return history;
}

export function compactionReplacementFingerprint(items: readonly CompactionItem[]): string {
  // PostgreSQL JSONB does not preserve JavaScript object-key insertion order.
  // Canonicalize recursively so a replacement has the same identity before
  // and after its durable round trip.
  const serialized = JSON.stringify(canonicalJsonValue(items));
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
  );
}

/** Fingerprint the latest durable replacement prefix in active history. */
export function latestCompactionReplacementFingerprint(
  items: readonly CompactionItem[],
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (isCompactionSummary(items[index])) {
      return compactionReplacementFingerprint(items.slice(0, index + 1));
    }
  }
  return null;
}

/**
 * Build the synthetic summary item (a plain user message) appended to the
 * rebuilt active history.
 */
export function buildSummaryItem(summaryBody: string): CompactionItem {
  const trimmed = summaryBody.trim();
  if (!trimmed) {
    throw new EmptyCompactionSummaryError({ stage: "build_summary_item" });
  }
  return {
    type: "message",
    role: "user",
    content: `${SUMMARY_PREFIX}\n${trimmed}`,
    [COMPACTION_SUMMARY_MARKER]: true,
  };
}

function compactMessageToTokenBudget(item: CompactionItem, maxTokens: number): CompactionItem {
  const text = messageText(item);
  const next = { ...item };
  if (estimateTextTokens(text) > maxTokens) {
    next.content = truncateMiddleByEstimatedTokens(text, maxTokens);
    return next;
  }
  next.content = contentWithoutImages(item);
  return next;
}

function truncateMiddleByEstimatedTokens(text: string, maxTokens: number): string {
  const budget = Math.max(0, Math.floor(maxTokens));
  if (estimateTextTokens(text) <= budget) {
    return text;
  }
  if (estimateTextTokens(USER_MESSAGE_TRUNCATION_MARKER) > budget) {
    return tokenBoundedPrefix(USER_MESSAGE_TRUNCATION_MARKER, budget);
  }

  let low = 0;
  let high = text.length;
  let best = USER_MESSAGE_TRUNCATION_MARKER;
  while (low <= high) {
    const keepCodeUnits = Math.floor((low + high) / 2);
    const candidate = middleTruncationCandidate(text, keepCodeUnits);
    if (estimateTextTokens(candidate) <= budget) {
      best = candidate;
      low = keepCodeUnits + 1;
    } else {
      high = keepCodeUnits - 1;
    }
  }
  return best;
}

function middleTruncationCandidate(text: string, keepCodeUnits: number): string {
  const headTarget = Math.ceil(keepCodeUnits / 2);
  const tailTarget = Math.floor(keepCodeUnits / 2);
  const headEnd = validPrefixBoundary(text, headTarget);
  const tailStart = validSuffixBoundary(text, text.length - tailTarget);
  return `${text.slice(0, headEnd)}${USER_MESSAGE_TRUNCATION_MARKER}${text.slice(tailStart)}`;
}

function tokenBoundedPrefix(text: string, maxTokens: number): string {
  let low = 0;
  let high = text.length;
  let best = "";
  while (low <= high) {
    const target = Math.floor((low + high) / 2);
    const end = validPrefixBoundary(text, target);
    const candidate = text.slice(0, end);
    if (estimateTextTokens(candidate) <= maxTokens) {
      best = candidate;
      low = target + 1;
    } else {
      high = target - 1;
    }
  }
  return best;
}

/** Largest boundary at or below target that does not split a surrogate pair. */
function validPrefixBoundary(text: string, target: number): number {
  let boundary = Math.max(0, Math.min(text.length, target));
  if (
    boundary > 0 &&
    boundary < text.length &&
    isHighSurrogate(text.charCodeAt(boundary - 1)) &&
    isLowSurrogate(text.charCodeAt(boundary))
  ) {
    boundary -= 1;
  }
  return boundary;
}

/** Smallest boundary at or above target that does not split a surrogate pair. */
function validSuffixBoundary(text: string, target: number): number {
  let boundary = Math.max(0, Math.min(text.length, target));
  if (
    boundary > 0 &&
    boundary < text.length &&
    isHighSurrogate(text.charCodeAt(boundary - 1)) &&
    isLowSurrogate(text.charCodeAt(boundary))
  ) {
    boundary += 1;
  }
  return boundary;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function contentWithoutImages(item: CompactionItem): unknown {
  const content = (item as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return content;
  }
  return content.filter((part) => {
    if (!part || typeof part !== "object") {
      return true;
    }
    const type = (part as { type?: unknown }).type;
    return type !== "input_image" && type !== "image_url";
  });
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
          const record = part as { text?: unknown; content?: unknown };
          if (typeof record.text === "string") {
            return record.text;
          }
          if (typeof record.content === "string") {
            return record.content;
          }
        }
        return "";
      })
      .join("");
  }
  return "";
}

export function renderCompactionPromptInputForChat(input: readonly CompactionItem[]): string {
  return input.map(renderItem).join("\n");
}

function renderItem(item: CompactionItem): string {
  const type = itemType(item) ?? "unknown";
  if (type === "message") {
    const role = itemRole(item) ?? "assistant";
    return `[${role}] ${messageText(item)}`;
  }
  if (type === "reasoning") {
    return "[reasoning] (omitted)";
  }
  if (RESULT_TYPES.has(type)) {
    return `[tool_result] ${resultText(item)}`;
  }
  if (RESULT_TYPE_BY_CALL_TYPE[type]) {
    return `[tool_call ${type}] ${callText(item)}`;
  }
  return `[${type}] ${safeStringify(item)}`;
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
