import { expect, test } from "bun:test";
import { creditScopeFromMetadata, creditScopeMetadata } from "../src/credit-promotion-snapshot";

test("freezes and round-trips a large offer within Stripe metadata limits", () => {
  const scope = {
    label: "Welcome credits",
    eligibleModelIds: Array.from({ length: 40 }, (_, i) => `model-${i}-${"a".repeat(180)}`),
  };
  const metadata = creditScopeMetadata(scope);
  expect(Object.keys(metadata).length).toBeLessThan(30);
  expect(Object.values(metadata).every((value) => value.length <= 500)).toBe(true);
  expect(creditScopeFromMetadata(metadata)).toEqual(scope);
});
test("legacy checkouts remain unrestricted; corrupt scopes fail closed", () => {
  expect(creditScopeFromMetadata({ opengeni_account_id: "legacy" })).toBeUndefined();
  expect(() =>
    creditScopeFromMetadata({ opengeni_credit_scope_v1: "2", opengeni_credit_scope_0: "{}" }),
  ).toThrow();
  expect(() => creditScopeFromMetadata({ opengeni_credit_scope_0: "{}" })).toThrow();
  expect(() =>
    creditScopeFromMetadata({ opengeni_credit_scope_v1: "1", opengeni_credit_scope_0: "{}" }),
  ).toThrow();
});
