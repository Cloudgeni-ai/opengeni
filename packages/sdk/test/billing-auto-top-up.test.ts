import { expect, test } from "bun:test";
import { BillingAutoTopUpSettings, UpdateBillingAutoTopUpRequest } from "@opengeni/contracts";
import { OpenGeniClient } from "../src/client";
import type { BillingAutoTopUpSettings as SdkSettings } from "../src";

const accountId = "7d6c2b1e-4a5f-4e3d-9c8b-1a2b3c4d5e6f";
test("automatic top-up SDK preserves exact API shapes and explicit account/key", async () => {
  const calls: unknown[] = [];
  const settings: SdkSettings = {
    accountId,
    enabled: false,
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: 100_000_000,
    spentThisMonthMicros: 0,
    status: "off",
    paymentMethod: null,
  };
  const client = new OpenGeniClient({
    baseUrl: "https://api.example.test",
    apiKey: "test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json(
        url.pathname.endsWith("/setup") ? { url: "https://checkout.stripe.test/setup" } : settings,
      );
    },
  });
  const request = UpdateBillingAutoTopUpRequest.parse({
    accountId,
    enabled: true,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(BillingAutoTopUpSettings.parse(await client.getBillingAutoTopUp({ accountId }))).toEqual(
    settings,
  );
  await client.updateBillingAutoTopUp(request);
  const setup = {
    accountId,
    idempotencyKey: crypto.randomUUID(),
    successUrl: "https://app.example.test/billing",
  };
  await client.createBillingAutoTopUpSetupSession(setup);
  expect(calls).toEqual([
    { path: `/v1/billing/auto-top-up?accountId=${accountId}`, method: "GET", body: null },
    { path: "/v1/billing/auto-top-up", method: "PUT", body: request },
    { path: "/v1/billing/auto-top-up/setup", method: "POST", body: setup },
  ]);
});
test("whole USD cents, sensible bounds and explicit opt-in are required", () => {
  const base = { enabled: true, idempotencyKey: crypto.randomUUID() };
  expect(UpdateBillingAutoTopUpRequest.parse(base)).toMatchObject({
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: 100_000_000,
  });
  for (const change of [
    { enabled: undefined },
    { amountMicros: 25_000_001 },
    { thresholdMicros: 0.1 },
    { amountMicros: 0 },
    { monthlyCapMicros: 5_000_000 },
    { idempotencyKey: "retry" },
    { paymentMethodId: "pm_attacker" },
  ]) {
    expect(() => UpdateBillingAutoTopUpRequest.parse({ ...base, ...change })).toThrow();
  }
});
