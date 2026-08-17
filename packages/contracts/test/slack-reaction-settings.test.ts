import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKSPACE_SLACK_REACTION_SUMMON_SETTINGS,
  resolveWorkspaceSlackReactionSummonSettings,
  UpdateWorkspaceSettingsRequest,
  workspaceSlackReactionChannelAllowed,
} from "../src";
import {
  areOpenGeniSlackBotScopesAccepted,
  buildOpenGeniSlackBotManifest,
  evaluateOpenGeniSlackBotScopes,
  hasOpenGeniSlackBotSearchScopes,
  hasOpenGeniSlackReactionScope,
  OPENGENI_MANAGED_PUBLIC_BASE_URL,
  OPENGENI_SLACK_BOT_EVENTS,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
  OPENGENI_SLACK_BOT_SEARCH_SCOPES,
  OPENGENI_SLACK_MCP_USER_SCOPES,
  OPENGENI_SLACK_REACTION_REQUIRED_SCOPE,
} from "../src/slack-bot-scopes";

describe("Slack reaction summon workspace settings", () => {
  test("defaults fail closed and allow bot-member conversations only after enablement", () => {
    expect(resolveWorkspaceSlackReactionSummonSettings({})).toEqual(
      DEFAULT_WORKSPACE_SLACK_REACTION_SUMMON_SETTINGS,
    );
    expect(
      resolveWorkspaceSlackReactionSummonSettings({ slackReactionSummon: { enabled: true } }),
    ).toEqual(DEFAULT_WORKSPACE_SLACK_REACTION_SUMMON_SETTINGS);
  });

  test("accepts only the genie emoji and normalizes allowlist duplicates", () => {
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        slackReactionSummon: {
          enabled: true,
          emoji: ":genie:",
          channelPolicy: { mode: "bot_member" },
        },
      }).success,
    ).toBe(false);
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        slackReactionSummon: {
          enabled: true,
          emoji: "sparkles",
          channelPolicy: { mode: "bot_member" },
        },
      }).success,
    ).toBe(false);
    const resolved = resolveWorkspaceSlackReactionSummonSettings({
      slackReactionSummon: {
        enabled: true,
        emoji: "genie",
        channelPolicy: { mode: "allowlist", channelIds: ["C1", "C1", "C2"] },
      },
    });
    expect(resolved.channelPolicy).toEqual({ mode: "allowlist", channelIds: ["C1", "C2"] });
    expect(workspaceSlackReactionChannelAllowed(resolved, "C1")).toBe(true);
    expect(workspaceSlackReactionChannelAllowed(resolved, "C3")).toBe(false);
  });

  test("requests the least-privilege read scope without making it base eligibility", () => {
    expect(OPENGENI_SLACK_BOT_REQUESTED_SCOPES).toContain(OPENGENI_SLACK_REACTION_REQUIRED_SCOPE);
    expect(hasOpenGeniSlackReactionScope(OPENGENI_SLACK_BOT_REQUESTED_SCOPES)).toBe(true);
    expect(hasOpenGeniSlackReactionScope([])).toBe(false);
  });

  test("requests bot-token public search scopes without widening beyond Slack's bot-scope surface", () => {
    expect(OPENGENI_SLACK_BOT_SEARCH_SCOPES).toEqual([
      "search:read.public",
      "search:read.files",
      "search:read.users",
    ]);
    for (const scope of OPENGENI_SLACK_BOT_SEARCH_SCOPES) {
      expect(OPENGENI_SLACK_BOT_REQUESTED_SCOPES).toContain(scope);
      // Existing installations without the search grant remain eligible.
      expect(OPENGENI_SLACK_BOT_REQUIRED_SCOPES).not.toContain(scope);
    }
    expect(hasOpenGeniSlackBotSearchScopes(OPENGENI_SLACK_BOT_REQUESTED_SCOPES)).toBe(true);
    expect(hasOpenGeniSlackBotSearchScopes(OPENGENI_SLACK_BOT_REQUIRED_SCOPES)).toBe(false);
    expect(areOpenGeniSlackBotScopesAccepted(OPENGENI_SLACK_BOT_REQUIRED_SCOPES)).toBe(true);
    expect(areOpenGeniSlackBotScopesAccepted(OPENGENI_SLACK_BOT_REQUESTED_SCOPES)).toBe(true);
    // Private-conversation search stays a user-token-only personal grant; join
    // and public-post scopes stay off the bot allowlist.
    for (const scope of [
      "search:read.private",
      "search:read.im",
      "search:read.mpim",
      "search:read.enterprise",
      "channels:join",
      "chat:write.public",
    ]) {
      expect(OPENGENI_SLACK_BOT_REQUESTED_SCOPES).not.toContain(scope);
      expect(
        evaluateOpenGeniSlackBotScopes([...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, scope]),
      ).toMatchObject({ accepted: false, unsupported: [scope] });
    }
  });

  test("generates one managed or self-hosted manifest with the exact read scope and reaction event", () => {
    const managed = buildOpenGeniSlackBotManifest(OPENGENI_MANAGED_PUBLIC_BASE_URL);
    expect(managed.oauth_config.scopes.bot).toEqual([...OPENGENI_SLACK_BOT_REQUESTED_SCOPES]);
    expect(managed.features.app_home).toEqual({
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(managed.oauth_config.scopes.bot).not.toContain("reactions:write");
    expect(managed.oauth_config.scopes.user).toEqual([...OPENGENI_SLACK_MCP_USER_SCOPES]);
    expect(managed.settings.is_mcp_enabled).toBe(true);
    expect(managed.settings.event_subscriptions.bot_events).toEqual([...OPENGENI_SLACK_BOT_EVENTS]);
    expect(managed.settings.event_subscriptions.request_url).toBe(
      "https://app.opengeni.ai/v1/integrations/slack/events",
    );

    const selfHosted = buildOpenGeniSlackBotManifest("https://opengeni.example.test/");
    expect(selfHosted.oauth_config.redirect_urls).toEqual([
      "https://opengeni.example.test/v1/integrations/oauth/callback",
      "https://opengeni.example.test/v1/integrations/slack/callback",
    ]);
    expect(selfHosted.features.slash_commands[0]!.url).toBe(
      "https://opengeni.example.test/v1/integrations/slack/commands",
    );
    expect(() => buildOpenGeniSlackBotManifest("http://opengeni.example.test")).toThrow(
      "credential-free HTTPS",
    );
  });
});
