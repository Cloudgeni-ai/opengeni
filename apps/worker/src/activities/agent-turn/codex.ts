import { type ModelProviderApi, type ResolvedModelProvider } from "@opengeni/config";

import { createHash } from "node:crypto";

export function codexWorkspaceMetricKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
}

/**
 * The prompt-cache cohort: one stable key per Opengeni account (organization).
 * It is the provider routing hint (the Codex `session_id` header) and the
 * OpenAI/Azure `prompt_cache_key`, so a new session, workspace, person or
 * service job reaches the cache that already holds the account's shared prefix
 * (tool schemas and system instructions). Provider caches still match bytes
 * exactly; this changes where a request is looked up, never what the model
 * reads. Stable across sessions, retries and workers, and it never hashes a
 * prompt.
 */
export function promptCacheCohortKey(accountId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["opengeni-prompt-cache-cohort-v2", accountId]))
    .digest("hex");
}

/**
 * The internal prompt-cache key for one turn, or undefined where the transport
 * must not receive OpenAI's `prompt_cache_key` field. Native Claude maps it to
 * its session identity, so it stays the session id there. Every OpenAI-wire
 * transport gets the account cohort: on current OpenAI models a distinct key
 * keeps a separate cache, so a per-session key made every new session's first
 * request recompute the shared prefix.
 */
export function promptCacheKeyForTurn(
  resolvedModel: Parameters<typeof acceptsPromptCacheKeyForTurn>[0],
  ids: { accountId: string; sessionId: string },
): string | undefined {
  if (!acceptsPromptCacheKeyForTurn(resolvedModel)) return undefined;
  if (resolvedModel?.provider.api === "anthropic-messages") return ids.sessionId;
  return promptCacheCohortKey(ids.accountId);
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
