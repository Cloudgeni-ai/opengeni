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
 * The prompt-cache routing key for one turn, or undefined when this transport
 * must not receive one (see acceptsPromptCacheKeyForTurn).
 *
 * OpenAI routes a request to a cache machine by its leading prompt prefix plus
 * `prompt_cache_key`; the Codex backend pins routing on the `session_id`
 * header, which carries the same value. A per-conversation key keeps in-chat
 * hits high but sends a new chat's first request to a machine that has never
 * seen the workspace's shared prefix (system prompt, tools, instructions).
 *
 * With `groups > 0`, every conversation in a workspace uses one of `groups`
 * stable keys chosen from its ROOT conversation id, so:
 * - a new chat's first request reuses the prefix other chats in its group
 *   already cached;
 * - each conversation keeps the same key for its whole life (in-chat hits are
 *   unchanged), and child sessions share their root's key, which is how Codex
 *   scopes internal helper sessions to their parent thread;
 * - load spreads over `groups` keys instead of concentrating on one.
 *
 * Native Claude consumes the key as session identity, so it always gets the
 * conversation id.
 */
export function promptCacheKeyForTurn(params: {
  resolvedModel: Parameters<typeof acceptsPromptCacheKeyForTurn>[0];
  workspaceId: string;
  sessionId: string;
  rootSessionId: string | null | undefined;
  groups: number;
}): string | undefined {
  const { resolvedModel, groups } = params;
  if (!acceptsPromptCacheKeyForTurn(resolvedModel)) return undefined;
  if (resolvedModel?.provider.api === "anthropic-messages") return params.sessionId;
  if (!Number.isInteger(groups) || groups <= 0) return params.sessionId;
  const root = params.rootSessionId || params.sessionId;
  const group =
    Number.parseInt(createHash("sha256").update(root).digest("hex").slice(0, 8), 16) % groups;
  const scope = createHash("sha256").update(params.workspaceId).digest("hex").slice(0, 16);
  return `og-pc-${scope}-${groups}-${group}`;
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
