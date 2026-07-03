/**
 * Client-side conversation context compaction (the Azure/client path).
 *
 * This mirrors Codex CLI's compaction model: the checkpoint model sees the
 * current active history plus one fixed checkpoint prompt, then the active
 * history is rebuilt as all real user messages plus one summary message.
 * Assistant messages, tool calls/results, reasoning, and images are removed
 * from the active model-facing history; the database audit rows remain.
 */

import { TOOL_CALL_RESULT_TYPE_BY_CALL_TYPE } from "./history-sanitizer";

export type CompactionItem = Record<string, unknown>;

/**
 * Marker stored on the synthetic summary item so the UI can render it and the
 * next rebuild can exclude old summaries from the retained user-message set.
 */
export const COMPACTION_SUMMARY_MARKER = "opengeni_context_summary";

export const SUMMARY_BUFFER_TOKENS = 20_000;
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.6;
export const MIN_COMPACTION_THRESHOLD_RATIO = 0.3;
export const MAX_COMPACTION_THRESHOLD_RATIO = 0.9;
export const COMPACTION_FALLBACK_TARGET_RATIO = 0.5;

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
    isUserMessage(item)
    && (item as Record<string, unknown>)[COMPACTION_SUMMARY_MARKER] === true
  );
}

/**
 * Rough token estimate for an item: char/4 over its serialized text. Used for
 * the pre-first-call fallback, per-user-message cap, and read-path airbag.
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

export function clampCompactionThresholdRatio(value: number | undefined | null): number {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : DEFAULT_COMPACTION_THRESHOLD_RATIO;
  return Math.min(MAX_COMPACTION_THRESHOLD_RATIO, Math.max(MIN_COMPACTION_THRESHOLD_RATIO, numeric));
}

export function clientCompactionThresholdTokens(input: {
  contextWindowTokens: number;
  contextReservedOutputTokens: number;
  contextCompactionThresholdRatio?: number | null;
}): number {
  return Math.floor(Math.max(0, input.contextWindowTokens) * clampCompactionThresholdRatio(input.contextCompactionThresholdRatio));
}

export type ClientCompactionDecision = {
  shouldCompact: boolean;
  reason: "force" | "above_threshold" | "below_threshold" | "no_history";
  signalTokens: number;
  thresholdTokens: number;
};

export function decideClientCompaction(input: {
  items: readonly CompactionItem[];
  lastInputTokens?: number | null;
  contextWindowTokens: number;
  contextReservedOutputTokens: number;
  contextCompactionThresholdRatio?: number | null;
  force?: boolean;
}): ClientCompactionDecision {
  const thresholdTokens = clientCompactionThresholdTokens(input);
  const recorded =
    typeof input.lastInputTokens === "number" && input.lastInputTokens > 0
      ? input.lastInputTokens
      : 0;
  const signalTokens = recorded > 0 ? recorded : estimateTokens(input.items);
  if (input.items.length === 0) {
    return { shouldCompact: false, reason: "no_history", signalTokens, thresholdTokens };
  }
  if (input.force) {
    return { shouldCompact: true, reason: "force", signalTokens, thresholdTokens };
  }
  if (signalTokens > thresholdTokens) {
    return { shouldCompact: true, reason: "above_threshold", signalTokens, thresholdTokens };
  }
  return { shouldCompact: false, reason: "below_threshold", signalTokens, thresholdTokens };
}

export class CompactionNeededError extends Error {
  readonly signalTokens: number;
  readonly thresholdTokens: number;
  readonly signalSource: "provider" | "estimate";

  constructor(input: {
    signalTokens: number;
    thresholdTokens: number;
    signalSource: "provider" | "estimate";
  }) {
    super(
      `Context compaction needed: signal ${input.signalTokens} tokens exceeded threshold ${input.thresholdTokens}`,
    );
    this.name = "CompactionNeededError";
    this.signalTokens = input.signalTokens;
    this.thresholdTokens = input.thresholdTokens;
    this.signalSource = input.signalSource;
  }
}

export function findCompactionNeededError(error: unknown, seen = new WeakSet<object>()): CompactionNeededError | null {
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
    findCompactionNeededError(record.cause, seen)
    ?? findCompactionNeededError(record.error, seen)
  );
}

/**
 * Walk backwards from the end of `items` keeping whole turns until the kept
 * tail would exceed `keepRecentTokens`, and return the index of the first kept
 * item. Retained for the read-path budget guard only; the client compaction
 * rebuild no longer uses a keep-recent tail.
 */
