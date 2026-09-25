import { describe, expect, test } from "bun:test";
import { getSettings } from "../src";

describe("credits default model settings", () => {
  test("default to GPT-6 Luna at extra high reasoning", () => {
    const settings = getSettings({});
    expect(settings.creditsDefaultModel).toBe("gpt-6-luna");
    expect(settings.creditsDefaultReasoningEffort).toBe("xhigh");
  });

  test("are deployment-configurable", () => {
    const settings = getSettings({
      OPENGENI_CREDITS_DEFAULT_MODEL: " gpt-6-sol ",
      OPENGENI_CREDITS_DEFAULT_REASONING_EFFORT: "high",
    });
    expect(settings.creditsDefaultModel).toBe("gpt-6-sol");
    expect(settings.creditsDefaultReasoningEffort).toBe("high");
  });

  test("reject an unknown effort or a malformed model id at boot", () => {
    expect(() => getSettings({ OPENGENI_CREDITS_DEFAULT_REASONING_EFFORT: "extreme" })).toThrow();
    expect(() => getSettings({ OPENGENI_CREDITS_DEFAULT_MODEL: "gpt-6-luna|other" })).toThrow();
  });
});
