import { describe, expect, test } from "bun:test";
import {
  applyModelCatalogDocument,
  assertTurnExecutionPolicyMatchesConfigV1,
  configuredModels,
  getSettings,
  responseSatisfiesLatencyMode,
  resolveTurnExecutionPolicyV1,
  serviceTierForLatencyMode,
  UnsupportedLatencyModeError,
  withCodexCatalogProvider,
  type ModelCapabilitiesV1,
} from "../src";

const base = getSettings({ OPENGENI_ENV: "test", OPENGENI_CODEX_SUBSCRIPTION_ENABLED: "true" });
const legacyCapabilities: ModelCapabilitiesV1 = {
  ...configuredModels(base)[0]!.capabilities,
  inputModalities: ["text" as const],
  latencyModes: [{ id: "standard" as const, upstream: "unknown" as const, runnable: true }],
};

function catalogModel(slug: string, capabilities: ModelCapabilitiesV1 = legacyCapabilities) {
  return { id: `codex/${slug}`, upstreamModelId: slug, label: slug, capabilities };
}

function policy(
  settings: typeof base,
  modelId: string,
  latencyMode: "standard" | "fast" | "priority" | "ultrafast",
) {
  return resolveTurnExecutionPolicyV1(settings, {
    modelId,
    requestedModelId: modelId,
    modelSource: "explicit",
    reasoningEffort: "medium",
    reasoningSource: "explicit",
    latencyMode,
    latencyModeSource: "explicit",
  });
}

describe("Codex live and resolved catalog fast capabilities", () => {
  for (const slug of ["gpt-6.1-sol", "gpt-6-luna"]) {
    for (const source of ["document", "resolved JSON"] as const) {
      test(`${slug} repairs missing fast/vision in ${source} and freezes priority wire routing`, () => {
        const model = catalogModel(slug);
        const settings =
          source === "document"
            ? applyModelCatalogDocument(base, {
                schemaVersion: 1,
                builtInModels: ["gpt-6-luna"],
                codexModels: [model],
              })
            : { ...base, resolvedCodexModelsJson: JSON.stringify([model]) };
        const actual = configuredModels(withCodexCatalogProvider(settings)).find(
          (candidate) => candidate.id === model.id,
        )!;
        expect(actual.capabilities.inputModalities).toEqual(["text", "image"]);
        expect(actual.capabilities.structuredOutput).toEqual({
          upstream: "supported",
          runnable: true,
        });
        expect(actual.capabilities.latencyModes).toContainEqual(
          expect.objectContaining({ id: "fast", upstream: "supported", runnable: true }),
        );
        expect(policy(settings, model.id, "fast")).toMatchObject({
          productModelId: model.id,
          upstreamModelId: slug,
          providerId: "codex-subscription",
          latencyMode: "fast",
        });
        expect(serviceTierForLatencyMode("codex-subscription", "fast")).toBe("priority");
        expect(serviceTierForLatencyMode("openai", "fast")).toBe("fast");
        expect(serviceTierForLatencyMode("codex-subscription", "standard")).toBeUndefined();
        if (source === "document") {
          expect(
            JSON.parse(settings.resolvedCodexModelsJson!)[0].capabilities.latencyModes,
          ).toContainEqual(expect.objectContaining({ id: "fast", runnable: true }));
        }
      });
    }
  }

  test("does not broaden unknown models, explicit fast restrictions, or retired membership", () => {
    const restricted = {
      ...legacyCapabilities,
      structuredOutput: { upstream: "unsupported" as const, runnable: false },
      latencyModes: [
        ...legacyCapabilities.latencyModes,
        { id: "fast" as const, upstream: "unsupported" as const, runnable: false },
      ],
    };
    const settings = applyModelCatalogDocument(base, {
      schemaVersion: 1,
      builtInModels: ["gpt-6-luna"],
      codexModels: [
        catalogModel("unknown-model"),
        catalogModel("gpt-6-luna", restricted),
        { ...catalogModel("gpt-6.1-sol"), retired: true },
      ],
    });
    const models = configuredModels(withCodexCatalogProvider(settings));
    expect(models.find((model) => model.id === "codex/unknown-model")?.capabilities).toMatchObject({
      inputModalities: ["text"],
      structuredOutput: { upstream: "unknown", runnable: false },
      latencyModes: legacyCapabilities.latencyModes,
    });
    expect(
      models.find((model) => model.id === "codex/gpt-6-luna")?.capabilities.structuredOutput,
    ).toEqual({ upstream: "unsupported", runnable: false });
    expect(() => policy(settings, "codex/gpt-6-luna", "fast")).toThrow(UnsupportedLatencyModeError);
    expect(() => policy(settings, "codex/unknown-model", "priority")).toThrow(
      UnsupportedLatencyModeError,
    );
    expect(models.some((model) => model.id === "codex/gpt-6.1-sol")).toBe(false);
  });

  test("built-in GPT-6 point releases accept vision and fast", () => {
    const settings = { ...base, openaiModel: "gpt-6.1-sol", openaiAllowedModels: "gpt-6.1-sol" };
    expect(configuredModels(settings)[0]!.capabilities.inputModalities).toEqual(["text", "image"]);
    expect(policy(settings, "gpt-6.1-sol", "fast").latencyMode).toBe("fast");
  });
});

