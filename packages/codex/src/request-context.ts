// Per-request Codex context, carried via AsyncLocalStorage.
//
// The runtime caches one OpenAI client per provider id (process-wide), so the
// per-workspace token must NOT be baked into the client. Instead the worker sets
// this context around the model run, and codexSubscriptionFetch reads it at call
// time — one cached client, correct per-workspace token, no cross-tenant leak.

import { AsyncLocalStorage } from "node:async_hooks";

export type CodexTokenSnapshot = {
  accessToken: string;
  chatgptAccountId: string | null;
  isFedramp: boolean;
};

/**
 * Multi-account P4 (Part A): a full usage snapshot scraped FOR FREE from the
 * `x-codex-primary-*` / `x-codex-secondary-*` response headers the codex backend
 * stamps on every `/codex/responses` turn (success AND 429 hard-cap). Integer-
 * identical to GET /wham/usage but with zero extra round-trip. parseCodexUsageHeaders
 * returns this only when BOTH windows parse, so a write is always a full 5-column
 * snapshot (no partial-window clobber). Shape mirrors db's CodexAccountUsageSnapshot
 * (non-null here: a partial read is filtered to null upstream, never half-written).
 */
export type CodexUsageHeaderSnapshot = {
  primaryUsedPercent: number;
  primaryResetAt: Date;
  secondaryUsedPercent: number;
  secondaryResetAt: Date;
  checkedAt: Date;
};

export type CodexResponseTimeoutClass = "connect" | "headers" | "idle_stream" | "whole_request";

export type CodexResponseTimeoutPolicy = {
  /** Maximum wait for response headers, including DNS/TCP/TLS establishment. */
  headersTimeoutMs: number;
  /** Maximum silence between response-body chunks after headers arrive. */
  streamIdleTimeoutMs: number;
  /** Maximum wall time for one logical Responses request, including retries. */
  wholeRequestTimeoutMs: number;
  /** Safe retries allowed only before any response headers/body are observed. */
  noByteRetries: number;
  retryBackoffMs: number;
};

export type CodexModelRequestEvent = {
  requestId: string;
  transportAttempt: number;
  phase: "started" | "headers" | "first_byte" | "completed" | "failed" | "timed_out";
  model?: string;
  durationMs: number;
  responseObserved: boolean;
  timeoutPolicy: CodexResponseTimeoutPolicy;
  timeoutClass?: CodexResponseTimeoutClass;
  providerRequestId?: string;
  status?: number;
  willRetry?: boolean;
};

export type CodexRequestContext = {
  clientVersion: string;
  /**
   * Stable per-session affinity id, sent as the `session_id` header on every
   * request. This is the backend's STICKY CACHE-ROUTING key — measured
   * 2026-07-12 with byte-identical ~99k-token gpt-5.6-sol requests on one idle
   * account: without the header, repeat requests hit the prompt cache ~50% of
   * the time (a per-request routing lottery across cache shards; matches the
   * prod fleet's 48.6%); with a stable session_id, 10/10 requests hit at the
   * 99.0% ceiling — Codex CLI parity (the CLI always sends it; its own last-3d
   * token-weighted rate here is 94%). `prompt_cache_key` in the body only
   * influences routing and does NOT pin it. Use the SAME value as
   * prompt_cache_key (the OpenGeni sessionId) so routing and cache key agree.
   */
  sessionId?: string;
  /** Worker-supplied: proactive refresh + single-flight + db persist. */
  getToken: () => Promise<CodexTokenSnapshot>;
  /** Forced refresh used for the 401 retry. */
  refresh: () => Promise<CodexTokenSnapshot>;
  /** Model-slug resolver (longest-prefix against the live catalog). */
  resolveModel: (slug: string) => string;
  /**
   * Multi-account P4 (Part A): fire-and-forget usage-header sink. Called by
   * codexSubscriptionFetch on EVERY response (sync, non-throwing, never awaited)
   * with the parsed full-window snapshot. The worker records the latest into the
   * P2 usage cache once per turn in its `finally` — packages/codex stays db-free.
   */
  onUsageHeaders?: (snapshot: CodexUsageHeaderSnapshot) => void;
  /** Optional per-run override, primarily for deterministic transport tests. */
  responseTimeoutPolicy?: Partial<CodexResponseTimeoutPolicy>;
  /** Worker-owned durable audit sink; payloads never contain request bodies or auth. */
  onModelRequestEvent?: (event: CodexModelRequestEvent) => Promise<void> | void;
  /** Stable request identity supplied by the owning durable execution. */
  nextRequestId?: () => string;
};

export const codexRequestStorage = new AsyncLocalStorage<CodexRequestContext>();
