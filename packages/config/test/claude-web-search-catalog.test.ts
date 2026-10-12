import { expect, test } from "bun:test";
import {
  assertTurnExecutionPolicyMatchesConfigV1,
  configuredModels,
  getSettings,
  resolveTurnExecutionPolicyV1,
  withClaudeConnectionCatalog,
} from "../src";

const connections = {
  anthropic: { active: true, models: [{ upstreamModelId: "claude-opus-5-5" }] },
  claude_subscription: { active: true, models: [{ upstreamModelId: "claude-opus-5-5" }] },
};
const catalog = (webSearch: boolean) =>
  withClaudeConnectionCatalog(
    getSettings({
      OPENGENI_ENV: "test",
      OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED: "true",
      OPENGENI_WEB_SEARCH_ENABLED: webSearch ? "true" : "false",
    }),
    connections,
  );
const claudeModels = (settings: ReturnType<typeof catalog>) =>
  configuredModels(settings).filter((model) => model.id.startsWith("organization-"));

test("Claude API key and subscription models get hosted web search exactly when it is allowed", () => {
  const enabled = claudeModels(catalog(true));
  expect(enabled.map((model) => model.id).sort()).toEqual([
    "organization-anthropic/claude-opus-5-5",
    "organization-claude-subscription/claude-opus-5-5",
  ]);
  for (const model of enabled) {
    expect(model.hostedWebSearch).toBe(true);
    expect(model.capabilities.hostedTools.webSearch).toEqual({
      upstream: "supported",
      runnable: true,
    });
  }
  for (const model of claudeModels(catalog(false))) {
    expect(model.hostedWebSearch).toBe(false);
    expect(model.capabilities.hostedTools.webSearch).toEqual({
      upstream: "unknown",
      runnable: false,
    });
  }
});

test("a Claude turn accepted before search was available keeps running without the tool", () => {
  const modelId = "organization-claude-subscription/claude-opus-5-5";
  const input = {
    modelId,
    requestedModelId: modelId,
    modelSource: "explicit",
    reasoningEffort: "high",
    reasoningSource: "explicit",
  } as const;
  // Before this change every Claude model declared web search unknown/off.
  const accepted = resolveTurnExecutionPolicyV1(catalog(false), input);
  const current = catalog(true);
  const verified = assertTurnExecutionPolicyMatchesConfigV1(current, accepted, input);
  expect(verified.model.hostedWebSearch).toBe(false);
  expect(verified.model.definitionVersion).toBe(accepted.definitionVersion);
  // The next accepted turn gets Claude's search.
  const next = resolveTurnExecutionPolicyV1(current, input);
  expect(assertTurnExecutionPolicyMatchesConfigV1(current, next, input).model.hostedWebSearch).toBe(
    true,
  );
});
