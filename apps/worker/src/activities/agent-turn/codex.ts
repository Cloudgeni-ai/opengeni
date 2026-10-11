import { type ModelProviderApi, type ResolvedModelProvider } from "@opengeni/config";

import { createHash } from "node:crypto";

export function codexWorkspaceMetricKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
}

/** Stable public request identity across partial resumes and activity retries. */
export function acceptsPromptCacheKeyForTurn(
  resolvedModel: {
    provider: { kind: ResolvedModelProvider["kind"]; builtin?: boolean; api?: ModelProviderApi };
  } | null,
): boolean {
  if (!resolvedModel) {
    return true;
  }
  return (
    resolvedModel.provider.builtin === true ||
    resolvedModel.provider.kind === "codex-subscription" ||
    // Native Claude consumes this internal key as session identity; it never
    // sends OpenAI's prompt_cache_key field to the Messages endpoint.
    resolvedModel.provider.api === "anthropic-messages"
  );
}

/**
 * True once the lifetime last confirmed by Postgres is no longer trustworthy.
 * A missing or malformed deadline fails closed for a holder that claims to be
 * leased; callers check this before accepting an in-flight heartbeat promise.
 */
export function codexCredentialLeaseDeadlineExpired(
  confirmedUntilMs: number | null,
  nowMs: number = performance.now(),
): boolean {
  return (
    confirmedUntilMs === null || !Number.isFinite(confirmedUntilMs) || confirmedUntilMs <= nowMs
  );
}
