/**
 * Claude subscription model ids (docs/design/subscription-model-ids-without-pools.md).
 *
 * One Claude subscription model has one canonical id, `claude/<upstream>`,
 * served by provider `claude-subscription`. Two older forms name the same
 * model and stay accepted forever: `workspace-claude-subscription/<upstream>`
 * and `organization-claude-subscription/<upstream>`. Their prefix once named
 * an inference pool; it no longer decides which accounts serve or which
 * models exist. Every comparison of Claude subscription model or provider
 * ids goes through these helpers, so the three forms are one model.
 *
 * Pure and dependency-free so the API, worker, SDK, React package and web
 * app share it.
 */

export const CLAUDE_SUBSCRIPTION_PROVIDER_ID = "claude-subscription" as const;
export const CLAUDE_SUBSCRIPTION_MODEL_ID_PREFIX = "claude/" as const;
export const LEGACY_WORKSPACE_CLAUDE_SUBSCRIPTION_PROVIDER_ID =
  "workspace-claude-subscription" as const;
export const LEGACY_ORGANIZATION_CLAUDE_SUBSCRIPTION_PROVIDER_ID =
  "organization-claude-subscription" as const;

/** Every provider id a Claude subscription model has been served under. */
export const CLAUDE_SUBSCRIPTION_PROVIDER_IDS = [
  CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  LEGACY_WORKSPACE_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
  LEGACY_ORGANIZATION_CLAUDE_SUBSCRIPTION_PROVIDER_ID,
] as const;

const PREFIXES = [
  CLAUDE_SUBSCRIPTION_MODEL_ID_PREFIX,
  `${LEGACY_WORKSPACE_CLAUDE_SUBSCRIPTION_PROVIDER_ID}/`,
  `${LEGACY_ORGANIZATION_CLAUDE_SUBSCRIPTION_PROVIDER_ID}/`,
] as const;

/** Whether a provider id is one of the Claude subscription provider ids. */
export function isClaudeSubscriptionProviderId(providerId: string): boolean {
  return (CLAUDE_SUBSCRIPTION_PROVIDER_IDS as readonly string[]).includes(providerId);
}

/** The upstream model of any Claude subscription model id form, else null. */
export function claudeSubscriptionUpstreamModelId(modelId: string): string | null {
  for (const prefix of PREFIXES) {
    if (modelId.startsWith(prefix) && modelId.length > prefix.length) {
      return modelId.slice(prefix.length);
    }
  }
  return null;
}

/** Whether a model id is any form of a Claude subscription model id. */
export function isClaudeSubscriptionModelId(modelId: string): boolean {
  return claudeSubscriptionUpstreamModelId(modelId) !== null;
}

/** The canonical `claude/<upstream>` id of any form, else the id unchanged. */
export function canonicalClaudeSubscriptionModelId(modelId: string): string {
  const upstream = claudeSubscriptionUpstreamModelId(modelId);
  return upstream === null ? modelId : `${CLAUDE_SUBSCRIPTION_MODEL_ID_PREFIX}${upstream}`;
}

/**
 * Every id form of the same model: the canonical id, then the workspace and
 * organization forms. Any other id is returned alone.
 */
export function claudeSubscriptionModelIdForms(modelId: string): string[] {
  const upstream = claudeSubscriptionUpstreamModelId(modelId);
  return upstream === null ? [modelId] : PREFIXES.map((prefix) => `${prefix}${upstream}`);
}

/** Whether two model ids name the same model (exact, or two Claude subscription forms). */
export function sameModelId(left: string, right: string): boolean {
  return (
    left === right ||
    (isClaudeSubscriptionModelId(left) &&
      canonicalClaudeSubscriptionModelId(left) === canonicalClaudeSubscriptionModelId(right))
  );
}

/** Whether a model id list names this model in any of its forms. */
export function modelIdListIncludes(list: readonly string[], modelId: string): boolean {
  return list.includes(modelId) || list.some((entry) => sameModelId(entry, modelId));
}
