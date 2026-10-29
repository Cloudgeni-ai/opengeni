import { expect, test } from "bun:test";
import { DEFAULT_BILLING_LEGACY_ACCOUNT_IDS, getSettings, isLegacyBillingAccount } from "../src";

const CLOUDGENI = "25eacc5d-f383-4f79-910a-b3d11dbf1310";

test("CloudGeni's host account keeps legacy billing without any configuration", () => {
  const settings = getSettings({});
  expect(DEFAULT_BILLING_LEGACY_ACCOUNT_IDS).toEqual([CLOUDGENI]);
  expect(settings.billingLegacyAccountIds).toEqual([CLOUDGENI]);
  expect(isLegacyBillingAccount(settings, CLOUDGENI)).toBe(true);
  expect(isLegacyBillingAccount(settings, CLOUDGENI.toUpperCase())).toBe(true);
  expect(isLegacyBillingAccount(settings, "00000000-0000-4000-8000-000000000001")).toBe(false);
  expect(isLegacyBillingAccount(settings, null)).toBe(false);
});

test("OPENGENI_BILLING_LEGACY_ACCOUNT_IDS replaces the list; none lists no account", () => {
  const other = "00000000-0000-4000-8000-000000000001";
  expect(
    getSettings({ OPENGENI_BILLING_LEGACY_ACCOUNT_IDS: ` ${other.toUpperCase()}, ${CLOUDGENI}` })
      .billingLegacyAccountIds,
  ).toEqual([other, CLOUDGENI]);
  expect(
    getSettings({ OPENGENI_BILLING_LEGACY_ACCOUNT_IDS: "none" }).billingLegacyAccountIds,
  ).toEqual([]);
  expect(() => getSettings({ OPENGENI_BILLING_LEGACY_ACCOUNT_IDS: "not-a-uuid" })).toThrow();
});
