import { expect, test } from "bun:test";
import { SubscriptionPlanCatalog } from "../src/subscription-plans";

const plan = (key: string, stripePriceId: string, legacyStripePriceIds?: unknown) => ({
  key,
  label: key,
  stripePriceId,
  monthlyPriceMicros: 20_000_000,
  monthlyCreditMicros: 200_000_000,
  seatLimit: 10,
  freeCredit: false,
  ...(legacyStripePriceIds === undefined ? {} : { legacyStripePriceIds }),
});

test("legacy price IDs are optional, bounded, and unique across current and historical plan prices", () => {
  expect(
    SubscriptionPlanCatalog.parse([plan("pro", "price_new")])[0]!.legacyStripePriceIds,
  ).toBeUndefined();
  expect(
    SubscriptionPlanCatalog.parse([plan("pro", "price_new", ["price_old"])])[0]!
      .legacyStripePriceIds,
  ).toEqual(["price_old"]);
  for (const entries of [
    [plan("pro", "price_new", ["price_new"])],
    [plan("pro", "price_new", ["price_old", "price_old"])],
    [plan("pro", "price_new", ["price_old"]), plan("max", "price_old")],
    [plan("pro", "price_new", ["price_old"]), plan("max", "price_max", ["price_old"])],
    [plan("pro", "price_new", [" price_old "]), plan("max", "price_old")],
    ...[
      null,
      "price_old",
      [null],
      [1],
      [""],
      ["x".repeat(201)],
      Array.from({ length: 101 }, (_, n) => `price_${n}`),
    ].map((value) => [plan("pro", "price_new", value)]),
  ])
    expect(SubscriptionPlanCatalog.safeParse(entries).success).toBe(false);
});
