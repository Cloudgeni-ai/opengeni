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
/** Codex CLI remote compaction v2 retained-message budget (codex-rs). */
export const REMOTE_V2_RETAINED_MESSAGE_TOKEN_BUDGET = 64_000;
export const REMOTE_COMPACTION_V2_IMPLEMENTATION = "responses_compaction_v2" as const;
export const REMOTE_COMPACTION_V2_BETA_FEATURE = "remote_compaction_v2" as const;
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

const IMAGE_LOW_DETAIL_TOKENS = 85;
const IMAGE_HIGH_DETAIL_BASE_TOKENS = 85;
const IMAGE_HIGH_DETAIL_TILE_TOKENS = 170;
const IMAGE_HIGH_DETAIL_TILE_SIZE = 512;
const IMAGE_HIGH_DETAIL_MAX_SIDE = 2_048;
const IMAGE_HIGH_DETAIL_TARGET_SHORT_SIDE = 768;
export const UNKNOWN_IMAGE_TOKENS = 4_096;
export const MAX_NATIVE_IMAGE_TOKENS = 8_192;

export type NativeImageEstimateReason = "dimensions" | "bounded_fallback";
export type NativeImageTokenEstimate = {
  tokens: number;
  width: number | null;
  height: number | null;
  detail: string;
  reason: NativeImageEstimateReason;
};

export type ModelInputTokenBreakdown = {
  totalTokens: number;
  textTokens: number;
  imageTokens: number;
  imageCount: number;
  imageFallbackCount: number;
};

type ImageDescriptor = {
  source: unknown;
  detail: string;
  width: number | null;
  height: number | null;
};

type NativeImageProjection = {
  value: unknown;
  imageTokens: number;
  imageCount: number;
  imageFallbackCount: number;
};

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function dimensionsFromRecord(record: Record<string, unknown>): [number, number] | null {
  const width = finitePositiveInteger(record.width);
  const height = finitePositiveInteger(record.height);
  if (width && height) return [width, height];
  if (Array.isArray(record.dimensions) && record.dimensions.length >= 2) {
    const dimensionsWidth = finitePositiveInteger(record.dimensions[0]);
    const dimensionsHeight = finitePositiveInteger(record.dimensions[1]);
    if (dimensionsWidth && dimensionsHeight) return [dimensionsWidth, dimensionsHeight];
  }
  return null;
}

function dataUrlBytesPrefix(value: string, maxBytes = 262_144): Uint8Array | null {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match) return null;
  try {
    const maxBase64CodeUnits = Math.ceil(maxBytes / 3) * 4;
    return new Uint8Array(Buffer.from(match[1]!.slice(0, maxBase64CodeUnits), "base64"));
  } catch {
    return null;
  }
}

function base64BytesPrefix(value: string, maxBytes = 262_144): Uint8Array | null {
  if (!/^[a-z0-9+/=\r\n]+$/i.test(value)) return null;
  try {
    const maxBase64CodeUnits = Math.ceil(maxBytes / 3) * 4;
    return new Uint8Array(Buffer.from(value.slice(0, maxBase64CodeUnits), "base64"));
  } catch {
    return null;
  }
}

