import { describe, expect, test } from "bun:test";
import { codexModelsForPicker } from "../src/routes/codex";

describe("Codex model catalog", () => {
  const expected = [
    "codex/gpt-5.6-sol",
    "codex/gpt-5.6-terra",
    "codex/gpt-5.6-luna",
    "codex/gpt-6-astra",
  ];

  test("always returns the static approved catalog including Astra", () => {
    const models = codexModelsForPicker();

    expect(models.map((model) => model.id)).toEqual(expected);
    expect(models.at(-1)?.label).toBe("GPT-6 Astra");
  });
});
