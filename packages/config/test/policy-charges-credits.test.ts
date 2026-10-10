import { describe, expect, test } from "bun:test";

import {
  configuredModels,
  getSettings,
  policyChargesCreditsForModel,
  withClaudeConnectionCatalog,
  withWorkspaceOpperCatalogProvider,
} from "../src";

function base(env: Record<string, string> = {}) {
  return getSettings({ OPENGENI_ENV: "test", OPENGENI_OPENAI_API_KEY: "sk-test", ...env });
}

describe("policyChargesCreditsForModel", () => {
  test("agrees with the configured cost class for every catalog model", () => {
    const settings = base({ OPENGENI_OPPER_API_KEY: "op-test" });
    const models = configuredModels(settings);
    expect(models.some((model) => model.cost === "credits")).toBe(true);
    for (const model of models) {
      expect(policyChargesCreditsForModel(settings, model.id)).toBe(model.cost === "credits");
    }
  });

  test("a model the cost policy marks free never counts as credits", () => {
    const settings = base({
      OPENGENI_MODEL_COST_POLICY_JSON: JSON.stringify({ "gpt-6-sol": "free" }),
    });
    expect(policyChargesCreditsForModel(settings, "gpt-6-sol")).toBe(false);
    expect(policyChargesCreditsForModel(settings, "gpt-6-luna")).toBe(true);
  });

  test("subscription and connection ids never count as credits, even without their overlay", () => {
    const settings = base();
    for (const modelId of [
      "codex/gpt-6-sol",
      "supergrok/grok-4.7",
      "workspace-gateway/kimi-k3",
      "organization-gateway/kimi-k3",
      "workspace-openrouter/vendor/model",
      "organization-openrouter/vendor/model",
      "workspace-opper/aws/claude-opus-5-5",
      "organization-opper/aws/claude-opus-5-5",
      "workspace-anthropic/claude-fixture",
      "organization-anthropic/claude-fixture",
      "workspace-claude-subscription/claude-fixture",
      "organization-claude-subscription/claude-fixture",
      "workspace-openai-0b0c/gpt-6-sol",
      "workspace-azure-openai-0b0c/gpt-6-sol",
    ]) {
      expect(policyChargesCreditsForModel(settings, modelId)).toBe(false);
    }
    const overlay = withWorkspaceOpperCatalogProvider(
      withClaudeConnectionCatalog(base({ OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED: "true" }), {
        claude_subscription: { models: [{ upstreamModelId: "claude-fixture" }] },
      }),
      [{ upstreamModelId: "aws/claude-opus-5-5" }],
    );
    expect(
      policyChargesCreditsForModel(overlay, "organization-claude-subscription/claude-fixture"),
    ).toBe(false);
    expect(policyChargesCreditsForModel(overlay, "workspace-opper/aws/claude-opus-5-5")).toBe(
      false,
    );
  });

  test("an unknown id fails closed: the built-in fallback the deployment pays bills credits", () => {
    expect(policyChargesCreditsForModel(base(), "invented-model")).toBe(true);
  });
});
