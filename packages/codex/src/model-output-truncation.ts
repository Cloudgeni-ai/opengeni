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
// Twelve decimal digits already describe ~4 TB at four bytes/token, far beyond
// any JavaScript string the runtime can materialize. Bounding the digit run is
// security-significant: otherwise a forged multi-megabyte run of digits could
// make `markerBytes` as large as the entire untrusted tool result and bypass the
// cap below.
const TOKEN_TRUNCATION_MARKER = /…\d{1,12} tokens truncated…/u;
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
const MODEL_TOOL_OUTPUT_MAX_DEPTH = 12;
const MODEL_TOOL_OUTPUT_MAX_CONTAINER_ENTRIES = 255;
const MODEL_TOOL_OUTPUT_MAX_TOTAL_ENTRIES = 2_048;
const MODEL_TOOL_OUTPUT_MAX_PROPERTY_KEY_BYTES = 256;
const MODEL_TOOL_OUTPUT_MAX_STRUCTURAL_STRING_TOKENS = 64;
const MODEL_TOOL_OUTPUT_STRUCTURAL_STRING_BUDGET_TOKENS = 1_024;
export const MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES = 8 * 1024 * 1024;

const DEPTH_OMISSION_MARKER =
  "[OpenGeni omitted subtree: maximum structured tool-output depth exceeded]";
const CYCLE_OMISSION_MARKER = "[OpenGeni omitted subtree: cyclic tool output]";
const STRUCTURAL_STRING_OMISSION_MARKER =
  "[OpenGeni omitted structural string: structural budget exhausted]";
const TEXT_FIELD_OMISSION_MARKER = /^\[omitted text field \d+ \.\.\.\]$/u;
const TEXT_ITEMS_OMISSION_MARKER = /^\[omitted \d+ text items \.\.\.\]$/u;
const STRUCTURAL_ENTRIES_OMISSION_MARKER =
  /^\[OpenGeni omitted \d+ structured (?:array items|object properties)\]$/u;
const OPAQUE_PAYLOAD_OMISSION_MARKER =
  /^\[OpenGeni omitted (?:image|file|encrypted) payload: \d+ bytes exceeded the bounded model-input allowance\]$/u;
const STRUCTURAL_PROPERTIES_MARKER_KEY = "__opengeni_omitted_properties__";

type OpaqueProtocolKind = "image" | "file" | "encrypted";

type ModelOutputBoundState = {
  remaining: number;
  remainingStructural: number;
  remainingEntries: number;
  remainingOpaqueBytes: number;
  omitted: number;
  seen: WeakSet<object>;
};

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
  // Codex applies this transform once while recording history, so its marker
  // sits just outside the content budget. OpenGeni deliberately enforces the
  // same policy both at canonical persistence and at the final provider seam.
  // Recognize only an output whose excess is no larger than its own canonical
  // marker; this makes that repeated enforcement byte-idempotent without letting
  // an arbitrary oversized string bypass the cap merely by containing marker-like
  // text. The first application remains byte-for-byte Codex 0.144.6 behavior.
  const existingMarker = value.match(TOKEN_TRUNCATION_MARKER)?.[0];
  if (existingMarker && valueBytes <= maxBytes + Buffer.byteLength(existingMarker, "utf8")) {
    return value;
  }
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
  const state = modelOutputBoundState(budgetTokens);
  if (typeof output === "string") {
    if (isGeneratedModelOutputMarker(output)) {
      observeGeneratedMarkerBudget(output, state);
      return output;
    }
    // Text-transport computer/view_image tools use a data URL because Chat
    // Completions has no structured image result. It is still image protocol,
    // not textual tool output; truncating its base64 permanently corrupts it.
    if (isImageDataUrl(output)) return boundOpaqueProtocolString(output, state, "image");
    return truncateMiddleWithTokenBudget(output, budgetTokens);
  }
  if (Array.isArray(output)) {
    // Responses content arrays have an explicit text/image/file protocol and
    // follow Codex's sequential item policy exactly. Shell/apply adapters can
    // instead return arrays of objects containing stdout/stderr; those share
    // the same total text budget through the generic leaf walker.
    const isProtocolContent =
      output.length <= MODEL_TOOL_OUTPUT_MAX_CONTAINER_ENTRIES &&
      output.every(
        (item) =>
          item &&
          typeof item === "object" &&
          (isTextContentItem(item as Record<string, unknown>) ||
            isNonTextContentItem(item as Record<string, unknown>)),
      );
    return isProtocolContent
      ? boundStructuredOutputItems(output, state)
      : boundTextLeaves(output, state);
  }
  if (!output || typeof output !== "object") return output;

  const record = output as Record<string, unknown>;
  // Shell/apply-patch result objects are not structured Responses content, but
  // can contain arbitrarily large stdout/stderr leaves. Preserve useful shape
  // while sharing bounded text, structural, entry, depth, and opaque-protocol
  // budgets across the whole value.
  return boundTextLeaves(record, state);
}