export function findKeepBoundary(items: readonly CompactionItem[], keepRecentTokens: number): number {
  const boundaries: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (isUserMessage(items[i])) {
      boundaries.push(i);
    }
  }
  if (boundaries.length === 0) {
    return 0;
  }
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
 * Drops the oldest history at a clean user-message boundary until an assembled
 * input fits the request budget. This remains a request-local safety rail; it
 * is not the compaction strategy.
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
  const historyBudget = Math.max(0, maxTokens - Math.max(0, trailingTokens));
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

/**
 * Build the active history after compaction:
 * all real user messages (prior summaries excluded, images removed, each
 * message capped) plus one marked summary item.
 */
export function buildCompactionReplacementHistory(
  items: readonly CompactionItem[],
  summaryBody: string,
): CompactionItem[] {
  const history: CompactionItem[] = [];
  for (const item of items) {
    if (!isUserMessage(item) || isCompactionSummary(item)) {
      continue;
    }
    history.push(compactUserMessage(item));
  }
  history.push(buildSummaryItem(summaryBody));
  return history;
}

export type DeterministicFallbackCompactionInput = {
  items: readonly CompactionItem[];
  cause?: string;
  targetTokens?: number;
};

export function buildDeterministicFallbackCompactionHistory(input: DeterministicFallbackCompactionInput): CompactionItem[] {
  const sourceTokens = Math.max(1, estimateTokens(input.items));
  const requestedTarget = typeof input.targetTokens === "number" && input.targetTokens > 0
    ? Math.floor(input.targetTokens)
    : Math.floor(sourceTokens * COMPACTION_FALLBACK_TARGET_RATIO);
  const targetTokens = Math.max(1, Math.min(requestedTarget, Math.max(1, sourceTokens - 1)));
  const summaryItem = buildSummaryItem([
    "Non-LLM context compaction fallback.",
    input.cause ? `Summarizer failure: ${input.cause}` : "Summarizer failure: unavailable.",
    "Older assistant, tool, reasoning, and image history was dropped deterministically.",
    "Retained context above is limited to initial instructions and the most recent user messages that fit the fallback budget; oversized retained messages may be middle-truncated.",
  ].join("\n"));
  const summaryTokens = estimateItemTokens(summaryItem);
  let remaining = Math.max(0, targetTokens - summaryTokens);
  const retainedInstructions: CompactionItem[] = [];

  for (const item of input.items) {
    if (!isInitialInstructionMessage(item)) {
      if (isUserMessage(item)) {
        break;
      }
      continue;
    }
    if (remaining <= 0) {
      break;
    }
    const capped = compactMessageToEstimatedItemBudget(item, Math.min(2_000, remaining));
    if (!capped) {
      continue;
    }
    const tokens = estimateItemTokens(capped);
    if (tokens <= remaining) {
      retainedInstructions.push(capped);
      remaining -= tokens;
    }
  }

  const retainedUsers: CompactionItem[] = [];
  for (let index = input.items.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = input.items[index]!;
    if (!isUserMessage(item) || isCompactionSummary(item)) {
      continue;
    }
    const capped = compactMessageToEstimatedItemBudget(item, Math.min(COMPACT_USER_MESSAGE_MAX_TOKENS, remaining));
    if (!capped) {
      continue;
    }
    const tokens = estimateItemTokens(capped);
    if (tokens <= remaining) {
      retainedUsers.push(capped);
      remaining -= tokens;
    }
  }
  retainedUsers.reverse();

  return [...retainedInstructions, ...retainedUsers, summaryItem];
}

/**
 * Build the synthetic summary item (a plain user message) appended to the
 * rebuilt active history.
 */
export function buildSummaryItem(summaryBody: string): CompactionItem {
  const trimmed = summaryBody.trim();
  return {
    type: "message",
    role: "user",
    content: `${SUMMARY_PREFIX}\n${trimmed}`,
    [COMPACTION_SUMMARY_MARKER]: true,
  };
}

function compactUserMessage(item: CompactionItem): CompactionItem {
  return compactMessageToTokenBudget(item, COMPACT_USER_MESSAGE_MAX_TOKENS);
}

function compactMessageToTokenBudget(item: CompactionItem, maxTokens: number): CompactionItem {
  const text = messageText(item);
  const next = { ...item };
  if (estimatedTextTokens(text) > maxTokens) {
    next.content = truncateMiddleByEstimatedTokens(text, maxTokens);
    return next;
  }
  next.content = contentWithoutImages(item);
  return next;
}

