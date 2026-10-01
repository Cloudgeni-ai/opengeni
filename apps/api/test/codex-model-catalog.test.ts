import { describe, expect, test } from "bun:test";
import { codexModelsForPicker } from "../src/routes/codex";
import {
  applyModelCatalogDocument,
  configuredModels,
  getSettings,
  withCodexCatalogProvider,
} from "@opengeni/config";

describe("Codex model catalog", () => {
  const expected = ["codex/gpt-6-astra", "codex/gpt-6-sol", "codex/gpt-6-luna"];

  test("always returns the static approved catalog including Astra", () => {
    const models = codexModelsForPicker();

    expect(models.map((model) => model.id)).toEqual(expected);
    expect(models.at(0)?.label).toBe("GPT-6 Astra");
  });

  test("live support filters exact upstream models, without prefix matching or invented rows", () => {
    const settings = getSettings({ OPENGENI_OPENAI_API_KEY: "test" });
    const capabilities = configuredModels(withCodexCatalogProvider(settings))[0]!.capabilities;
    const catalog = applyModelCatalogDocument(settings, {
      schemaVersion: 1,
      builtInModels: ["gpt-6-sol"],
      codexModels: [
        {
          id: "codex/gpt-6.1-sol",
          upstreamModelId: "gpt-6.1-sol",
          label: "GPT-6.1 Sol",
          capabilities,
        },
        { id: "codex/gpt-6-sol", upstreamModelId: "gpt-6-sol", label: "GPT-6 Sol", capabilities },
      ],
    });
    expect(codexModelsForPicker(catalog, ["gpt-6-sol", "unconfigured-model"])).toEqual([
      expect.objectContaining({ id: "codex/gpt-6-sol", label: "GPT-6 Sol" }),
    ]);
    expect(codexModelsForPicker(catalog, [])).toEqual([]);
    expect(codexModelsForPicker(catalog, ["gpt-6.1-sol"])[0]?.label).toBe("GPT-6.1 Sol");
  });

  test("connection picker honors configured membership and explicit removal", () => {
    const settings = getSettings({ OPENGENI_OPENAI_API_KEY: "test" });
    const capabilities = configuredModels(withCodexCatalogProvider(settings)).find((model) =>
      model.id.startsWith("codex/"),
    )!.capabilities;
    const document = {
      schemaVersion: 1,
      builtInModels: ["gpt-5.6-sol"],
      codexModels: [
        {
          id: "codex/test-model",
          upstreamModelId: "test-model",
          label: "Operator model",
          capabilities,
        },
      ],
    };
    expect(
      codexModelsForPicker(applyModelCatalogDocument(settings, document)).map((model) => model.id),
    ).toEqual(["codex/test-model"]);
    expect(
      codexModelsForPicker(applyModelCatalogDocument(settings, { ...document, codexModels: [] })),
    ).toEqual([]);
  });
});