function uint16BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint32BigEndian(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff_ffff;
  for (let offset = start; offset < end; offset += 1) {
    crc ^= bytes[offset] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function dimensionsFromImageBytes(bytes: Uint8Array): [number, number] | null {
  // PNG IHDR: trust geometry only from a complete first IHDR chunk whose CRC32
  // authenticates the 4-byte chunk type plus 13-byte data. This inspects exactly
  // the bounded 33-byte prefix and never decodes the rest of the image.
  if (
    bytes.length >= 33 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a &&
    uint32BigEndian(bytes, 8) === 13 &&
    bytes[12] === 0x49 &&
    bytes[13] === 0x48 &&
    bytes[14] === 0x44 &&
    bytes[15] === 0x52 &&
    crc32(bytes, 12, 29) === uint32BigEndian(bytes, 29)
  ) {
    const width = uint32BigEndian(bytes, 16);
    const height = uint32BigEndian(bytes, 20);
    return width > 0 && height > 0 ? [width, height] : null;
  }
  // GIF logical screen descriptor.
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    const width = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
    const height = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
    return width > 0 && height > 0 ? [width, height] : null;
  }
  // WebP VP8X canvas size (24-bit little-endian, stored minus one).
  if (
    bytes.length >= 30 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50 &&
    bytes[12] === 0x56 &&
    bytes[13] === 0x50 &&
    bytes[14] === 0x38 &&
    bytes[15] === 0x58
  ) {
    const width = 1 + (bytes[24] ?? 0) + ((bytes[25] ?? 0) << 8) + ((bytes[26] ?? 0) << 16);
    const height = 1 + (bytes[27] ?? 0) + ((bytes[28] ?? 0) << 8) + ((bytes[29] ?? 0) << 16);
    return width > 0 && height > 0 ? [width, height] : null;
  }
  // JPEG SOF markers can appear after variable-length metadata segments.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
      if (marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = uint16BigEndian(bytes, offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame && segmentLength >= 7) {
        const height = uint16BigEndian(bytes, offset + 3);
        const width = uint16BigEndian(bytes, offset + 5);
        return width > 0 && height > 0 ? [width, height] : null;
      }
      offset += segmentLength;
    }
  }
  return null;
}

function dimensionsFromImageSource(source: unknown): [number, number] | null {
  if (source instanceof Uint8Array) {
    return dimensionsFromImageBytes(source);
  }
  if (typeof source === "string") {
    const bytes = dataUrlBytesPrefix(source);
    return bytes ? dimensionsFromImageBytes(bytes) : null;
  }
  if (!source || typeof source !== "object") return null;
  const record = source as Record<string, unknown>;
  const rawData = record.data;
  const mediaType = record.mediaType ?? record.media_type;
  const rawDataDimensions =
    rawData instanceof Uint8Array
      ? dimensionsFromImageBytes(rawData)
      : typeof rawData === "string" &&
          typeof mediaType === "string" &&
          mediaType.toLowerCase().startsWith("image/")
        ? dimensionsFromImageBytes(base64BytesPrefix(rawData) ?? new Uint8Array())
        : null;
  return (
    dimensionsFromRecord(record) ??
    rawDataDimensions ??
    dimensionsFromImageSource(record.url) ??
    dimensionsFromImageSource(rawData)
  );
}

function highDetailImageTokens(width: number, height: number): number {
  let scaledWidth = width;
  let scaledHeight = height;
  const longest = Math.max(scaledWidth, scaledHeight);
  if (longest > IMAGE_HIGH_DETAIL_MAX_SIDE) {
    const scale = IMAGE_HIGH_DETAIL_MAX_SIDE / longest;
    scaledWidth *= scale;
    scaledHeight *= scale;
  }
  const shortest = Math.min(scaledWidth, scaledHeight);
  if (shortest > IMAGE_HIGH_DETAIL_TARGET_SHORT_SIDE) {
    const scale = IMAGE_HIGH_DETAIL_TARGET_SHORT_SIDE / shortest;
    scaledWidth *= scale;
    scaledHeight *= scale;
  }
  const tiles =
    Math.ceil(scaledWidth / IMAGE_HIGH_DETAIL_TILE_SIZE) *
    Math.ceil(scaledHeight / IMAGE_HIGH_DETAIL_TILE_SIZE);
  return Math.min(
    MAX_NATIVE_IMAGE_TOKENS,
    IMAGE_HIGH_DETAIL_BASE_TOKENS + IMAGE_HIGH_DETAIL_TILE_TOKENS * Math.max(1, tiles),
  );
}

/**
 * Provider-neutral local estimate for one native image. Inline bytes are used
 * only to recover dimensions; their base64 length never becomes text tokens.
 */
