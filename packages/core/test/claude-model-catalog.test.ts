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

test("deployment flag removes subscription models and credentials without disabling API keys", () => {
  const connections = {
    anthropic: { active: true, models: [{ upstreamModelId: "claude-opus-5-5" }] },
    claude_subscription: { active: true, models: [{ upstreamModelId: "claude-opus-5-5" }] },
  };
  const enabled = withClaudeConnectionCatalog(
    testSettings({ claudeSubscriptionEnabled: true }),
    connections,
  );
  const disabled = { ...enabled, claudeSubscriptionEnabled: false };
  expect(
    configuredModels(disabled).some((model) =>
      model.id.startsWith("organization-claude-subscription/"),
    ),
  ).toBe(false);
  expect(
    configuredModels(disabled).some((model) => model.id.startsWith("organization-anthropic/")),
  ).toBe(true);
  expect(() => withClaudeConnectionCredential(disabled, "claude_subscription", "token")).toThrow(
    "not enabled",
  );
  const rebuilt = withClaudeConnectionCatalog(disabled, connections);
  expect(
    configuredProviders(rebuilt).some(
      (provider) => provider.id === "organization-claude-subscription",
    ),
  ).toBe(false);
  expect(withClaudeConnectionCredential(rebuilt, "anthropic", "key")).toBeDefined();
  expect(testSettings().claudeSubscriptionEnabled).toBe(false);
});

test("workspace and organization Claude credentials cannot overwrite each other", () => {
  const connections = {
    anthropic: { active: true, models: [{ upstreamModelId: "claude-opus-5-5" }] },
  };
  let settings = withClaudeConnectionCatalog(testSettings(), connections);
  settings = withClaudeConnectionCatalog(settings, connections, "workspace");
  settings = withClaudeConnectionCredential(settings, "anthropic", "org-key");
  settings = withClaudeConnectionCredential(settings, "anthropic", "workspace-key", "workspace");
  const providers = configuredProviders(settings);
  expect(providers.find((provider) => provider.id === "organization-anthropic")?.apiKey).toBe(
    "org-key",
  );
  const workspace = providers.find((provider) => provider.id === "workspace-anthropic");
  expect(workspace?.apiKey).toBe("workspace-key");
  expect(workspace?.credentialSource.kind).toBe("workspace_connection");
  expect(workspace?.billing).toEqual({ upstreamPayer: "workspace", metering: "external" });
  expect(JSON.stringify(configuredModels(settings))).not.toContain("workspace-key");
});

test("Claude keys and subscription tokens remain separate scoped routes and readiness", () => {
  const settings = testSettings({ claudeSubscriptionEnabled: true });
  const claudeConnections = {
    anthropic: { active: true, models: [{ upstreamModelId: "claude-opus-5-5" }] },
    claude_subscription: { active: false, models: [{ upstreamModelId: "claude-opus-5-5" }] },
  };
  const catalog = withClaudeConnectionCatalog(settings, claudeConnections);
  const keyId = "organization-anthropic/claude-opus-5-5";
  const subscriptionId = "organization-claude-subscription/claude-opus-5-5";
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
    upstreamModelId: "claude-opus-5-5",
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
    claudeSubscriptionEnabled: true,
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
    anthropic: { models: [{ upstreamModelId: "claude-opus-5-5" }] },
  });
  expect(
    configuredProviders(scoped).find((p) => p.id === "organization-anthropic")?.apiKey,
  ).toBeUndefined();
});

test("rebuilding a Claude catalog clears old credentials before live authorization", () => {
  const model = { upstreamModelId: "claude-opus-5-5" };
  let settings = withClaudeConnectionCatalog(testSettings({ claudeSubscriptionEnabled: true }), {
    anthropic: { active: true, models: [model] },
    claude_subscription: { active: true, models: [model] },
  });
  settings = withClaudeConnectionCredential(settings, "anthropic", "old-api-secret");
  settings = withClaudeConnectionCredential(settings, "claude_subscription", "subscription-secret");
  const rebuilt = withClaudeConnectionCatalog(settings, {
    anthropic: { active: false, models: [model] },
  });
  const providers = configuredProviders(rebuilt);
  expect(
    providers.find((provider) => provider.id === "organization-anthropic")?.apiKey,
  ).toBeUndefined();
  expect(
    providers.find((provider) => provider.id === "organization-claude-subscription")?.apiKey,
  ).toBe("subscription-secret");
  const authorized = withClaudeConnectionCredential(rebuilt, "anthropic", "new-api-secret");
  expect(
    configuredProviders(authorized).find((provider) => provider.id === "organization-anthropic")
      ?.apiKey,
  ).toBe("new-api-secret");
});

test("managed Claude catalog enables reasoning only for verified adaptive models", () => {
  const settings = withClaudeConnectionCatalog(testSettings({ claudeSubscriptionEnabled: true }), {
    anthropic: {
      models: ["claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-custom-future"].map(
        (upstreamModelId) => ({ upstreamModelId }),
      ),
    },
  });
  const models = configuredModels(settings).filter(
    (model) => model.providerId === "organization-anthropic",
  );
  const verified = models.find((model) => model.upstreamModelId === "claude-opus-5-5")!;
  expect(verified.label).toBe("Claude Opus 5.5");
  expect(
    models.find((candidate) => candidate.upstreamModelId === "claude-custom-future")?.label,
  ).toBe("claude-custom-future");
  expect(verified.capabilities.reasoning.runnable).toBe(true);
  expect(verified.capabilities.reasoning.efforts).toEqual(["low", "medium", "high"]);
  for (const model of models.filter((candidate) => candidate !== verified)) {
    expect(model.reasoningEffort).toBe(false);
    expect(model.capabilities.reasoning).toMatchObject({
      upstream: "unknown",
      runnable: false,
      efforts: [],
      defaultEffort: null,
    });
  }
});

