import { expect, test } from "bun:test";
import { ownSubscriptionUpgradePlan } from "../src/billing-origin";

const plan = (key: string, monthlyPriceMicros: number | null, selfService = true) => ({
  key,
  label: key[0]!.toUpperCase() + key.slice(1),
  monthlyPriceMicros,
  selfService,
});

test("names the cheapest self-service plan that includes own subscriptions", () => {
  expect(
    ownSubscriptionUpgradePlan([
      plan("free", 0, false),
      plan("max", 200_000_000),
      plan("pro", 20_000_000),
      plan("enterprise", null, false),
    ])?.key,
  ).toBe("pro");
});

test("follows the catalog's price, never a fixed plan name", () => {
  // A repriced catalog: Pro below the $20 floor no longer includes them.
  expect(
    ownSubscriptionUpgradePlan([
      plan("free", 0, false),
      plan("pro", 15_000_000),
      plan("team", 30_000_000),
    ]),
  ).toEqual(plan("team", 30_000_000));
});

test("is null when the catalog sells no such plan", () => {
  expect(
    ownSubscriptionUpgradePlan([plan("free", 0, false), plan("enterprise", null, false)]),
  ).toBe(null);
  expect(ownSubscriptionUpgradePlan([plan("pro", 20_000_000, false)])).toBe(null);
});
