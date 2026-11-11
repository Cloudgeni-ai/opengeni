/**
 * Per-call prompt-cache diagnostics.
 *
 * A provider reads its prompt cache only for the longest byte-identical
 * request prefix it has seen recently. When a call reads much less than the
 * previous call in the same session, these diagnostics say which part of the
 * request changed (tools, system prompt or history), whether the provider
 * dropped signed thinking blocks, or whether time or the serving account
 * explain it. The worker records the observation; the usage fact stores it
 * with the warm-miss classification so production can alert per class.
 *
 * Fingerprints are truncated SHA-256 digests of the wire request. They never
 * contain request text.
 */

/** Hex digest prefix length kept for each fingerprint component. */
export const PROMPT_CACHE_DIGEST_HEX_LENGTH = 16;
const DIGEST = /^[0-9a-f]{16}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_CHECKPOINTS = 48;
const MAX_DROP_REASONS = 8;

/**
 * Fingerprint of one provider request, as sent on the wire. `history` holds
 * chained digests of the first `n` history items at n = 1, 2, 4, 8, ... and at
 * the full item count, so two requests can be compared at every shared
 * checkpoint without storing per-item digests.
 */
export type PromptCacheRequestFingerprint = {
  v: 1;
  /** Tool definitions, cache markers removed. */
  tools: string;
  /** System prompt, excluding per-request billing metadata and cache markers. */
  system: string;
  /** Number of history units: message content blocks, or Responses input items. */
  items: number;
  history: Array<[number, string]>;
};

/** What the worker observed about one model call. */
export type PromptCacheObservation = {
  /** Signed thinking blocks the provider dropped before inference, by reason. */
  thinkingBlocksDropped?: Record<string, number>;
  request?: PromptCacheRequestFingerprint;
};

export const PROMPT_CACHE_WARM_MISS_CLASSES = [
  /** The history was replaced (compaction or truncation); a miss is expected. */
  "context_replaced",
  "tools_changed",
  "system_changed",
  /** An item the previous request already sent changed. */
  "history_rewritten",
  /** The prefix was identical but the provider dropped signed thinking. */
  "thinking_dropped",
  "account_changed",
  /** Long enough since the previous call that the cache may have expired. */
  "idle_gap",
  /** Nothing observed explains the miss (provider eviction or routing). */
  "unexplained",
] as const;
export type PromptCacheWarmMissClass = (typeof PROMPT_CACHE_WARM_MISS_CLASSES)[number];

export type PromptCacheWarmMiss = {
  class: PromptCacheWarmMissClass;
  /** Tokens a warm cache should have served: the shorter of the two prompts. */
  expectedCachedTokens: number;
  previousSourceKey: string;
  gapMs: number;
  /** For history_rewritten: the first checkpoint whose items differ. */
  divergedWithinItems?: number;
};

export type PromptCacheDiagnostics = PromptCacheObservation & {
  warmMiss?: PromptCacheWarmMiss;
};

/** One recorded call, as the classifier needs it. */
export type PromptCacheCallSample = {
  sourceKey: string;
  /** Whole prompt including cached tokens. */
  inputTokens: number | null;
  cachedTokens: number | null;
  connectionId: string | null;
  occurredAt: Date;
  observation: PromptCacheObservation | null;
};

/** Calls further apart than this may have lost the cache to its TTL. */
export const PROMPT_CACHE_IDLE_GAP_MS = 5 * 60_000;
/** A prompt this much smaller than the previous one had its history replaced. */
const CONTEXT_REPLACED_RATIO = 0.6;

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseFingerprint(value: unknown): PromptCacheRequestFingerprint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return null;
  if (typeof record.tools !== "string" || !DIGEST.test(record.tools)) return null;
  if (typeof record.system !== "string" || !DIGEST.test(record.system)) return null;
  if (!nonNegativeInteger(record.items)) return null;
  if (!Array.isArray(record.history) || record.history.length > MAX_CHECKPOINTS) return null;
  const history: Array<[number, string]> = [];
  let previous = 0;
  for (const entry of record.history) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [count, digest] = entry as [unknown, unknown];
    if (!nonNegativeInteger(count) || count <= previous || count > record.items) return null;
    if (typeof digest !== "string" || !DIGEST.test(digest)) return null;
    history.push([count, digest]);
    previous = count;
  }
  return { v: 1, tools: record.tools, system: record.system, items: record.items, history };
}

function parseDropCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > MAX_DROP_REASONS) return null;
  const counts: Record<string, number> = {};
  for (const [reason, count] of entries) {
    if (!REASON.test(reason) || !nonNegativeInteger(count) || count === 0) return null;
    counts[reason] = count;
  }
  return counts;
}

/** Validate an observation from an untrusted boundary; invalid parts are dropped. */
export function parsePromptCacheObservation(value: unknown): PromptCacheObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const request = record.request === undefined ? null : parseFingerprint(record.request);
  const dropped =
    record.thinkingBlocksDropped === undefined
      ? null
      : parseDropCounts(record.thinkingBlocksDropped);
  if (!request && !dropped) return null;
  return {
    ...(dropped ? { thinkingBlocksDropped: dropped } : {}),
    ...(request ? { request } : {}),
  };
}

/** Total signed thinking blocks the provider dropped for this call. */
export function promptCacheThinkingBlocksDropped(observation: PromptCacheObservation | null) {
  return Object.values(observation?.thinkingBlocksDropped ?? {}).reduce((a, b) => a + b, 0);
}

/**
 * The first history checkpoint, up to the shorter request, whose digests
 * differ; null when every shared checkpoint matches.
 */
export function firstDivergentHistoryCheckpoint(
  previous: PromptCacheRequestFingerprint,
  current: PromptCacheRequestFingerprint,
): number | null {
  const shared = Math.min(previous.items, current.items);
  const currentDigests = new Map(current.history);
  for (const [count, digest] of previous.history) {
    if (count > shared) break;
    const other = currentDigests.get(count);
    if (other !== undefined && other !== digest) return count;
  }
  return null;
}

/**
 * Classify a call that read much less prompt cache than the previous call of
 * the same model in the same session made warm. Returns null when there is no
 * baseline or the call read what a warm cache should serve.
 *
 * Causes the request itself proves (tools, system, history) win over effects
 * (dropped thinking) and circumstances (account, time).
 */
export function classifyPromptCacheWarmMiss(
  previous: PromptCacheCallSample | null,
  current: PromptCacheCallSample,
): PromptCacheWarmMiss | null {
  if (!previous || previous.inputTokens === null || current.inputTokens === null) return null;
  const expected = Math.min(previous.inputTokens, current.inputTokens);
  const tolerance = Math.max(2048, Math.ceil(expected * 0.05));
  if ((current.cachedTokens ?? 0) + tolerance >= expected) return null;
  const base = {
    expectedCachedTokens: expected,
    previousSourceKey: previous.sourceKey,
    gapMs: Math.max(0, current.occurredAt.getTime() - previous.occurredAt.getTime()),
  };
  if (current.inputTokens < previous.inputTokens * CONTEXT_REPLACED_RATIO)
    return { class: "context_replaced", ...base };
  const before = previous.observation?.request;
  const after = current.observation?.request;
  if (before && after) {
    if (before.tools !== after.tools) return { class: "tools_changed", ...base };
    if (before.system !== after.system) return { class: "system_changed", ...base };
    const diverged = firstDivergentHistoryCheckpoint(before, after);
    if (diverged !== null)
      return { class: "history_rewritten", ...base, divergedWithinItems: diverged };
  }
  if (promptCacheThinkingBlocksDropped(current.observation) > 0)
    return { class: "thinking_dropped", ...base };
  if (
    previous.connectionId !== null &&
    current.connectionId !== null &&
    previous.connectionId !== current.connectionId
  )
    return { class: "account_changed", ...base };
  if (base.gapMs > PROMPT_CACHE_IDLE_GAP_MS) return { class: "idle_gap", ...base };
  return { class: "unexplained", ...base };
}
