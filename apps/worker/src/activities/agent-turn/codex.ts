import { type ModelProviderApi, type ResolvedModelProvider } from "@opengeni/config";

import { createHash } from "node:crypto";

export function codexWorkspaceMetricKey(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 12);
}

/**
 * Stable across sessions, retries and workers, without hashing mutable prompts.
 *
 * `scopeSubjectId` must be frozen for the whole session (the session's scope
 * subject), never the subject that started one turn: the key routes requests
 * to a cache, so a key that changed with the turn initiator (a person, an
 * agent, a schedule) lost the cached history on the next request.
 */
export function codexCacheAffinityKey(
  workspaceId: string,
  scopeSubjectId: string | null,
  sessionId: string,
): string {
  // Do not combine unrelated service-only or legacy sessions into one cohort.
  if (!scopeSubjectId) return sessionId;
  return createHash("sha256")
    .update(JSON.stringify(["opengeni-codex-affinity-v1", workspaceId, scopeSubjectId]))
    .digest("hex");
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
