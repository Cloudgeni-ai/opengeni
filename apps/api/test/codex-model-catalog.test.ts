import { describe, expect, test } from "bun:test";
import { codexModelsForPicker } from "../src/routes/codex";

describe("Codex model catalog", () => {
  test("exposes only GPT-5.6 Sol, Terra, and Luna from a broader live catalog", () => {
    const models = codexModelsForPicker([
      "gpt-5.4",
      "gpt-5.6-luna",
      "gpt-5.3-codex",
      "gpt-5.6-sol",
      "o3-pro",
      "gpt-5.6-terra",
    ]);

    expect(models.map((model) => model.id)).toEqual([
      "codex/gpt-5.6-sol",
      "codex/gpt-5.6-terra",
      "codex/gpt-5.6-luna",
    ]);
  });

  test("does not fall back to older Codex models when GPT-5.6 is absent", () => {
    expect(codexModelsForPicker(["gpt-5.3-codex", "gpt-5.2-codex"])).toEqual([]);
  });
});