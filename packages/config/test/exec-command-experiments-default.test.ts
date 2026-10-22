import { expect, test } from "bun:test";
import { getSettings } from "../src";

test("cut polling and lean exec_command arguments are on by default and can be turned off", () => {
  const defaults = getSettings({ OPENGENI_ENV: "test" });
  expect(defaults.experimentCutPolling).toBe(true);
  expect(defaults.experimentOutputCost).toBe(true);
  const disabled = getSettings({
    OPENGENI_ENV: "test",
    OPENGENI_EXPERIMENT_CUT_POLLING: "false",
    OPENGENI_EXPERIMENT_OUTPUT_COST: "0",
  });
  expect(disabled.experimentCutPolling).toBe(false);
  expect(disabled.experimentOutputCost).toBe(false);
});
