import { expect, test } from "bun:test";
import { getSettings } from "../src";

test("the system-prompt cache split is on by default and can be turned off", () => {
  expect(getSettings({ OPENGENI_ENV: "test" }).experimentSystemPromptCacheSplit).toBe(true);
  expect(
    getSettings({ OPENGENI_ENV: "test", OPENGENI_EXPERIMENT_SYSTEM_PROMPT_CACHE_SPLIT: "false" })
      .experimentSystemPromptCacheSplit,
  ).toBe(false);
});
