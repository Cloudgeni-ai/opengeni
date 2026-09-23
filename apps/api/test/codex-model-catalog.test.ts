import { describe, expect, test } from "bun:test";
import { codexModelsForPicker } from "../src/routes/codex";
import {
  applyModelCatalogDocument,
  configuredModels,
  getSettings,
  withCodexCatalogProvider,
} from "@opengeni/config";

describe("Codex model catalog", () => {
  const expected = ["codex/gpt-6-sol", "codex/gpt-6-luna", "codex/gpt-6-astra"];

  test("always returns the static approved catalog including Astra", () => {
    const models = codexModelsForPicker();

    expect(models.map((model) => model.id)).toEqual(expected);
    expect(models.at(-1)?.label).toBe("GPT-6 Astra");
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