export function estimateNativeImageTokens(input: {
  source?: unknown;
  width?: number | null;
  height?: number | null;
  detail?: unknown;
}): NativeImageTokenEstimate {
  const explicitWidth = finitePositiveInteger(input.width);
  const explicitHeight = finitePositiveInteger(input.height);
  const sourceDimensions = dimensionsFromImageSource(input.source);
  const width = explicitWidth ?? sourceDimensions?.[0] ?? null;
  const height = explicitHeight ?? sourceDimensions?.[1] ?? null;
  const detail =
    typeof input.detail === "string" && input.detail.length > 0 ? input.detail : "auto";
  if (detail === "low") {
    return { tokens: IMAGE_LOW_DETAIL_TOKENS, width, height, detail, reason: "dimensions" };
  }
  if (!width || !height) {
    return {
      tokens: UNKNOWN_IMAGE_TOKENS,
      width: null,
      height: null,
      detail,
      reason: "bounded_fallback",
    };
  }
  return {
    tokens: highDetailImageTokens(width, height),
    width,
    height,
    detail,
    reason: "dimensions",
  };
}

function imageDescriptor(record: Record<string, unknown>): ImageDescriptor | null {
  const type = typeof record.type === "string" ? record.type : "";
  if (!new Set(["input_image", "image_url", "image", "computer_screenshot"]).has(type)) {
    return null;
  }
  const imageUrl = record.image_url;
  const nestedImageUrl =
    imageUrl && typeof imageUrl === "object" ? (imageUrl as Record<string, unknown>).url : imageUrl;
  const source =
    record.image ??
    record.imageUrl ??
    nestedImageUrl ??
    record.data ??
    record.url ??
    record.fileId ??
    record.file_id ??
    record.artifact ??
    record.artifactReference;
  const nestedDetail =
    imageUrl && typeof imageUrl === "object"
      ? (imageUrl as Record<string, unknown>).detail
      : undefined;
  const dimensions =
    dimensionsFromRecord(record) ??
    (source && typeof source === "object"
      ? dimensionsFromRecord(source as Record<string, unknown>)
      : null);
  return {
    source,
    detail:
      typeof record.detail === "string"
        ? record.detail
        : typeof nestedDetail === "string"
          ? nestedDetail
          : "auto",
    width: dimensions?.[0] ?? null,
    height: dimensions?.[1] ?? null,
  };
}

function projectNativeImages(value: unknown, seen: WeakSet<object>): NativeImageProjection {
  if (!value || typeof value !== "object") {
    return { value, imageTokens: 0, imageCount: 0, imageFallbackCount: 0 };
  }
  if (seen.has(value)) {
    return { value: "[circular]", imageTokens: 0, imageCount: 0, imageFallbackCount: 0 };
  }
  seen.add(value);
  if (Array.isArray(value)) {
    let imageTokens = 0;
    let imageCount = 0;
    let imageFallbackCount = 0;
    const projected = value.map((entry) => {
      const result = projectNativeImages(entry, seen);
      imageTokens += result.imageTokens;
      imageCount += result.imageCount;
      imageFallbackCount += result.imageFallbackCount;
      return result.value;
    });
    seen.delete(value);
    return { value: projected, imageTokens, imageCount, imageFallbackCount };
  }

  const record = value as Record<string, unknown>;
  const descriptor = imageDescriptor(record);
  if (descriptor) {
    const estimate = estimateNativeImageTokens(descriptor);
    const projected: Record<string, unknown> = {};
    const payloadKeys = new Set([
      "image",
      "image_url",
      "imageUrl",
      "data",
      "url",
      "fileId",
      "file_id",
      "artifact",
      "artifactReference",
    ]);
    for (const [key, entry] of Object.entries(record)) {
      projected[key] = payloadKeys.has(key) ? "[native image]" : entry;
    }
    projected.image_estimate = {
      width: estimate.width,
      height: estimate.height,
      detail: estimate.detail,
      reason: estimate.reason,
    };
    seen.delete(value);
    return {
      value: projected,
      imageTokens: estimate.tokens,
      imageCount: 1,
      imageFallbackCount: estimate.reason === "bounded_fallback" ? 1 : 0,
    };
  }

  let imageTokens = 0;
  let imageCount = 0;
  let imageFallbackCount = 0;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const result = projectNativeImages(entry, seen);
    projected[key] = result.value;
    imageTokens += result.imageTokens;
    imageCount += result.imageCount;
    imageFallbackCount += result.imageFallbackCount;
  }
  seen.delete(value);
  return { value: projected, imageTokens, imageCount, imageFallbackCount };
}

