import { expect, test } from "bun:test";
import {
  configuredModels,
  configuredProviders,
  resolveTurnExecutionPolicyV1,
  withClaudeConnectionCatalog,
  withClaudeConnectionCredential,
} from "@opengeni/config";
import { testSettings } from "@opengeni/testing";
import {
  resolveWorkspaceModelSelection,
  workspaceCustomModelReference,
} from "../src/model-catalog";

test("Claude keys and subscription tokens remain separate scoped routes and readiness", () => {
  const settings = testSettings();
  const claudeConnections = {
    anthropic: { active: true, models: [{ upstreamModelId: "claude-sonnet-4-6" }] },
    claude_subscription: { active: false, models: [{ upstreamModelId: "claude-sonnet-4-6" }] },
  };
  const catalog = withClaudeConnectionCatalog(settings, claudeConnections);
  const keyId = "organization-anthropic/claude-sonnet-4-6";
  const subscriptionId = "organization-claude-subscription/claude-sonnet-4-6";
  const selection = resolveWorkspaceModelSelection({
    settings,
    policy: null,
    codexSubscriptionActive: false,
    claudeConnections,
  });
  expect(selection.find((row) => row.model.id === keyId)?.credentialReadiness.status).toBe("ready");
  expect(selection.find((row) => row.model.id === subscriptionId)?.credentialReadiness.status).toBe(
    "not_ready",
  );
  expect(workspaceCustomModelReference(catalog, keyId)).toEqual({
    scope: "organization",
    providerKind: "anthropic",
    upstreamModelId: "claude-sonnet-4-6",
  });
  expect(workspaceCustomModelReference(catalog, subscriptionId)?.providerKind).toBe(
    "claude_subscription",
  );
  const runtime = withClaudeConnectionCredential(catalog, "anthropic", "api-key-secret");
  const providers = configuredProviders(runtime);
  expect(providers.find((row) => row.id === "organization-anthropic")?.apiKey).toBe(
    "api-key-secret",
  );
  expect(
    providers.find((row) => row.id === "organization-claude-subscription")?.apiKey,
  ).toBeUndefined();
  const models = configuredModels(runtime);
  expect(JSON.stringify(models)).not.toContain("api-key-secret");
  expect(models.find((row) => row.id === keyId)?.capabilities.inputModalities).toContain("image");
  expect(models.find((row) => row.id === keyId)?.billing.metering).toBe("external");
  expect(
    resolveTurnExecutionPolicyV1(runtime, {
      modelId: keyId,
      requestedModelId: null,
      modelSource: "session",
      reasoningEffort: "high",
      reasoningSource: "session",
    }).wireApi,
  ).toBe("anthropic-messages");
  const denied = resolveWorkspaceModelSelection({
    settings,
    policy: null,
    codexSubscriptionActive: false,
    claudeConnections,
    connectionModelRestrictions: { "organization-anthropic/": [] },
  });
  expect(denied.find((row) => row.model.id === keyId)?.availability.selectable).toBe(false);
});

test("deployment credentials cannot become organization Claude credentials", () => {
  const settings = testSettings({
    modelProvidersJson: JSON.stringify([
      {
        id: "organization-anthropic",
        kind: "api-key",
        api: "anthropic-messages",
        apiKey: "deployment-secret",
        baseUrl: "https://api.anthropic.com/v1",
        models: [{ id: "organization-anthropic/claude-test", upstreamModelId: "claude-test" }],
      },
    ]),
  });
  const scoped = withClaudeConnectionCatalog(settings, {
    anthropic: { models: [{ upstreamModelId: "claude-sonnet-4-6" }] },
  });
  expect(
    configuredProviders(scoped).find((p) => p.id === "organization-anthropic")?.apiKey,
  ).toBeUndefined();
});
