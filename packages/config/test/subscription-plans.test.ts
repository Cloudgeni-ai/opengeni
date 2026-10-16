import { expect, test } from "bun:test";
import { getSettings } from "../src";

test("subscription plan service paths are default-off and explicitly configurable", () => {
  expect(getSettings({}).subscriptionPlansEnabled).toBe(false);
  expect(
    getSettings({ OPENGENI_SUBSCRIPTION_PLANS_ENABLED: "false" }).subscriptionPlansEnabled,
  ).toBe(false);
  expect(
    getSettings({ OPENGENI_SUBSCRIPTION_PLANS_ENABLED: "true" }).subscriptionPlansEnabled,
  ).toBe(true);
  expect(() => getSettings({ OPENGENI_SUBSCRIPTION_PLANS_ENABLED: "maybe" })).toThrow();
});
