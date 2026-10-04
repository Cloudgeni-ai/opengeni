import { describe, expect, test } from "bun:test";
import {
  applyModelCatalogDocument,
  assertTurnExecutionPolicyMatchesConfigV1,
  configuredModels,
  getSettings,
  resolveTurnExecutionPolicyV1,
  serviceTierForLatencyMode,
  settingsForAcceptedSubscriptionTurn,
  TurnExecutionPolicyDefinitionMismatchError,
  UnsupportedLatencyModeError,
  withCodexCatalogProvider,
  type ModelCapabilitiesV1,
} from "../src";

const base = getSettings({ OPENGENI_ENV: "test", OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true" });
const standard = { id: "standard", upstream: "unknown", runnable: true } as const;
const fast = {
  id: "fast",
  upstream: "supported",
  runnable: true,
  billingMultiplierBps: 20_000,
} as const;
const priority = { id: "priority", upstream: "supported", runnable: true } as const;
const legacyCapabilities: ModelCapabilitiesV1 = {
  ...configuredModels(base)[0]!.capabilities,
  inputModalities: ["text"],
  latencyModes: [standard],
};

function registrySettings(
  capabilities: ModelCapabilitiesV1,
  providerOverrides: Record<string, unknown> = {},
  modelOverrides: Record<string, unknown> = {},
) {
  return {
    ...base,
    modelProvidersJson: JSON.stringify([
      {
        id: "acme",
        api: "responses",
        wireProfile: "openai",
        baseUrl: "https://api.acme.test/v1",
        apiKey: "fake-test-key",
        ...providerOverrides,
        models: [
          { id: "acme/model", upstreamModelId: "upstream-model", capabilities, ...modelOverrides },
        ],
      },
    ]),
  };
}

const input = {
  modelId: "acme/model",
  requestedModelId: null,
  modelSource: "continuation",
  reasoningEffort: "medium",
  reasoningSource: "continuation",
  latencyMode: "standard",
  latencyModeSource: "continuation",
} as const;

describe("accepted execution policy additive capabilities", () => {
  for (const [label, capabilities] of [
    ["Fast", { ...legacyCapabilities, latencyModes: [standard, fast] }],
    ["vision", { ...legacyCapabilities, inputModalities: ["text", "image"] }],
    [
      "Fast and vision",
      { ...legacyCapabilities, latencyModes: [standard, fast], inputModalities: ["text", "image"] },
    ],
    [
      "multiple modes and input modalities",
      {
        ...legacyCapabilities,
        latencyModes: [priority, fast, standard],
        inputModalities: ["audio", "image", "text"],
      },
    ],
  ] satisfies Array<[string, ModelCapabilitiesV1]>) {
    test(`keeps an accepted Standard policy runnable after adding ${label}`, () => {
      const accepted = resolveTurnExecutionPolicyV1(registrySettings(legacyCapabilities), input);
      const before = structuredClone(accepted);
      const current = registrySettings(capabilities);
      const newer = resolveTurnExecutionPolicyV1(current, input);
      expect(newer.definitionVersion).not.toBe(accepted.definitionVersion);
      const verified = assertTurnExecutionPolicyMatchesConfigV1(current, accepted, input);
      expect(verified.policy).toEqual(before);
      expect(accepted).toEqual(before);
      expect(
        serviceTierForLatencyMode(verified.provider.id, verified.policy.latencyMode),
      ).toBeUndefined();
      expect(() =>
        assertTurnExecutionPolicyMatchesConfigV1(
          registrySettings(legacyCapabilities),
          newer,
          input,
        ),
      ).toThrow(TurnExecutionPolicyDefinitionMismatchError);
    });
  }

  test("preserves a frozen Fast request tier when another latency mode is added", () => {
    const capabilities = { ...legacyCapabilities, latencyModes: [standard, fast] };
    const fastInput = { ...input, latencyMode: "fast" as const };
    const accepted = resolveTurnExecutionPolicyV1(registrySettings(capabilities), fastInput);
    const current = registrySettings({ ...capabilities, latencyModes: [standard, priority, fast] });
    const verified = assertTurnExecutionPolicyMatchesConfigV1(current, accepted, fastInput);
    expect(verified.policy).toEqual(accepted);
    expect(serviceTierForLatencyMode(verified.provider.id, verified.policy.latencyMode)).toBe(
      "fast",
    );
    expect(() => assertTurnExecutionPolicyMatchesConfigV1(current, accepted, input)).toThrow(
      "accepted turn model/reasoning/latency",
    );
  });

  for (const slug of ["gpt-6.1-sol", "gpt-6-luna"]) {
    for (const source of ["document", "resolved JSON"] as const) {
      test(`retains the pre-repair ${slug} policy against the repaired ${source} catalog`, () => {
        const model = {
          id: `codex/${slug}`,
          upstreamModelId: slug,
          capabilities: legacyCapabilities,
        };
        // An explicit static provider represents the pre-rollout worker definition.
        // It deliberately bypasses today's catalog repair when accepting this fixture.
        const historicalProviders = JSON.parse(withCodexCatalogProvider(base).modelProvidersJson);
        historicalProviders.find(
          (provider: { id: string }) => provider.id === "codex-subscription",
        ).models = [model];
        const historical = { ...base, modelProvidersJson: JSON.stringify(historicalProviders) };
        const codexInput = { ...input, modelId: model.id };
        const accepted = resolveTurnExecutionPolicyV1(historical, codexInput);
        const current =
          source === "document"
            ? applyModelCatalogDocument(base, {
                schemaVersion: 1,
                builtInModels: ["gpt-6-luna"],
                codexModels: [model],
              })
            : { ...base, resolvedCodexModelsJson: JSON.stringify([model]) };
        expect(resolveTurnExecutionPolicyV1(current, codexInput).definitionVersion).not.toBe(
          accepted.definitionVersion,
        );
        const verified = assertTurnExecutionPolicyMatchesConfigV1(current, accepted, codexInput);
        expect(verified.policy).toEqual(accepted);
        expect(verified.model.capabilities.inputModalities).toEqual(["text", "image"]);
        expect(verified.model.capabilities.latencyModes).toContainEqual(
          expect.objectContaining({ id: "fast", runnable: true }),
        );
        expect(settingsForAcceptedSubscriptionTurn(current, accepted, codexInput)).toBe(current);
        expect(
          serviceTierForLatencyMode(verified.provider.id, verified.policy.latencyMode),
        ).toBeUndefined();
      });
    }
  }

  test("rejects removed or disabled frozen modes and removed unselected capabilities", () => {
    const capabilities: ModelCapabilitiesV1 = {
      ...legacyCapabilities,
      inputModalities: ["text", "image"],
      latencyModes: [standard, fast],
    };
    const accepted = resolveTurnExecutionPolicyV1(registrySettings(capabilities), input);
    for (const removed of [
      { ...capabilities, inputModalities: ["text"] as const },
      { ...capabilities, latencyModes: [standard] },
    ]) {
      expect(() =>
        assertTurnExecutionPolicyMatchesConfigV1(
          registrySettings({ ...removed, inputModalities: [...removed.inputModalities] }),
          accepted,
          input,
        ),
      ).toThrow(TurnExecutionPolicyDefinitionMismatchError);
    }
    for (const latencyModes of [[fast], [{ ...standard, runnable: false }, fast]]) {
      expect(() =>
        assertTurnExecutionPolicyMatchesConfigV1(
          registrySettings({ ...capabilities, latencyModes }),
          accepted,
          input,
        ),
      ).toThrow(UnsupportedLatencyModeError);
    }
  });

  test("rejects changed existing mode declarations, even when adding another mode", () => {
    const accepted = resolveTurnExecutionPolicyV1(
      registrySettings({ ...legacyCapabilities, latencyModes: [standard, fast] }),
      input,
    );
    for (const latencyModes of [
      [{ ...standard, upstream: "supported" as const }, fast, priority],
      [standard, { ...fast, billingMultiplierBps: 30_000 }, priority],
      [standard, { ...fast, runnable: false }, priority],
      [standard, { ...fast, id: "priority" as const }],
    ]) {
      expect(() =>
        assertTurnExecutionPolicyMatchesConfigV1(
          registrySettings({ ...legacyCapabilities, latencyModes }),
          accepted,
          input,
        ),
      ).toThrow(TurnExecutionPolicyDefinitionMismatchError);
    }
  });

  test("does not mask provider, routing, auth, billing, limits, pricing, or other capability drift", () => {
    const accepted = resolveTurnExecutionPolicyV1(registrySettings(legacyCapabilities), input);
    const additive: ModelCapabilitiesV1 = {
      ...legacyCapabilities,
      inputModalities: ["text", "image"],
      latencyModes: [standard, fast],
    };
    const drifts = [
      registrySettings(additive, { id: "other" }),
      registrySettings(additive, { baseUrl: "https://other.example/v1" }),
      registrySettings(additive, { api: "chat" }),
      registrySettings(additive, { wireProfile: "azure-openai" }),
      registrySettings(additive, { kind: "anonymous", apiKey: undefined }),
      registrySettings(additive, {
        defaultHeaders: { "x-version": "v2" },
        publicDefaultHeaderNames: ["x-version"],
      }),
      registrySettings(additive, {
        defaultQuery: { version: "v2" },
        publicDefaultQueryNames: ["version"],
      }),
      registrySettings(additive, {}, { upstreamModelId: "other-model" }),
      registrySettings(additive, {}, { contextWindowTokens: 200_000 }),
      registrySettings(additive, {}, { effectiveContextWindowTokens: 180_000 }),
      registrySettings(additive, {}, { autoCompactTokenLimit: 160_000 }),
      registrySettings(additive, {}, { toolOutputTruncationTokens: 9000 }),
      registrySettings(
        additive,
        {},
        {
          pricing: {
            inputMicrosPerMillionTokens: 10,
            cachedInputMicrosPerMillionTokens: 2,
            outputMicrosPerMillionTokens: 30,
          },
        },
      ),
      registrySettings({
        ...additive,
        reasoning: { ...additive.reasoning, required: !additive.reasoning.required },
      }),
      registrySettings({ ...additive, functionCalling: { upstream: "unknown", runnable: false } }),
      registrySettings({
        ...additive,
        transports: { ...additive.transports, sse: { upstream: "unknown", runnable: false } },
      }),
    ];
    for (const [index, current] of drifts.entries()) {
      expect(
        () => assertTurnExecutionPolicyMatchesConfigV1(current, accepted, input),
        `drift ${index}`,
      ).toThrow();
    }
    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(
        registrySettings(additive),
        { ...accepted, definitionVersion: `sha256:${"f".repeat(64)}` },
        input,
      ),
    ).toThrow(TurnExecutionPolicyDefinitionMismatchError);
    for (const changed of [
      {
        credentialSource: { kind: "workspace_connection" as const, mechanism: "api_key" as const },
      },
      { billing: { upstreamPayer: "workspace" as const, metering: "external" as const } },
    ]) {
      expect(() =>
        assertTurnExecutionPolicyMatchesConfigV1(
          registrySettings(additive),
          { ...accepted, ...changed },
          input,
        ),
      ).toThrow("current provider definition");
    }
  });

  test("does not compose additive matching with the historical wire-profile migration", () => {
    const current = withCodexCatalogProvider(base);
    const codexInput = { ...input, modelId: "codex/gpt-6-sol", reasoningEffort: "xhigh" as const };
    const policy = resolveTurnExecutionPolicyV1(current, codexInput);
    const historical = {
      ...policy,
      definitionVersion: "sha256:f5b77d051ec405ddfcb45815ed1b14a8e07aef33632009eac2689407b1c48194",
    };
    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(current, historical, codexInput),
    ).not.toThrow();
    const providers = JSON.parse(current.modelProvidersJson);
    const model = providers
      .find((provider: { id: string }) => provider.id === "codex-subscription")
      .models.find((candidate: { id: string }) => candidate.id === codexInput.modelId);
    model.capabilities.inputModalities.push("audio");
    expect(() =>
      assertTurnExecutionPolicyMatchesConfigV1(
        { ...current, modelProvidersJson: JSON.stringify(providers) },
        historical,
        codexInput,
      ),
    ).toThrow(TurnExecutionPolicyDefinitionMismatchError);
  });
});
