import { expect, test } from "bun:test";
import {
  selectSubscriptionAccount,
  subscriptionAccountShardIndex,
} from "../src/subscription-account-selection";

const accounts = [{ id: "a" }, { id: "b" }, { id: "c" }];
const base = {
  sessionId: "session-fixture",
  eligible: accounts,
  rotationEnabled: true,
  activeCredentialId: "a",
  pinnedCredentialId: null,
  pinSource: null,
} as const;

test("deterministic UTF-16 FNV account assignment preserves the existing providers' mapping", () => {
  expect(subscriptionAccountShardIndex("", 10)).toBe(1);
  expect(subscriptionAccountShardIndex("a", 10)).toBe(0);
  expect(subscriptionAccountShardIndex("hello", 10)).toBe(3);
  for (const count of [1, 2, 3, 7, 256]) {
    const index = subscriptionAccountShardIndex("session-fixture", count);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(count);
    expect(index).toBe(subscriptionAccountShardIndex("session-fixture", count));
  }
  for (const count of [0, -1, 1.1, NaN, Infinity])
    expect(() => subscriptionAccountShardIndex("x", count)).toThrow();
});

test.each([true, false])(
  "manual and legacy unlabelled pins never move, rotation=%s",
  (rotationEnabled) => {
    for (const pinSource of ["manual", null] as const) {
      expect(
        selectSubscriptionAccount({ ...base, rotationEnabled, pinnedCredentialId: "b", pinSource })
          ?.id,
      ).toBe("b");
      expect(
        selectSubscriptionAccount({
          ...base,
          rotationEnabled,
          pinnedCredentialId: "unavailable",
          pinSource,
        }),
      ).toBeNull();
    }
  },
);

test("healthy policy affinity survives pool membership changes; failed homes re-shard", () => {
  expect(
    selectSubscriptionAccount({ ...base, pinnedCredentialId: "b", pinSource: "policy" })?.id,
  ).toBe("b");
  expect(
    selectSubscriptionAccount({
      ...base,
      eligible: [...accounts, { id: "d" }],
      pinnedCredentialId: "b",
      pinSource: "policy",
    })?.id,
  ).toBe("b");
  const survivors = [accounts[0]!, accounts[2]!];
  expect(
    selectSubscriptionAccount({
      ...base,
      eligible: survivors,
      pinnedCredentialId: "b",
      pinSource: "policy",
    }),
  ).toBe(survivors[subscriptionAccountShardIndex(base.sessionId, 2)]!);
});

test("rotation off ignores stale policy pins and never silently substitutes another active account", () => {
  expect(
    selectSubscriptionAccount({
      ...base,
      rotationEnabled: false,
      pinnedCredentialId: "b",
      pinSource: "policy",
    })?.id,
  ).toBe("a");
  expect(
    selectSubscriptionAccount({
      ...base,
      rotationEnabled: false,
      activeCredentialId: "unavailable",
    }),
  ).toBeNull();
  expect(selectSubscriptionAccount({ ...base, eligible: [] })).toBeNull();
});