function modelOutputBoundState(budgetTokens: number): ModelOutputBoundState {
  return {
    remaining: Math.max(0, budgetTokens),
    remainingStructural: MODEL_TOOL_OUTPUT_STRUCTURAL_STRING_BUDGET_TOKENS,
    remainingEntries: MODEL_TOOL_OUTPUT_MAX_TOTAL_ENTRIES,
    remainingOpaqueBytes: MODEL_TOOL_OUTPUT_OPAQUE_PAYLOAD_MAX_BYTES,
    omitted: 0,
    seen: new WeakSet(),
  };
}

function boundStructuredOutputItems(items: unknown[], state: ModelOutputBoundState): unknown[] {
  let omitted = 0;
  let changed = false;
  const out: unknown[] = [];
  let processed = 0;
  for (const item of items) {
    if (processed >= MODEL_TOOL_OUTPUT_MAX_CONTAINER_ENTRIES || state.remainingEntries <= 0) {
      break;
    }
    processed += 1;
    state.remainingEntries -= 1;
    if (!item || typeof item !== "object" || !isTextContentItem(item as Record<string, unknown>)) {
      const bounded = boundTextLeaves(item, state, 1);
      out.push(bounded);
      if (bounded !== item) changed = true;
      continue;
    }
    const record = item as Record<string, unknown>;
    const text = record.text as string;
    if (isGeneratedModelOutputMarker(text)) {
      out.push(boundTextLeaves(item, state, 1));
      continue;
    }
    if (state.remaining === 0 && !isImageDataUrl(text)) {
      omitted += 1;
      changed = true;
      continue;
    }
    const bounded = boundTextLeaves(item, state, 1);
    out.push(bounded);
    if (bounded !== item) changed = true;
  }
  if (omitted > 0) {
    out.push({
      type: "input_text",
      text: `[omitted ${omitted} text items ...]`,
    });
  }
  const structurallyOmitted = items.length - processed;
  if (structurallyOmitted > 0) {
    out.push(structuredEntriesOmissionMarker(structurallyOmitted, "array"));
    changed = true;
  }
  return changed ? out : items;
}

function boundTextLeaves(
  value: unknown,
  state: ModelOutputBoundState,
  depth = 0,
  opaqueKind: OpaqueProtocolKind | null = null,
): unknown {
  if (typeof value === "string") {
    if (isGeneratedModelOutputMarker(value)) {
      observeGeneratedMarkerBudget(value, state);
      return value;
    }
    if (opaqueKind || isImageDataUrl(value)) {
      return boundOpaqueProtocolString(value, state, opaqueKind ?? "image");
    }
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
  if (!value || typeof value !== "object") return value;
  if (depth >= MODEL_TOOL_OUTPUT_MAX_DEPTH) return DEPTH_OMISSION_MARKER;
  if (state.seen.has(value)) return CYCLE_OMISSION_MARKER;
  state.seen.add(value);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    let processed = 0;
    let changed = false;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (processed >= MODEL_TOOL_OUTPUT_MAX_CONTAINER_ENTRIES || state.remainingEntries <= 0) {
        // A prior pass can add exactly one structural trailer beyond the normal
        // item allowance. Retain only that final trailer for replay idempotence;
        // marker-shaped untrusted entries otherwise consume the same caps as
        // every other entry and cannot form an unbounded bypass.
        if (
          index === value.length - 1 &&
          typeof entry === "string" &&
          STRUCTURAL_ENTRIES_OMISSION_MARKER.test(entry)
        ) {
          out.push(entry);
        }
        break;
      }
      processed += 1;
      state.remainingEntries -= 1;
      const bounded = boundTextLeaves(entry, state, depth + 1, opaqueKind);
      out.push(bounded);
      if (bounded !== entry) changed = true;
    }
    const omitted = value.length - out.length;
    if (omitted > 0) {
      out.push(structuredEntriesOmissionMarker(omitted, "array"));
      changed = true;
    }
    state.seen.delete(value);
    return changed ? out : value;
  }
  const record = value as Record<string, unknown>;
  const recordOpaqueKind = nonTextProtocolKind(record.type) ?? opaqueKind;
  const entries = Object.entries(record);
  const out: Record<string, unknown> = {};
  let processed = 0;
  let omitted = 0;
  let changed = false;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, entry] = entries[index]!;
    if (processed >= MODEL_TOOL_OUTPUT_MAX_CONTAINER_ENTRIES || state.remainingEntries <= 0) {
      // As with arrays, a bounded prior pass may have appended one final marker
      // property after filling the normal property allowance. Preserve only
      // that terminal marker; forged/interspersed marker properties remain
      // ordinary bounded input.
      if (index === entries.length - 1 && isGeneratedStructuralMarkerProperty(key, entry)) {
        out[key] = entry;
        break;
      }
      omitted += entries.length - index;
      break;
    }
    processed += 1;
    state.remainingEntries -= 1;
    if (Buffer.byteLength(key, "utf8") > MODEL_TOOL_OUTPUT_MAX_PROPERTY_KEY_BYTES) {
      omitted += 1;
      changed = true;
      continue;
    }
    if (typeof entry === "string" && STRUCTURAL_STRING_KEYS.has(key)) {
      const bounded = boundStructuralString(entry, state);
      out[key] = bounded;
      if (bounded !== entry) changed = true;
      continue;
    }
    const bounded = boundTextLeaves(
      entry,
      state,
      depth + 1,
      opaqueKindForChild(recordOpaqueKind, key),
    );
    out[key] = bounded;
    if (bounded !== entry) changed = true;
  }
  if (omitted > 0) {
    out[uniqueStructuralMarkerKey(out)] = structuredEntriesOmissionMarker(omitted, "object");
    changed = true;
  }
  state.seen.delete(value);
  return changed ? out : value;
}