/**
 * Codex CLI `estimate_reasoning_length`: opaque encrypted payloads are not
 * model-visible as raw JSON/base64. Visible bytes ≈ `len * 3/4 - 650`.
 */
export function estimateOpaqueEncryptedModelVisibleBytes(encodedLen: number): number {
  const length = Math.max(0, Math.floor(encodedLen));
  return Math.max(0, Math.floor((length * 3) / 4) - 650);
}

/** Codex CLI bytes→tokens for opaque encrypted content (`ceil(bytes / 4)`). */
export function estimateOpaqueEncryptedTokens(encodedLen: number): number {
  const bytes = estimateOpaqueEncryptedModelVisibleBytes(encodedLen);
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

/**
 * Length of opaque encrypted content that must use the Codex encrypted
 * estimator instead of JSON.stringify (compaction blobs and reasoning).
 */
export function opaqueEncryptedContentLength(item: unknown): number | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  if (
    (type === "compaction" || type === "context_compaction" || type === "reasoning") &&
    typeof record.encrypted_content === "string" &&
    record.encrypted_content.length > 0
  ) {
    return record.encrypted_content.length;
  }
  if (type === "reasoning") {
    const providerData =
      record.providerData && typeof record.providerData === "object"
        ? (record.providerData as Record<string, unknown>)
        : null;
    const nested =
      providerData && typeof providerData.encrypted_content === "string"
        ? providerData.encrypted_content
        : providerData && typeof providerData.encryptedContent === "string"
          ? providerData.encryptedContent
          : null;
    if (nested && nested.length > 0) return nested.length;
  }
  return null;
}

/** Native-image-aware item estimate for pre-call accounting and retained budgets. */
export function estimateItemTokenBreakdown(item: CompactionItem): ModelInputTokenBreakdown {
  const opaqueLen = opaqueEncryptedContentLength(item);
  if (opaqueLen !== null) {
    // Match Codex: Compaction / encrypted reasoning use the opaque byte
    // heuristic only — never JSON-stringify the ciphertext into the budget.
    const textTokens = estimateOpaqueEncryptedTokens(opaqueLen);
    return {
      totalTokens: textTokens,
      textTokens,
      imageTokens: 0,
      imageCount: 0,
      imageFallbackCount: 0,
    };
  }
  const projected = projectNativeImages(item, new WeakSet<object>());
  let text: string;
  try {
    text = JSON.stringify(projected.value);
  } catch {
    text = String(projected.value);
  }
  const textTokens = estimateTextTokens(text);
  return {
    totalTokens: textTokens + projected.imageTokens,
    textTokens,
    imageTokens: projected.imageTokens,
    imageCount: projected.imageCount,
    imageFallbackCount: projected.imageFallbackCount,
  };
}

export function estimateItemTokens(item: CompactionItem): number {
  return estimateItemTokenBreakdown(item).totalTokens;
}

export function estimateTokens(items: readonly CompactionItem[]): number {
  let total = 0;
  for (const item of items) {
    total += estimateItemTokens(item);
  }
  return total;
}

