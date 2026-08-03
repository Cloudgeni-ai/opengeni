import { describe, expect, test } from "bun:test";
import {
  DEFAULT_WORKSPACE_SLACK_REACTION_SUMMON_SETTINGS,
  resolveWorkspaceSlackReactionSummonSettings,
  UpdateWorkspaceSettingsRequest,
  workspaceSlackReactionChannelAllowed,
} from "../src";
import {
  buildOpenGeniSlackBotManifest,
  hasOpenGeniSlackReactionScope,
  OPENGENI_MANAGED_PUBLIC_BASE_URL,
  OPENGENI_SLACK_BOT_EVENTS,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
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

  test("validates exact emoji names and normalizes allowlist duplicates", () => {
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        slackReactionSummon: {
          enabled: true,
          emoji: ":genie:",
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

  test("generates one managed or self-hosted manifest with the exact read scope and reaction event", () => {
    const managed = buildOpenGeniSlackBotManifest(OPENGENI_MANAGED_PUBLIC_BASE_URL);
    expect(managed.oauth_config.scopes.bot).toEqual([...OPENGENI_SLACK_BOT_REQUESTED_SCOPES]);
    expect(managed.oauth_config.scopes.bot).not.toContain("reactions:write");
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
