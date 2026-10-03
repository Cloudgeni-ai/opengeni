import { expect, test } from "bun:test";
import {
  areOpenGeniSlackBotScopesAccepted,
  buildOpenGeniSlackBotManifest,
  hasOpenGeniSlackFileUploadScope,
  OPENGENI_SLACK_BOT_REQUESTED_SCOPES,
  OPENGENI_SLACK_BOT_REQUIRED_SCOPES,
} from "../src/slack-bot-scopes";

test("file upload is requested but remains optional for legacy bot eligibility", () => {
  expect(OPENGENI_SLACK_BOT_REQUESTED_SCOPES).toContain("files:write");
  expect(OPENGENI_SLACK_BOT_REQUIRED_SCOPES as readonly string[]).not.toContain("files:write");
  expect(areOpenGeniSlackBotScopesAccepted(OPENGENI_SLACK_BOT_REQUIRED_SCOPES)).toBe(true);
  expect(hasOpenGeniSlackFileUploadScope(OPENGENI_SLACK_BOT_REQUIRED_SCOPES)).toBe(false);
  const upgraded = [...OPENGENI_SLACK_BOT_REQUIRED_SCOPES, "files:write"];
  expect(areOpenGeniSlackBotScopesAccepted(upgraded)).toBe(true);
  expect(hasOpenGeniSlackFileUploadScope(upgraded)).toBe(true);
  expect(areOpenGeniSlackBotScopesAccepted([...upgraded, "channels:join"])).toBe(false);
  expect(
    buildOpenGeniSlackBotManifest("https://app.example.test").oauth_config.scopes.bot,
  ).toContain("files:write");
});