export function estimateTokensBreakdown(
  items: readonly CompactionItem[],
): ModelInputTokenBreakdown {
  const total: ModelInputTokenBreakdown = {
    totalTokens: 0,
    textTokens: 0,
    imageTokens: 0,
    imageCount: 0,
    imageFallbackCount: 0,
  };
  for (const item of items) {
    const estimate = estimateItemTokenBreakdown(item);
    total.totalTokens += estimate.totalTokens;
    total.textTokens += estimate.textTokens;
    total.imageTokens += estimate.imageTokens;
    total.imageCount += estimate.imageCount;
    total.imageFallbackCount += estimate.imageFallbackCount;
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
  inputTextTokens: number;
  inputImageTokens: number;
  inputImageCount: number;
  inputImageFallbackCount: number;
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
  const inputEstimate = estimateTokensBreakdown(input.current.input);
  const inputTokens = inputEstimate.totalTokens;
  const instructionsTokens = input.current.instructionsTokens;
  const toolSchemaTokens = input.current.toolSchemaTokens;
  if (!input.provider || !input.providerRequestFootprint || input.provider.totalTokens <= 0) {
    return {
      tokens: inputTokens + instructionsTokens + toolSchemaTokens,
      source: "complete_estimate",
      inputTokens,
      inputTextTokens: inputEstimate.textTokens,
      inputImageTokens: inputEstimate.imageTokens,
      inputImageCount: inputEstimate.imageCount,
      inputImageFallbackCount: inputEstimate.imageFallbackCount,
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
    inputTextTokens: inputEstimate.textTokens,
    inputImageTokens: inputEstimate.imageTokens,
    inputImageCount: inputEstimate.imageCount,
    inputImageFallbackCount: inputEstimate.imageFallbackCount,
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

/** True for a Codex remote-compaction output item with opaque encrypted content. */
export function isRemoteCompactionItem(item: unknown): item is CompactionItem {
  if (!item || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  return (
    record.type === "compaction" &&
    typeof record.encrypted_content === "string" &&
    record.encrypted_content.length > 0
  );
}

/** Messages retained beside a remote v2 compaction blob (user + developer). */
export function isRetainedRemoteV2Message(item: unknown): boolean {
  if (isCompactionSummary(item) || itemType(item) === "compaction") return false;
  const role = itemRole(item);
  return itemType(item) === "message" && (role === "user" || role === "developer");
}

/**
 * Build the active history after Codex remote compaction v2:
 * newest retained user/developer messages within the CLI 64k budget plus the
 * opaque `{ type: "compaction", encrypted_content }` item.
 */
export function buildRemoteV2ReplacementHistory(
  items: readonly CompactionItem[],
  compactionItem: CompactionItem,
): CompactionItem[] {
  if (!isRemoteCompactionItem(compactionItem)) {
    throw new EmptyCompactionSummaryError({ stage: "remote_v2_compaction_item" });
  }
  const retainedReversed: CompactionItem[] = [];
  let remaining = REMOTE_V2_RETAINED_MESSAGE_TOKEN_BUDGET;
  for (let index = items.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = items[index]!;
    if (!isRetainedRemoteV2Message(item)) continue;
    const textTokens = estimateTextTokens(messageText(item));
    retainedReversed.push(compactMessageToTokenBudget(item, remaining));
    if (textTokens > remaining) {
      remaining = 0;
      break;
    }
    remaining -= textTokens;
  }
  const history = retainedReversed.reverse();
  history.push({
    type: "compaction",
    encrypted_content: compactionItem.encrypted_content,
    ...(typeof compactionItem.summary === "string" ? { summary: compactionItem.summary } : {}),
  });
  return history;
}

/**
 * Append the transient compaction_trigger used only for the remote v2 request.
 *
 * The OpenAI Agents SDK's Responses converter rejects a bare
 * `{ type: "compaction_trigger" }` (`UserError: Unsupported item`). It does
 * accept `type: "unknown"` and forwards `providerData` onto the wire, which is
 * how we deliver the Codex-only trigger through CompactionResponsesModel into
 * the Codex fetch normalizer (which allowlists top-level `compaction_trigger`).
 */
export function buildRemoteCompactionV2PromptInput(
  items: readonly CompactionItem[],
): CompactionItem[] {
  return [
    ...items,
    {
      type: "unknown",
      providerData: { type: "compaction_trigger" },
    },
  ];
}

/** Extract exactly one compaction output item from a Responses payload. */
export function extractRemoteCompactionV2OutputItem(response: unknown): CompactionItem {
  if (!response || typeof response !== "object") {
    throw new EmptyCompactionSummaryError({ stage: "remote_v2_extract", reason: "no_response" });
  }
  const record = response as Record<string, unknown>;
  const output = Array.isArray(record.output) ? record.output : [];
  const compactionItems = output.filter(isRemoteCompactionItem);
  if (compactionItems.length !== 1) {
    throw new EmptyCompactionSummaryError({
      stage: "remote_v2_extract",
      reason: "expected_exactly_one_compaction",
      found: compactionItems.length,
    });
  }
  return compactionItems[0]!;
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
