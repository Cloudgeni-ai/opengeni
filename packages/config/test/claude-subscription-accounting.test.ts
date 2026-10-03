import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  getSettings,
  withClaudeConnectionCatalog,
  resolveModelProvider,
  resolveTurnExecutionPolicyV1,
  assertTurnExecutionPolicyMatchesConfigV1,
} from "../src";
function stable(value: any): any {
  return Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, stable(value[key])]),
        )
      : value;
}
for (const scope of ["workspace", "organization"] as const) {
  const settings = withClaudeConnectionCatalog(
    getSettings({ OPENGENI_ENV: "test", OPENGENI_CLAUDE_SUBSCRIPTION_ENABLED: "true" }),
    { claude_subscription: { active: true, models: [{ upstreamModelId: "claude-opus-5-5" }] } },
    scope,
  );
  const modelId = `${scope}-claude-subscription/claude-opus-5-5`;
  const input = {
    modelId,
    requestedModelId: modelId,
    modelSource: "explicit",
    reasoningEffort: "high",
    reasoningSource: "explicit",
  } as const;
  test(`${scope} Claude uses subscription billing and credential identity`, () => {
    const policy = resolveTurnExecutionPolicyV1(settings, input);
    expect(policy.credentialSource).toEqual({ kind: "connected_subscription", provider: "claude" });
    expect(policy.billing).toEqual({
      upstreamPayer: "connected_subscription",
      metering: "external",
    });
    expect(resolveModelProvider(settings, modelId)!.model.cost).toBe("subscription");
  });
  test(`${scope} retains only the complete exact legacy accounting definition`, () => {
    const { model, provider } = resolveModelProvider(settings, modelId)!;
    const credentialSource = { kind: `${scope}_connection`, mechanism: "api_key" };
    const billing = { upstreamPayer: scope, metering: "external" };
    const { identity: _identity, credentialBinding: _binding, ...anthropic } = provider.anthropic!;
    // Historical V1 acceptance fixture. Its transport, limits, capabilities and
    // pricing remain frozen independently of the accounting-label correction.
    const definition = {
      schemaVersion: model.schemaVersion,
      id: model.id,
      providerId: model.providerId,
      deployment: model.deployment,
      provider: {
        adapterKind: provider.kind,
        wireApi: provider.api,
        wireProfile: provider.wireProfile,
        baseUrl: provider.baseUrl ?? null,
        defaultHeaders: [],
        defaultQuery: [],
        anthropic,
      },
      credentialSource,
      billing,
      executionLimits: model.executionLimits,
      capabilities: model.capabilities,
      ...(model.requestPolicy ? { requestPolicy: model.requestPolicy } : {}),
      pricing: model.pricing ?? null,
    };
    const definitionVersion =
      "sha256:" +
      createHash("sha256")
        .update("opengeni:model-definition:v1\n")
        .update(JSON.stringify(stable(definition)))
        .digest("hex");
    const policy = {
      ...resolveTurnExecutionPolicyV1(settings, input),
      credentialSource,
      billing,
      definitionVersion,
    } as any;
    expect(assertTurnExecutionPolicyMatchesConfigV1(settings, policy, input).policy).toEqual(
      policy,
    );
    for (const change of [
      { definitionVersion: "sha256:" + "0".repeat(64) },
      { upstreamModelId: "another-model" },
      { wireApi: "responses" },
      { providerId: "another-provider" },
      {
        billing: {
          upstreamPayer: scope === "workspace" ? "organization" : "workspace",
          metering: "external",
        },
      },
      { credentialSource: { kind: "connected_subscription", provider: "codex" } },
    ]) {
      expect(() =>
        assertTurnExecutionPolicyMatchesConfigV1(settings, { ...policy, ...change }, input),
      ).toThrow();
    }
    const changed = {
      ...settings,
      modelProvidersJson: JSON.stringify(
        JSON.parse(settings.modelProvidersJson).map((entry: any) => ({
          ...entry,
          baseUrl: "https://provider.example.test/v1",
        })),
      ),
    };
    expect(() => assertTurnExecutionPolicyMatchesConfigV1(changed, policy, input)).toThrow();
  });
}
