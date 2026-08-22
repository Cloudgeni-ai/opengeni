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
 * Bot-token search scopes for Slack's Real-time Search API
 * (`assistant.search.context`). Slack accepts these as BOT scopes, so
 * workspace-wide public search runs under the bot identity and never needs a
 * human proxy token. Private-channel, DM, and MPIM search remain user-token
 * only and belong exclusively to the personal hosted-MCP grant.
 */
export const OPENGENI_SLACK_BOT_SEARCH_SCOPES = [
  "search:read.public",
  "search:read.files",
  "search:read.users",
] as const;

/**
 * Scopes requested by the managed and generated self-hosted manifests.
 *
 * `reactions:read` and the bot search scopes are deliberately not part of the
 * base eligibility contract: legacy installations may continue using existing
 * Slack interactions and tools while the reaction setting stays disabled, bot
 * search stays unavailable, and the UI asks an admin to reinstall.
 */
export const OPENGENI_SLACK_BOT_REQUESTED_SCOPES = [
  ...OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_REACTION_REQUIRED_SCOPE,
  ...OPENGENI_SLACK_BOT_SEARCH_SCOPES,
] as const;

export const OPENGENI_SLACK_BOT_EVENTS = [
  "app_home_opened",
  "app_mention",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "reaction_added",
] as const;

/** Full user-token scope set for every tool currently exposed by Slack's hosted MCP server. */
export const OPENGENI_SLACK_MCP_USER_SCOPES = [
  "search:read.public",
  "search:read.private",
  "search:read.mpim",
  "search:read.im",
  "search:read.files",
  "files:read",
  "emoji:read",
  "search:read.users",
  "chat:write",
  "channels:history",
  "groups:history",
  "mpim:history",
  "im:history",
  "channels:write",
  "groups:write",
  "im:write",
  "mpim:write",
  "reactions:write",
  "canvases:read",
  "canvases:write",
  "users:read",
  "users:read.email",
  "channels:read",
  "groups:read",
  "mpim:read",
] as const;

export const OPENGENI_MANAGED_PUBLIC_BASE_URL = "https://app.opengeni.ai" as const;

export type OpenGeniSlackBotManifestOptions = Readonly<{
  appName?: string;
  slashCommand?: string;
  shortcutName?: string;
}>;

function normalizedSlackManifestText(
  value: string | undefined,
  fallback: string,
  label: string,
  maxLength: number,
): string {
  const normalized = value?.trim() || fallback;
  if (normalized.length > maxLength || /[\r\n\0]/u.test(normalized)) {
    throw new Error(`Slack bot manifest ${label} must be at most ${maxLength} plain characters`);
  }
  return normalized;
}

function normalizedSlackCommand(value: string | undefined): string {
  const command = value?.trim() || "/opengeni";
  if (!/^\/[a-z0-9_-]{1,31}$/u.test(command)) {
    throw new Error(
      "Slack bot manifest slash command must start with / and contain at most 31 lowercase letters, digits, hyphens, or underscores",
    );
  }
  return command;
}

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
export function buildOpenGeniSlackBotManifest(
  publicBaseUrl: string,
  options: OpenGeniSlackBotManifestOptions = {},
) {
  const baseUrl = normalizedSlackManifestBaseUrl(publicBaseUrl);
  const appName = normalizedSlackManifestText(options.appName, "OpenGeni", "app name", 35);
  const slashCommand = normalizedSlackCommand(options.slashCommand);
  const shortcutName = normalizedSlackManifestText(
    options.shortcutName,
    "Open in OpenGeni",
    "shortcut name",
    35,
  );
  return {
    display_information: { name: appName },
    features: {
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      bot_user: { display_name: "OpenGeni", always_online: false },
      slash_commands: [
        {
          command: slashCommand,
          description: "Start an OpenGeni task in this channel",
          should_escape: false,
          url: `${baseUrl}/v1/integrations/slack/commands`,
        },
      ],
      shortcuts: [
        {
          callback_id: "opengeni_message",
          description: "Start an OpenGeni task from this Slack message",
          name: shortcutName,
          type: "message",
        },
      ],
    },
    oauth_config: {
      redirect_urls: [
        `${baseUrl}/v1/integrations/oauth/callback`,
        `${baseUrl}/v1/integrations/slack/callback`,
      ],
      scopes: {
        bot: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
        user: [...OPENGENI_SLACK_MCP_USER_SCOPES],
      },
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
      is_mcp_enabled: true,
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
  ...OPENGENI_SLACK_BOT_SEARCH_SCOPES,
] as const;

export function hasOpenGeniSlackBotSearchScopes(grantedScopes: readonly string[]): boolean {
  return OPENGENI_SLACK_BOT_SEARCH_SCOPES.every((scope) => grantedScopes.includes(scope));
}

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