function boundStructuralString(value: string, state: ModelOutputBoundState): string {
  if (isGeneratedModelOutputMarker(value)) {
    observeGeneratedMarkerBudget(value, state);
    return value;
  }
  if (state.remainingStructural === 0) return STRUCTURAL_STRING_OMISSION_MARKER;
  const cost = approximateTokenCount(value);
  const allowance = Math.min(
    MODEL_TOOL_OUTPUT_MAX_STRUCTURAL_STRING_TOKENS,
    state.remainingStructural,
  );
  if (cost <= allowance) {
    state.remainingStructural -= cost;
    return value;
  }
  state.remainingStructural -= allowance;
  return truncateMiddleWithTokenBudget(value, allowance);
}

function boundOpaqueProtocolString(
  value: string,
  state: ModelOutputBoundState,
  kind: OpaqueProtocolKind,
): string {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= state.remainingOpaqueBytes) {
    state.remainingOpaqueBytes -= bytes;
    return value;
  }
  state.remainingOpaqueBytes = 0;
  return `[OpenGeni omitted ${kind} payload: ${bytes} bytes exceeded the bounded model-input allowance]`;
}

function nonTextProtocolKind(value: unknown): OpaqueProtocolKind | null {
  if (value === "image" || value === "input_image") return "image";
  if (value === "file" || value === "input_file") return "file";
  if (value === "encrypted_content") return "encrypted";
  return null;
}

function opaqueKindForChild(
  kind: OpaqueProtocolKind | null,
  key: string,
): OpaqueProtocolKind | null {
  if (!kind) return null;
  const opaqueKeys =
    kind === "image"
      ? ["image", "image_url", "data", "url", "source"]
      : kind === "file"
        ? ["file", "file_data", "data", "url", "content", "source"]
        : ["encrypted_content", "content", "data"];
  return opaqueKeys.includes(key) ? kind : null;
}

function structuredEntriesOmissionMarker(count: number, container: "array" | "object"): string {
  return `[OpenGeni omitted ${count} structured ${container === "array" ? "array items" : "object properties"}]`;
}

function isGeneratedModelOutputMarker(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value === DEPTH_OMISSION_MARKER ||
      value === CYCLE_OMISSION_MARKER ||
      value === STRUCTURAL_STRING_OMISSION_MARKER ||
      TEXT_FIELD_OMISSION_MARKER.test(value) ||
      TEXT_ITEMS_OMISSION_MARKER.test(value) ||
      STRUCTURAL_ENTRIES_OMISSION_MARKER.test(value) ||
      OPAQUE_PAYLOAD_OMISSION_MARKER.test(value))
  );
}

function observeGeneratedMarkerBudget(value: string, state: ModelOutputBoundState): void {
  if (TEXT_FIELD_OMISSION_MARKER.test(value) || TEXT_ITEMS_OMISSION_MARKER.test(value)) {
    state.remaining = 0;
  }
  if (value === STRUCTURAL_STRING_OMISSION_MARKER) state.remainingStructural = 0;
  if (OPAQUE_PAYLOAD_OMISSION_MARKER.test(value)) state.remainingOpaqueBytes = 0;
}

function isGeneratedStructuralMarkerProperty(key: string, value: unknown): boolean {
  return (
    key.startsWith(STRUCTURAL_PROPERTIES_MARKER_KEY) &&
    typeof value === "string" &&
    STRUCTURAL_ENTRIES_OMISSION_MARKER.test(value)
  );
}

function uniqueStructuralMarkerKey(record: Record<string, unknown>): string {
  let key = STRUCTURAL_PROPERTIES_MARKER_KEY;
  let suffix = 1;
  while (Object.hasOwn(record, key)) {
    key = `${STRUCTURAL_PROPERTIES_MARKER_KEY}_${suffix}`;
    suffix += 1;
  }
  return key;
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
