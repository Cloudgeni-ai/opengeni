import { describe, expect, test } from "bun:test";
import {
  applyModelCatalogDocument,
  configuredModels,
  getSettings,
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
  latencyMode: "standard" | "fast" | "priority",
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
      latencyModes: legacyCapabilities.latencyModes,
    });
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