test("subscription identity stays inside scoped credentials without changing model admission", () => {
  const settings = withClaudeConnectionCatalog(testSettings({ claudeSubscriptionEnabled: true }), {
    claude_subscription: { models: [{ upstreamModelId: "claude-opus-5-5" }] },
  });
  const identity = {
    accountUuid: "10000000-0000-4000-8000-000000000001",
    deviceId: "a".repeat(64),
  };
  const credential = JSON.stringify({ version: 1, token: "sk-ant-oat01-fixture", identity });
  const runtime = withClaudeConnectionCredential(settings, "claude_subscription", credential);
  const provider = configuredProviders(runtime).find(
    (p) => p.id === "organization-claude-subscription",
  )!;
  expect(provider.apiKey).toBe("sk-ant-oat01-fixture");
  expect(provider.anthropic?.identity).toEqual(identity);
  expect(configuredModels(runtime)).toEqual(configuredModels(settings));
  const catalog = withClaudeConnectionCatalog(runtime, {
    claude_subscription: { models: [{ upstreamModelId: "claude-opus-5-5" }] },
  });
  const cleared = configuredProviders(catalog).find(
    (p) => p.id === "organization-claude-subscription",
  )!;
  expect(cleared.apiKey).toBeUndefined();
  expect(cleared.anthropic?.identity).toBeUndefined();
  const replaced = withClaudeConnectionCredential(
    runtime,
    "claude_subscription",
    "sk-ant-oat01-other-account",
  );
  const replacedProvider = configuredProviders(replaced).find((p) => p.id === provider.id)!;
  expect(replacedProvider.apiKey).toBe("sk-ant-oat01-other-account");
  expect(replacedProvider.anthropic?.identity).toBeUndefined();
});

test("accepted model definition tracks Claude generation options but excludes account identity", () => {
  const settings = withClaudeConnectionCatalog(testSettings({ claudeSubscriptionEnabled: true }), {
    claude_subscription: { models: [{ upstreamModelId: "claude-opus-5-5" }] },
  });
  const modelId = "organization-claude-subscription/claude-opus-5-5";
  const version = (candidateSettings: ReturnType<typeof testSettings>) =>
    configuredModels(candidateSettings).find((model) => model.id === modelId)!.definitionVersion;
  const initial = version(settings);
  for (const identity of [
    { accountUuid: "10000000-0000-4000-8000-000000000001", deviceId: "a".repeat(64) },
    { accountUuid: "20000000-0000-4000-8000-000000000002", deviceId: "b".repeat(64) },
  ]) {
    expect(
      version(
        withClaudeConnectionCredential(
          settings,
          "claude_subscription",
          JSON.stringify({ version: 1, token: "sk-ant-oat01-fixture", identity }),
        ),
      ),
    ).toBe(initial);
  }
  for (const change of [
    { cacheTtl: "1h" },
    { maxOutputTokens: 64000 },
    { auth: "api-key" },
    { streamIdleTimeoutMs: 120000 },
  ]) {
    const providers = JSON.parse(settings.modelProvidersJson!);
    const provider = providers.find(
      (candidate: { id: string }) => candidate.id === "organization-claude-subscription",
    );
    Object.assign(provider.anthropic, change);
    expect(version({ ...settings, modelProvidersJson: JSON.stringify(providers) })).not.toBe(
      initial,
    );
  }
});

test("workspace Claude readiness, connection restrictions and admission references stay scope-specific", () => {
  const models = [{ upstreamModelId: "claude-opus-5-5" }];
  const settings = testSettings({ claudeSubscriptionEnabled: true });
  const input = {
    settings,
    policy: null,
    codexSubscriptionActive: false,
    claudeConnections: { anthropic: { active: false, models } },
    workspaceClaudeConnections: {
      anthropic: { active: true, models },
      claude_subscription: { active: false, models },
    },
  };
  const rows = resolveWorkspaceModelSelection(input);
  expect(
    rows.find((row) => row.model.id === "workspace-anthropic/claude-opus-5-5")?.availability
      .selectable,
  ).toBe(true);
  expect(
    rows.find((row) => row.model.id === "organization-anthropic/claude-opus-5-5")
      ?.credentialReadiness.status,
  ).toBe("not_ready");
  expect(
    rows.find((row) => row.model.id === "workspace-claude-subscription/claude-opus-5-5")
      ?.credentialReadiness.status,
  ).toBe("not_ready");
  for (const kind of ["anthropic", "claude_subscription"] as const) {
    const id = `workspace-${kind === "anthropic" ? kind : "claude-subscription"}/claude-opus-5-5`;
    expect(workspaceCustomModelReference(settings, id)).toEqual({
      scope: "workspace",
      providerKind: kind,
      upstreamModelId: "claude-opus-5-5",
    });
  }
  const disabled = resolveWorkspaceModelSelection({
    ...input,
    settings: { ...settings, claudeSubscriptionEnabled: false },
  });
  expect(disabled.some((row) => row.model.providerId === "workspace-claude-subscription")).toBe(
    false,
  );
  expect(
    disabled.find((row) => row.model.providerId === "workspace-anthropic")?.availability.selectable,
  ).toBe(true);
});