describe("Ultrafast", () => {
  const codexDocument = (slug: string, capabilities = legacyCapabilities) =>
    withCodexCatalogProvider(
      applyModelCatalogDocument(base, {
        schemaVersion: 1,
        builtInModels: ["gpt-6-luna"],
        codexModels: [catalogModel(slug, capabilities)],
      }),
    );

  for (const slug of ["gpt-6.1-sol", "gpt-6-astra"]) {
    test(`${slug} declares Ultrafast at 6× and routes it as service_tier ultrafast`, () => {
      const settings = codexDocument(slug);
      const model = configuredModels(settings).find(
        (candidate) => candidate.id === `codex/${slug}`,
      )!;
      expect(model.capabilities.latencyModes.map((mode) => mode.id)).toEqual([
        "standard",
        "fast",
        "ultrafast",
      ]);
      expect(model.capabilities.latencyModes.at(-1)).toEqual({
        id: "ultrafast",
        upstream: "supported",
        runnable: true,
        billingMultiplierBps: 60_000,
      });
      expect(policy(settings, `codex/${slug}`, "ultrafast")).toMatchObject({
        upstreamModelId: slug,
        providerId: "codex-subscription",
        latencyMode: "ultrafast",
      });
    });
  }

  test("models OpenAI does not serve at the tier never offer it", () => {
    const settings = codexDocument("gpt-6-luna");
    const luna = configuredModels(settings).find((model) => model.id === "codex/gpt-6-luna")!;
    expect(luna.capabilities.latencyModes.map((mode) => mode.id)).toEqual(["standard", "fast"]);
    expect(() => policy(settings, "codex/gpt-6-luna", "ultrafast")).toThrow(
      UnsupportedLatencyModeError,
    );
  });

  test("an explicit catalog restriction is preserved", () => {
    const restricted = {
      ...legacyCapabilities,
      latencyModes: [
        ...legacyCapabilities.latencyModes,
        { id: "ultrafast" as const, upstream: "unsupported" as const, runnable: false },
      ],
    };
    const settings = codexDocument("gpt-6.1-sol", restricted);
    expect(() => policy(settings, "codex/gpt-6.1-sol", "ultrafast")).toThrow(
      UnsupportedLatencyModeError,
    );
  });

  test("the built-in API model offers it too", () => {
    const settings = { ...base, openaiModel: "gpt-6.1-sol", openaiAllowedModels: "gpt-6.1-sol" };
    expect(policy(settings, "gpt-6.1-sol", "ultrafast").latencyMode).toBe("ultrafast");
  });

  test("wire tier and response verification are exact", () => {
    for (const provider of ["codex-subscription", "openai", "azure"]) {
      expect(serviceTierForLatencyMode(provider, "ultrafast")).toBe("ultrafast");
    }
    expect(responseSatisfiesLatencyMode("ultrafast", "ultrafast")).toBe(true);
    expect(responseSatisfiesLatencyMode("ultrafast", "priority")).toBe(false);
    expect(responseSatisfiesLatencyMode("ultrafast", "fast")).toBe(false);
    expect(responseSatisfiesLatencyMode("fast", "ultrafast")).toBe(false);
  });

  test("turns accepted before Ultrafast was declared stay runnable", () => {
    const current = codexDocument("gpt-6.1-sol");
    const before = codexDocument("gpt-6.1-sol", {
      ...legacyCapabilities,
      latencyModes: [
        { id: "standard", upstream: "supported", runnable: true },
        { id: "fast", upstream: "supported", runnable: true, billingMultiplierBps: 20_000 },
        { id: "ultrafast", upstream: "unsupported", runnable: false },
      ],
    });
    // The pre-Ultrafast declaration is the current one with the mode absent.
    const providers = JSON.parse(current.modelProvidersJson);
    for (const model of providers[0].models) {
      model.capabilities.latencyModes = model.capabilities.latencyModes.filter(
        (mode: { id: string }) => mode.id !== "ultrafast",
      );
    }
    const historical = { ...current, modelProvidersJson: JSON.stringify(providers) };
    for (const latencyMode of ["standard", "fast"] as const) {
      const accepted = policy(historical, "codex/gpt-6.1-sol", latencyMode);
      expect(accepted.definitionVersion).not.toBe(
        policy(current, "codex/gpt-6.1-sol", latencyMode).definitionVersion,
      );
      expect(
        assertTurnExecutionPolicyMatchesConfigV1(current, accepted, {
          modelId: "codex/gpt-6.1-sol",
          requestedModelId: "codex/gpt-6.1-sol",
          modelSource: "explicit",
          reasoningEffort: "medium",
          reasoningSource: "explicit",
          latencyMode,
          latencyModeSource: "explicit",
        }).policy,
      ).toEqual(accepted);
    }
    expect(() => policy(before, "codex/gpt-6.1-sol", "ultrafast")).toThrow(
      UnsupportedLatencyModeError,
    );
  });
});
