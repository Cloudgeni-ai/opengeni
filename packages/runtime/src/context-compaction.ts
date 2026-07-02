/**
 * Client-side conversation context compaction (the Azure/client path).
 *
 * This mirrors Codex CLI's compaction model: the checkpoint model sees the
 * current active history plus one fixed checkpoint prompt, then the active
 * history is rebuilt as all real user messages plus one summary message.
 * Assistant messages, tool calls/results, reasoning, and images are removed
 * from the active model-facing history; the database audit rows remain.
 */

export type CompactionItem = Record<string, unknown>;

/**
 * Marker stored on the synthetic summary item so the UI can render it and the
 * next rebuild can exclude old summaries from the retained user-message set.
 */
export const COMPACTION_SUMMARY_MARKER = "opengeni_context_summary";

export const SUMMARY_BUFFER_TOKENS = 20_000;
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;
export const CLIENT_COMPACTION_TRIGGER_FRACTION = 0.9;

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

export function clientCompactionThresholdTokens(input: {
  contextWindowTokens: number;
  contextReservedOutputTokens: number;
}): number {
  const available = Math.max(
    0,
    input.contextWindowTokens - input.contextReservedOutputTokens - SUMMARY_BUFFER_TOKENS,
  );
  return Math.floor(available * CLIENT_COMPACTION_TRIGGER_FRACTION);
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
  const text = messageText(item);
  const next = { ...item };
  if (estimatedTextTokens(text) > COMPACT_USER_MESSAGE_MAX_TOKENS) {
    next.content = truncateMiddleByEstimatedTokens(text, COMPACT_USER_MESSAGE_MAX_TOKENS);
    return next;
  }
  next.content = contentWithoutImages(item);
  return next;
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

export function renderCompactionPromptInputForChat(input: readonly CompactionItem[]): string {
  return input.map(renderItem).join("\n");
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
