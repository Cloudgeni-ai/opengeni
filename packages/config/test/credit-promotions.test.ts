import { expect, test } from "bun:test";
import {
  EnvCreditPromotionPolicy,
  promotionalCreditScope,
  signupCreditModelIds,
} from "../src/credit-promotions";

test("defaults apply to signup and offers, with separate offer overrides", () => {
  const settings = {
    creditPromotionPolicy: EnvCreditPromotionPolicy.parse(
      JSON.stringify({
        defaultModelIds: ["model-a"],
        offers: {
          coupon_shared: { label: "Launch credits" },
          coupon_override: { label: "Another offer", eligibleModelIds: ["model-b"] },
        },
      }),
    ),
  };
  expect(signupCreditModelIds(settings)).toEqual(["model-a"]);
  expect(promotionalCreditScope(settings, "coupon_shared")?.eligibleModelIds).toEqual(["model-a"]);
  expect(promotionalCreditScope(settings, "coupon_override")?.eligibleModelIds).toEqual([
    "model-b",
  ]);
  expect(promotionalCreditScope(settings, "another_coupon")?.eligibleModelIds).toEqual(["model-a"]);
});
test("unconfigured deployments preserve legacy behavior and invalid policies fail at startup", () => {
  const settings = { creditPromotionPolicy: EnvCreditPromotionPolicy.parse(undefined) };
  expect(signupCreditModelIds(settings)).toBeUndefined();
  expect(promotionalCreditScope(settings, "coupon")).toBeUndefined();
  for (const value of [
    "broken",
    '{"defaultModelIds":[]}',
    '{"offers":{"coupon":{"label":"Offer"}}}',
  ]) {
    expect(() => EnvCreditPromotionPolicy.parse(value)).toThrow();
  }
});
