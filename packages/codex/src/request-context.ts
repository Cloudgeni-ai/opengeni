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

export type CodexRequestContext = {
  clientVersion: string;
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
};

export const codexRequestStorage = new AsyncLocalStorage<CodexRequestContext>();
