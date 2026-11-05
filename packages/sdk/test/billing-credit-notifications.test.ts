import { expect, test } from "bun:test";
import {
  BillingAlertSettings,
  UpdateBillingAlertSettingsRequest,
} from "@opengeni/contracts/billing-credit-notifications";
import { OpenGeniClient } from "../src/client";
import type { BillingAlertSettings as SdkSettings } from "../src/index";

test("billing alert SDK methods retain selected organization, exact verbs and micro-unit settings", async () => {
  const accountId = crypto.randomUUID(),
    id = crypto.randomUUID();
  const settings: SdkSettings = { accountId, lowBalanceThresholdMicros: 5_000_000 };
  const calls: unknown[] = [];
  const client = new OpenGeniClient({
    baseUrl: "https://api.test",
    apiKey: "test",
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(settings);
    },
  });
  expect(BillingAlertSettings.parse(await client.getBillingAlertSettings({ accountId }))).toEqual(
    settings,
  );
  await client.updateBillingAlertSettings(UpdateBillingAlertSettingsRequest.parse(settings));
  await client.listBillingCreditNotifications({ accountId });
  await client.markBillingCreditNotificationRead(id, { accountId });
  expect(calls).toEqual([
    { url: `https://api.test/v1/billing/alerts?accountId=${accountId}`, method: "GET", body: null },
    { url: "https://api.test/v1/billing/alerts", method: "PUT", body: settings },
    {
      url: `https://api.test/v1/billing/notifications?accountId=${accountId}`,
      method: "GET",
      body: null,
    },
    {
      url: `https://api.test/v1/billing/notifications/${id}/read?accountId=${accountId}`,
      method: "POST",
      body: null,
    },
  ]);
  expect(
    UpdateBillingAlertSettingsRequest.safeParse({ ...settings, lowBalanceThresholdMicros: 0 })
      .success,
  ).toBe(true);
  for (const bad of [-1, 0.1, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(
      UpdateBillingAlertSettingsRequest.safeParse({ ...settings, lowBalanceThresholdMicros: bad })
        .success,
    ).toBe(false);
});
