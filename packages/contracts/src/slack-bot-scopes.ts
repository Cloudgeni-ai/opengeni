export const OPENGENI_SLACK_BOT_REQUIRED_SCOPES = [
  "canvases:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "users:read",
] as const;

/**
 * Optional bot grants that remain inside the shipped bot's read/identity
 * boundary. Every other unrequired scope fails closed, including unknown future
 * Slack scopes, so verification, core routing, and UI eligibility cannot drift.
 */
export const OPENGENI_SLACK_BOT_SAFE_OPTIONAL_SCOPES = ["team:read"] as const;

/** @deprecated Use evaluateOpenGeniSlackBotScopes; an allowlist is the policy. */
export const OPENGENI_SLACK_BOT_FORBIDDEN_SCOPES = ["channels:join", "chat:write.public"] as const;

export type OpenGeniSlackBotScopePolicy = {
  accepted: boolean;
  missingRequired: string[];
  unsupported: string[];
};

function isOpenGeniSlackBotScopeAllowed(scope: string): boolean {
  return (
    (OPENGENI_SLACK_BOT_REQUIRED_SCOPES as readonly string[]).includes(scope) ||
    (OPENGENI_SLACK_BOT_SAFE_OPTIONAL_SCOPES as readonly string[]).includes(scope)
  );
}

export function areOpenGeniSlackBotScopesAccepted(grantedScopes: readonly string[]): boolean {
  return (
    OPENGENI_SLACK_BOT_REQUIRED_SCOPES.every((scope) => grantedScopes.includes(scope)) &&
    grantedScopes.every(isOpenGeniSlackBotScopeAllowed)
  );
}

export function evaluateOpenGeniSlackBotScopes(
  grantedScopes: readonly string[],
): OpenGeniSlackBotScopePolicy {
  const granted = new Set(grantedScopes);
  const missingRequired = OPENGENI_SLACK_BOT_REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  const unsupported = [...granted].filter((scope) => !isOpenGeniSlackBotScopeAllowed(scope)).sort();
  return {
    accepted: areOpenGeniSlackBotScopesAccepted(grantedScopes),
    missingRequired,
    unsupported,
  };
}