function compactMessageToEstimatedItemBudget(item: CompactionItem, maxItemTokens: number): CompactionItem | null {
  if (maxItemTokens <= 0) {
    return null;
  }
  const overheadTokens = estimateItemTokens({ ...item, content: "" });
  let contentBudget = Math.max(0, maxItemTokens - overheadTokens);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const capped = compactMessageToTokenBudget(item, contentBudget);
    const estimated = estimateItemTokens(capped);
    if (estimated <= maxItemTokens) {
      return capped;
    }
    const overage = estimated - maxItemTokens;
    if (contentBudget <= 0) {
      break;
    }
    contentBudget = Math.max(0, contentBudget - Math.max(1, overage));
  }
  return null;
}

function estimatedTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncateMiddleByEstimatedTokens(text: string, maxTokens: number): string {
  const maxChars = Math.max(0, maxTokens * 4);
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= USER_MESSAGE_TRUNCATION_MARKER.length) {
    return USER_MESSAGE_TRUNCATION_MARKER.slice(0, maxChars);
  }
  const keepChars = maxChars - USER_MESSAGE_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(keepChars / 2);
  const tailChars = Math.floor(keepChars / 2);
  return `${text.slice(0, headChars)}${USER_MESSAGE_TRUNCATION_MARKER}${text.slice(text.length - tailChars)}`;
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

function isInitialInstructionMessage(item: unknown): boolean {
  const type = itemType(item);
  const role = itemRole(item);
  return type === "message" && (role === "system" || role === "developer");
}

export type RenderCompactionTranscriptOptions = {
  /**
   * Hard cap for a rendered transcript. When set, oldest rendered items are
   * dropped first while preserving the final checkpoint prompt; if the retained
   * item itself is too large, it is middle-truncated instead of looping.
   */
  maxEstimatedTokens?: number;
};

export function renderCompactionPromptInputForChat(
  input: readonly CompactionItem[],
  options: RenderCompactionTranscriptOptions = {},
): string {
  const rendered = input.map(renderItem);
  if (typeof options.maxEstimatedTokens !== "number" || options.maxEstimatedTokens <= 0) {
    return rendered.join("\n");
  }
  const maxChars = Math.max(1, Math.floor(options.maxEstimatedTokens * 4));
  const last = rendered.at(-1);
  const prefix = rendered.slice(0, -1);
  let kept = prefix.slice();
  while (kept.length > 0 && transcriptLength([...kept, last].filter((line): line is string => line !== undefined)) > maxChars) {
    kept.shift();
  }
  const lines = [...kept, last].filter((line): line is string => line !== undefined);
  const joined = lines.join("\n");
  if (joined.length <= maxChars) {
    return joined;
  }
  return truncateMiddleByChars(joined, maxChars);
}

function renderItem(item: CompactionItem): string {
  const type = itemType(item) ?? "unknown";
  if (type === "message") {
    const role = itemRole(item) ?? "assistant";
    return `[${role}] ${truncateForTranscript(messageText(item), 4000)}`;
  }
  if (type === "reasoning") {
    return "[reasoning] (omitted)";
  }
  if (RESULT_TYPES.has(type)) {
    return `[tool_result] ${truncateForTranscript(resultText(item), 2000)}`;
  }
  if (RESULT_TYPE_BY_CALL_TYPE[type]) {
    return `[tool_call ${type}] ${truncateForTranscript(callText(item), 1000)}`;
  }
  return `[${type}] ${truncateForTranscript(safeStringify(item), 1000)}`;
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

function truncateForTranscript(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}... (${text.length - max} more chars)`;
}

function transcriptLength(lines: readonly string[]): number {
  if (lines.length === 0) {
    return 0;
  }
  return lines.reduce((sum, line) => sum + line.length, 0) + Math.max(0, lines.length - 1);
}

function truncateMiddleByChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= USER_MESSAGE_TRUNCATION_MARKER.length) {
    return USER_MESSAGE_TRUNCATION_MARKER.slice(0, maxChars);
  }
  const keepChars = maxChars - USER_MESSAGE_TRUNCATION_MARKER.length;
  const headChars = Math.ceil(keepChars / 2);
  const tailChars = Math.floor(keepChars / 2);
  return `${text.slice(0, headChars)}${USER_MESSAGE_TRUNCATION_MARKER}${text.slice(text.length - tailChars)}`;
}
