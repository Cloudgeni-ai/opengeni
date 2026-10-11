import { describe, expect, test } from "bun:test";
import { UpdateWorkspaceSettingsRequest, WorkspaceSettingsSchema } from "@opengeni/contracts";
import {
  configuredModels,
  configuredModelListPricingSchedules,
  getSettings,
  selectModelPricing,
  settingsWithResolvedModelContext,
  withClaudeConnectionCatalog,
  workspaceModelCompactionPolicy,
} from "../src";

const settings = getSettings({});
const model = {
  id: "synthetic/model",
  contextWindowTokens: 1_000_000,
  effectiveContextWindowTokens: 872_000,
  autoCompactTokenLimit: 800_000,
};

describe("workspace model compaction", () => {
  test("a workspace follows its organization's limit until it sets its own", () => {
    const organization = { modelCompactionThresholds: { [model.id]: 300_000 } };
    const following = workspaceModelCompactionPolicy(settings, model, {}, organization);
    expect(following.overrideTokens).toBeNull();
    expect(following.organizationTokens).toBe(300_000);
    expect(following.effectiveTokens).toBe(300_000);
    expect(
      settingsWithResolvedModelContext(settings, model, {}, organization)
        .contextAutoCompactThresholdTokens,
    ).toBe(300_000);
    const own = { modelCompactionThresholds: { [model.id]: 120_000 } };
    expect(workspaceModelCompactionPolicy(settings, model, own, organization).effectiveTokens).toBe(
      120_000,
    );
    // The organization's limit for another model doesn't apply.
    expect(
      workspaceModelCompactionPolicy(settings, { ...model, id: "other/model" }, {}, organization)
        .effectiveTokens,
    ).toBe(800_000);
  });

  test("default, exact-model override and reset have one runtime/catalog policy", () => {
    expect(workspaceModelCompactionPolicy(settings, model, {}).effectiveTokens).toBe(800_000);
    const workspace = { modelCompactionThresholds: { [model.id]: 250_000 } };
    expect(workspaceModelCompactionPolicy(settings, model, workspace)).toEqual({
      defaultTokens: 800_000,
      overrideTokens: 250_000,
      organizationTokens: null,
      effectiveTokens: 250_000,
      minimumTokens: 16_000,
      maximumTokens: 872_000,
    });
    expect(
      settingsWithResolvedModelContext(settings, model, workspace)
        .contextAutoCompactThresholdTokens,
    ).toBe(250_000);
    expect(
      workspaceModelCompactionPolicy(settings, { ...model, id: "other/model" }, workspace)
        .effectiveTokens,
    ).toBe(800_000);
    expect(
      workspaceModelCompactionPolicy(settings, model, {
        modelCompactionThresholds: { [model.id]: null },
      }).effectiveTokens,
    ).toBe(800_000);
  });

  test("a changed model ceiling clamps the effective value without destroying the saved intent", () => {
    const policy = workspaceModelCompactionPolicy(
      settings,
      {
        ...model,
        contextWindowTokens: 200_000,
        effectiveContextWindowTokens: 160_000,
      },
      { modelCompactionThresholds: { [model.id]: 250_000 } },
    );
    expect(policy.overrideTokens).toBe(250_000);
    expect(policy.maximumTokens).toBe(160_000);
    expect(policy.effectiveTokens).toBe(160_000);
  });

  test("malformed or future preferences never erase other workspace settings", () => {
    for (const value of [null, [], "future", { [model.id]: -1 }, { [model.id]: 12.5 }]) {
      const workspace = { agentHumanInputEnabled: false, modelCompactionThresholds: value };
      expect(WorkspaceSettingsSchema.parse(workspace).agentHumanInputEnabled).toBe(false);
      expect(workspaceModelCompactionPolicy(settings, model, workspace).effectiveTokens).toBe(
        800_000,
      );
    }
  });

  test("an existing small deployment trigger stays intact without a workspace override", () => {
    expect(
      workspaceModelCompactionPolicy(
        { ...settings, contextAutoCompactThresholdTokens: 8_000 },
        { ...model, autoCompactTokenLimit: undefined },
        {},
      ).defaultTokens,
    ).toBe(8_000);
  });

  test("writes validate integer budgets and resets, never prototype keys", () => {
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        modelCompactionThresholds: {
          [model.id]: 95_000,
          "other/model": null,
        },
      }).success,
    ).toBe(true);
    for (const value of [0, -1, 15_999, 1.5, "95000", 2_147_483_648]) {
      expect(
        UpdateWorkspaceSettingsRequest.safeParse({
          modelCompactionThresholds: {
            [model.id]: value,
          },
        }).success,
      ).toBe(false);
    }
    expect(
      UpdateWorkspaceSettingsRequest.safeParse({
        modelCompactionThresholds: JSON.parse('{"__proto__":95000}'),
      }).success,
    ).toBe(false);
  });
});

test("Haiku 5.5 has exact native limits, price boundary and a cost-conscious default", () => {
  const catalog = withClaudeConnectionCatalog(settings, {
    anthropic: { models: [{ upstreamModelId: "claude-haiku-5-5" }] },
  });
  const haiku = configuredModels(catalog).find((row) => row.id.endsWith("/claude-haiku-5-5"))!;
  expect(haiku.label).toBe("Claude Haiku 5.5");
  expect(haiku.contextWindowTokens).toBe(1_000_000);
  expect(haiku.effectiveContextWindowTokens).toBe(872_000);
  expect(haiku.autoCompactTokenLimit).toBe(95_000);
  expect(haiku.capabilities.reasoning.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(haiku.capabilities.reasoning.defaultEffort).toBe("medium");
  const pricing = configuredModelListPricingSchedules(catalog)[haiku.id]!;
  expect(selectModelPricing(pricing, 100_000).inputMicrosPerMillionTokens).toBe(100_000);
  expect(selectModelPricing(pricing, 100_001).inputMicrosPerMillionTokens).toBe(500_000);
  expect(selectModelPricing(pricing, 100_001).outputMicrosPerMillionTokens).toBe(2_500_000);
});
