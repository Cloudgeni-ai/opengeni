import { describe, expect, test } from "bun:test";
import { getSettings, imageGenerationCreditCostMicros } from "../src";

describe("image generation credit pricing", () => {
  test("prices the default image model and accepts an operator price", () => {
    const settings = withEnv({}, getSettings);
    expect(settings.imageGenerationModel).toBe("openai/gpt-image-2");
    expect(settings.imageGenerationCreditMicrosPerImage).toBeUndefined();
    expect(imageGenerationCreditCostMicros(settings)).toBe(250_000);

    const priced = withEnv(
      {
        OPENGENI_IMAGE_GENERATION_MODEL: "example/other-image-model",
        OPENGENI_IMAGE_GENERATION_CREDIT_MICROS_PER_IMAGE: "400000",
      },
      getSettings,
    );
    expect(imageGenerationCreditCostMicros(priced)).toBe(400_000);
  });

  test("has no price for an unreviewed image model", () => {
    for (const imageGenerationModel of ["example/other-image-model", "constructor", "toString"]) {
      expect(
        imageGenerationCreditCostMicros({
          imageGenerationModel,
          imageGenerationCreditMicrosPerImage: undefined,
        }),
      ).toBeNull();
    }
  });

  test("rejects an unsafe operator price", () => {
    for (const value of ["0", "-1", "1.5", "10000001"]) {
      expect(() =>
        withEnv({ OPENGENI_IMAGE_GENERATION_CREDIT_MICROS_PER_IMAGE: value }, getSettings),
      ).toThrow();
    }
  });
});

function withEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  const original = process.env;
  process.env = { ...env };
  try {
    return run();
  } finally {
    process.env = original;
  }
}
