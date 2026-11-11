import { expect, test } from "bun:test";
import {
  areOpenGeniSlackBotScopesAccepted,
  buildOpenGeniSlackBotManifest,
  hasOpenGeniSlackBotIdentityScope,
  OPENGENI_SLACK_BOT_IDENTITY_SCOPE,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "../src/slack-bot-scopes";

test("bot identity is requested but optional, so older installs keep posting as the app", () => {
  expect(OPENGENI_SLACK_BOT_IDENTITY_SCOPE).toBe("chat:write.customize");
  expect(OPENGENI_SLACK_BOT_REQUESTED_SCOPES).toContain("chat:write.customize");
  expect(OPENGENI_SLACK_BOT_REQUIRED_SCOPES as readonly string[]).not.toContain(
    "chat:write.customize",
  );
  expect(hasOpenGeniSlackBotIdentityScope(OPENGENI_SLACK_BOT_REQUIRED_SCOPES)).toBe(false);
  const upgraded = [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "chat:write.customize"];
  expect(areOpenGeniSlackBotScopesAccepted(upgraded)).toBe(true);
  expect(hasOpenGeniSlackBotIdentityScope(upgraded)).toBe(true);
  // Posting into channels the bot was never invited to stays refused.
  expect(areOpenGeniSlackBotScopesAccepted([...upgraded, "chat:write.public"])).toBe(false);
  expect(
    buildOpenGeniSlackBotManifest("https://app.example.test").oauth_config.scopes.bot,
  ).toContain("chat:write.customize");
});
