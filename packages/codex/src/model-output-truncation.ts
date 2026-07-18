/**
 * Canonical model-facing tool-output truncation.
 *
 * Ported from openai/codex `rust-v0.144.6` (commit
 * 5d1fbf26c43abc65a203928b2e31561cb039e06d):
 *
 * - `codex-rs/utils/string/src/truncate.rs`
 * - `codex-rs/utils/output-truncation/src/lib.rs`
 * - `codex-rs/core/src/context_manager/history.rs`
 *
 * The live gpt-5.6 model catalog declares a 10,000-token truncation policy.
 * Codex applies a 1.2x allowance before serializing a function-call output, so
 * the effective textual payload budget is 12,000 approximate tokens. Images,
 * files, and encrypted content are preserved; textual content shares one
 * sequential budget and carries an explicit head/tail truncation marker.
 *
 * This module deliberately has no database or Agents SDK dependency. Both the
 * runtime request seam and the database history boundary call the same pure
 * function, so replayed conversation truth is identical to live model input.
 */

export type ModelHistoryItem = Record<string, unknown>;

export const CODEX_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS = 10_000;
export const CODEX_TOOL_OUTPUT_SERIALIZATION_ALLOWANCE = 1.2;
export const DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS =
  CODEX_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS;

const APPROX_BYTES_PER_TOKEN = 4;
const TOOL_RESULT_TYPES = new Set([
  "function_call_result",
  "function_call_output",
  "custom_tool_call_output",
  "shell_call_output",
  "apply_patch_call_output",
]);
const STRUCTURAL_STRING_KEYS = new Set([
  "type",
  "role",
  "status",
  "name",
  "id",
  "callId",
  "call_id",
  "namespace",
  "detail",
  "mimeType",
  "media_type",
]);

export function modelToolOutputSerializationBudgetTokens(
  policyTokens = DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
): number {
  return Math.ceil(Math.max(0, policyTokens) * CODEX_TOOL_OUTPUT_SERIALIZATION_ALLOWANCE);
}

export function approximateTokenCount(value: string): number {
  return Math.ceil(Buffer.byteLength(value, "utf8") / APPROX_BYTES_PER_TOKEN);
}

