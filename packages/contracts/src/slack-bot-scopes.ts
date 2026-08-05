export const OPENGENI_SLACK_BOT_REQUIRED_SCOPES = [
  "app_mentions:read",
  "canvases:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "commands",
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

/** Read-only scope needed only for the optional emoji-reaction summon surface. */
export const OPENGENI_SLACK_REACTION_REQUIRED_SCOPE = "reactions:read" as const;

/**
 * Scopes requested by the managed and generated self-hosted manifests.
 *
 * `reactions:read` is deliberately not part of the base eligibility contract:
 * legacy installations may continue using existing Slack interactions and
 * tools while the reaction setting stays disabled and the UI asks an admin to
 * reinstall.
 */
export const OPENGENI_SLACK_BOT_REQUESTED_SCOPES = [
  ...OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_REACTION_REQUIRED_SCOPE,
] as const;

export const OPENGENI_SLACK_BOT_EVENTS = [
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
] as const;

export const OPENGENI_MANAGED_PUBLIC_BASE_URL = "https://app.opengeni.ai" as const;

function normalizedSlackManifestBaseUrl(publicBaseUrl: string): string {
  const parsed = new URL(publicBaseUrl);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new Error("Slack bot manifest public base URL must be credential-free HTTPS");
  }
  parsed.hash = "";
  parsed.search = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

/** Canonical managed/self-hosted Slack app manifest. Slack accepts JSON manifests. */
export function buildOpenGeniSlackBotManifest(publicBaseUrl: string) {
  const baseUrl = normalizedSlackManifestBaseUrl(publicBaseUrl);
  return {
    display_information: { name: "OpenGeni" },
    features: {
      bot_user: { display_name: "OpenGeni", always_online: false },
      slash_commands: [
        {
          command: "/opengeni",
          description: "Start an OpenGeni task in this channel",
          should_escape: false,
          url: `${baseUrl}/v1/integrations/slack/commands`,
        },
      ],
      shortcuts: [
        {
          callback_id: "opengeni_message",
          description: "Start an OpenGeni task from this Slack message",
          name: "Open in OpenGeni",
          type: "message",
        },
      ],
    },
    oauth_config: {
      redirect_urls: [
        `${baseUrl}/v1/integrations/oauth/callback`,
        `${baseUrl}/v1/integrations/slack/callback`,
      ],
      scopes: { bot: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        bot_events: [...OPENGENI_SLACK_BOT_EVENTS],
        request_url: `${baseUrl}/v1/integrations/slack/events`,
      },
      interactivity: {
        is_enabled: true,
        request_url: `${baseUrl}/v1/integrations/slack/interactions`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  } as const;
}

/**
 * Optional bot grants that remain inside the shipped bot's read/identity
 * boundary. Every other unrequired scope fails closed, including unknown future
 * Slack scopes, so verification, core routing, and UI eligibility cannot drift.
 */
export const OPENGENI_SLACK_BOT_SAFE_OPTIONAL_SCOPES = [
  "team:read",
  OPENGENI_SLACK_REACTION_REQUIRED_SCOPE,
] as const;

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

export function hasOpenGeniSlackReactionScope(grantedScopes: readonly string[]): boolean {
  return grantedScopes.includes(OPENGENI_SLACK_REACTION_REQUIRED_SCOPE);
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
