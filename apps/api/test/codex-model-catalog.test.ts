import { describe, expect, test } from "bun:test";
import { codexModelsForPicker } from "../src/routes/codex";

describe("Codex model catalog", () => {
  const expected = ["codex/gpt-5.6-sol", "codex/gpt-5.6-terra", "codex/gpt-5.6-luna"];

  test("keeps exactly the three exact GPT-5.6 slugs from a broader live catalog", () => {
    const models = codexModelsForPicker([
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.6-sol",
      "gpt-5.4",
      "gpt-5.6-terra",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
      "codex-auto-review",
    ]);

    expect(models.map((model) => model.id)).toEqual(expected);
  });

  test("an unrelated catalog fails closed instead of exposing older models", () => {
    expect(() =>
      codexModelsForPicker(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "codex-auto-review"]),
    ).toThrow("Codex catalog is missing required models");
  });

  test("an empty live catalog fails closed", () => {
    expect(() => codexModelsForPicker([])).toThrow("Codex catalog is missing required models");
  });
});