/** Exact Codex-style middle truncation for a token policy. */
export function truncateMiddleWithTokenBudget(value: string, maxTokens: number): string {
  if (value.length === 0) return value;
  const maxBytes = Math.max(0, maxTokens) * APPROX_BYTES_PER_TOKEN;
  const valueBytes = Buffer.byteLength(value, "utf8");
  if (maxTokens > 0 && valueBytes <= maxBytes) return value;
  if (maxBytes === 0) {
    return `…${approximateTokenCount(value)} tokens truncated…`;
  }

  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  // Do not materialize `Array.from(value)`: production tool results can be
  // multi-megabyte strings and one JS element per code point multiplies peak
  // memory. A single UTF-8 buffer gives bounded scans at the two cut points.
  const bytes = Buffer.from(value, "utf8");
  let leftEnd = Math.min(leftBudget, bytes.length);
  while (leftEnd > 0 && leftEnd < bytes.length && isUtf8ContinuationByte(bytes[leftEnd]!)) {
    leftEnd -= 1;
  }
  let rightStart = Math.max(0, bytes.length - rightBudget);
  while (rightStart < bytes.length && isUtf8ContinuationByte(bytes[rightStart]!)) {
    rightStart += 1;
  }
  const left = bytes.subarray(0, leftEnd).toString("utf8");
  const right = bytes.subarray(rightStart).toString("utf8");
  const removedBytes = Math.max(0, valueBytes - maxBytes);
  const removedTokens = Math.ceil(removedBytes / APPROX_BYTES_PER_TOKEN);
  return `${left}…${removedTokens} tokens truncated…${right}`;
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

/**
 * Bound every model-visible tool-result item. Non-result items are returned by
 * reference. Result items are cloned only when their textual output changes.
 */
export function boundModelToolOutputItem<T extends ModelHistoryItem>(
  item: T,
  policyTokens = DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
): T {
  const type = typeof item.type === "string" ? item.type : "";
  if (!TOOL_RESULT_TYPES.has(type)) return item;
  const budget = modelToolOutputSerializationBudgetTokens(policyTokens);
  const boundedOutput = boundToolOutputValue(item.output, budget);
  return boundedOutput === item.output ? item : ({ ...item, output: boundedOutput } as T);
}

export function boundModelToolOutputItems<T extends ModelHistoryItem>(
  items: readonly T[],
  policyTokens = DEFAULT_MODEL_TOOL_OUTPUT_TRUNCATION_TOKENS,
): T[] {
  return items.map((item) => boundModelToolOutputItem(item, policyTokens));
}

function boundToolOutputValue(output: unknown, budgetTokens: number): unknown {
  if (typeof output === "string") {
    // Text-transport computer/view_image tools use a data URL because Chat
    // Completions has no structured image result. It is still image protocol,
    // not textual tool output; truncating its base64 permanently corrupts it.
    if (isImageDataUrl(output)) return output;
    return truncateMiddleWithTokenBudget(output, budgetTokens);
  }
  if (Array.isArray(output)) {
    // Responses content arrays have an explicit text/image/file protocol and
    // follow Codex's sequential item policy exactly. Shell/apply adapters can
    // instead return arrays of objects containing stdout/stderr; those share
    // the same total text budget through the generic leaf walker.
    return output.every(
      (item) =>
        item &&
        typeof item === "object" &&
        (isTextContentItem(item as Record<string, unknown>) ||
          isNonTextContentItem(item as Record<string, unknown>)),
    )
      ? boundStructuredOutputItems(output, budgetTokens)
      : boundTextLeaves(output, { remaining: budgetTokens, omitted: 0 });
  }
  if (!output || typeof output !== "object") return output;

  const record = output as Record<string, unknown>;
  if (isTextContentItem(record)) {
    const text = record.text as string;
    if (isImageDataUrl(text)) return output;
    const bounded = truncateMiddleWithTokenBudget(text, budgetTokens);
    return bounded === text ? output : { ...record, text: bounded };
  }
  if (isNonTextContentItem(record)) return output;

  // Shell/apply-patch result objects are not structured Responses content, but
  // can contain arbitrarily large stdout/stderr leaves. Preserve their shape
  // while sharing one sequential text budget across the whole value.
  const state = { remaining: budgetTokens, omitted: 0 };
  return boundTextLeaves(record, state);
}

function boundStructuredOutputItems(items: unknown[], budgetTokens: number): unknown[] {
  let remaining = budgetTokens;
  let omitted = 0;
  let changed = false;
  const out: unknown[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || !isTextContentItem(item as Record<string, unknown>)) {
      out.push(item);
      continue;
    }
    const record = item as Record<string, unknown>;
    const text = record.text as string;
    if (isImageDataUrl(text)) {
      out.push(item);
      continue;
    }
    if (remaining === 0) {
      omitted += 1;
      changed = true;
      continue;
    }
    const cost = approximateTokenCount(text);
    if (cost <= remaining) {
      out.push(item);
      remaining -= cost;
      continue;
    }
    out.push({ ...record, text: truncateMiddleWithTokenBudget(text, remaining) });
    remaining = 0;
    changed = true;
  }
  if (omitted > 0) {
    out.push({ type: "input_text", text: `[omitted ${omitted} text items ...]` });
  }
  return changed ? out : items;
}

function boundTextLeaves(
  value: unknown,
  state: { remaining: number; omitted: number },
  depth = 0,
): unknown {
  if (typeof value === "string") {
    if (isImageDataUrl(value)) return value;
    if (state.remaining === 0) {
      state.omitted += 1;
      return `[omitted text field ${state.omitted} ...]`;
    }
    const cost = approximateTokenCount(value);
    if (cost <= state.remaining) {
      state.remaining -= cost;
      return value;
    }
    const bounded = truncateMiddleWithTokenBudget(value, state.remaining);
    state.remaining = 0;
    return bounded;
  }
  if (!value || typeof value !== "object" || depth >= 12) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => boundTextLeaves(entry, state, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (isNonTextContentItem(record)) return value;
  if (isTextContentItem(record)) {
    const text = boundTextLeaves(record.text, state, depth + 1);
    return text === record.text ? value : { ...record, text };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      typeof entry === "string" && STRUCTURAL_STRING_KEYS.has(key)
        ? entry
        : boundTextLeaves(entry, state, depth + 1),
    ]),
  );
}

function isTextContentItem(value: Record<string, unknown>): boolean {
  return (
    typeof value.text === "string" &&
    (value.type === "text" || value.type === "input_text" || value.type === "output_text")
  );
}

function isNonTextContentItem(value: Record<string, unknown>): boolean {
  return (
    value.type === "image" ||
    value.type === "input_image" ||
    value.type === "file" ||
    value.type === "input_file" ||
    value.type === "encrypted_content"
  );
}

function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}
