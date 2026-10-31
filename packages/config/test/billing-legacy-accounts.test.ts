import { expect, test } from "bun:test";
import { DEFAULT_BILLING_LEGACY_ACCOUNT_IDS, getSettings, isLegacyBillingAccount } from "../src";

const CLOUDGENI = "25eacc5d-f383-4f79-910a-b3d11dbf1310";
// Our own team's organizations: production, then staging.
const TEAM = [
  "67435f59-7f73-4996-8845-cd7baa2b7268",
  "9d533546-b4a8-48e1-b9de-1b56c7ce0e50",
  "7ee4f92f-dd65-4ac1-888e-e53d9b5f5b3b",
  "d8afe24f-b593-463f-8f70-249e067a73ba",
  "d955c979-cf01-4ee7-b130-8306cf099642",
  "2c9e60c8-d1d3-4d3d-849c-59a876488cf1",
  "049d0b24-7665-4dbe-a7d8-4c2dc8e5674c",
];

test("internal accounts (CloudGeni and our team) keep legacy billing without any configuration", () => {
  const settings = getSettings({});
  expect(DEFAULT_BILLING_LEGACY_ACCOUNT_IDS).toEqual([CLOUDGENI, ...TEAM]);
  expect(settings.billingLegacyAccountIds).toEqual([CLOUDGENI, ...TEAM]);
  for (const id of [CLOUDGENI, ...TEAM]) {
    expect(id).toBe(id.toLowerCase());
    expect(isLegacyBillingAccount(settings, id)).toBe(true);
    expect(isLegacyBillingAccount(settings, id.toUpperCase())).toBe(true);
    // The built-in list applies even to settings that carry no list.
    expect(isLegacyBillingAccount({ billingLegacyAccountIds: undefined }, id)).toBe(true);
  }
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
