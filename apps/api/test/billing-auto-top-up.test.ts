import { expect, test } from "bun:test";
import Stripe from "stripe";
import type {
  AutoTopUpAccountStore,
  AutoTopUpOperation,
  AutoTopUpSettingsRow,
  AutoTopUpStore,
} from "@opengeni/db";
import { AutoTopUpStoreError } from "@opengeni/db";
import {
  StripeAutoTopUps,
  assertAutoTopUpPayment,
  decideAutoTopUp,
} from "../src/billing-auto-top-up";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing/settings";
import { registerBillingRoutes } from "../src/routes/billing";
import type { ApiRouteDeps } from "@opengeni/core";
import { requireAutoTopUpOwner } from "../src/routes/billing-auto-top-up";

const accountId = "7d6c2b1e-4a5f-4e3d-9c8b-1a2b3c4d5e6f";
function harness() {
  let settings: AutoTopUpSettingsRow = {
    account_id: accountId,
    enabled: true,
    threshold_micros: 10_000_000,
    amount_micros: 25_000_000,
    monthly_cap_micros: 100_000_000,
    consent_subject: "user:owner",
    consent_version: "off_session_threshold_v1",
    consent_at: new Date().toISOString(),
    provider: "stripe:test",
    customer_id: "cus_org",
    payment_method_id: "pm_card",
    payment_method_brand: "visa",
    payment_method_last4: "4242",
    setup_key: null,
    setup_subject: null,
    failure_reason: null,
    cap_required_micros: null,
    revision: crypto.randomUUID(),
  };
  let operations = new Map<string, AutoTopUpOperation>();
  const payments = new Map<string, Stripe.PaymentIntent>();
  const granted = new Set<string>();
  let balance = 0,
    spentBefore = 0,
    charged = 0,
    taxAmount = 2750,
    createCalls = 0,
    confirmCalls = 0,
    capEvents = 0;
  let createLost = false,
    confirmLost = false,
    rollbackBind = false,
    rollbackSettlement = false,
    decline = false,
    authentication = false;
  let ownerActive = true,
    customerCurrency = "usd",
    wrongMode = false,
    wrongCustomer = false;
  let clock = Date.now();
  let fence: Promise<unknown> = Promise.resolve();
  const account = {
    accountId,
    settings: async () => settings,
    spent: async () =>
      spentBefore +
      [...operations.values()]
        .filter((o) => o.state !== "failed")
        .reduce((sum, o) => sum + o.charge_micros, 0),
    pending: async () => [...operations.values()].find((o) => o.state === "pending") ?? null,
    operation: async (key: string) => operations.get(key) ?? null,
    assertOwner: async () => {
      if (!ownerActive) throw new AutoTopUpStoreError(403, "not owner");
    },
    customer: async () => "cus_org",
    balance: async () => balance,
    reserve: async (input: {
      key: string;
      creditMicros: number;
      chargeMicros: number;
      intent: AutoTopUpOperation["intent"];
    }) => {
      const row: AutoTopUpOperation = {
        account_id: accountId,
        operation_key: input.key,
        state: "pending",
        reservation_month: "2026-11-01",
        credit_micros: input.creditMicros,
        charge_micros: input.chargeMicros,
        intent: input.intent,
        payment_intent_id: null,
        confirmation_started_at: null,
        charged_at: null,
        failure_reason: null,
        notification_delivered_at: null,
        created_at: new Date(clock).toISOString(),
        completed_at: null,
      };
      operations.set(input.key, row);
      return row;
    },
    bind: async (key: string, pi: string) => {
      operations.get(key)!.payment_intent_id = pi;
      if (rollbackBind) {
        rollbackBind = false;
        throw new Error("bind commit lost");
      }
    },
    markConfirmation: async (key: string) => {
      operations.get(key)!.confirmation_started_at ??= new Date().toISOString();
    },
    succeeded: async (operation: AutoTopUpOperation, at: string) => {
      if (rollbackSettlement) {
        rollbackSettlement = false;
        throw new Error("settlement commit lost");
      }
      const row = operations.get(operation.operation_key)!;
      row.state = "succeeded";
      row.charged_at = at;
      row.completed_at = at;
      if (!granted.has(row.operation_key)) {
        granted.add(row.operation_key);
        balance += row.credit_micros;
      }
    },
    failed: async (operation: AutoTopUpOperation, reason: string) => {
      operations.get(operation.operation_key)!.state = "failed";
      settings.enabled = false;
      settings.failure_reason = reason;
    },
    disable: async (reason: string) => {
      settings.enabled = false;
      settings.failure_reason = reason;
    },
    failBeforePayment: async (_settings: AutoTopUpSettingsRow, reason: string) => {
      settings.enabled = false;
      settings.failure_reason = reason;
    },
    capReached: async () => {
      capEvents++;
    },
    deliver: async () => {},
    deliverOutstanding: async () => {},
  };
  const store: AutoTopUpStore = {
    locked: (id, run) => {
      expect(id).toBe(accountId);
      const turn = fence.then(async () => {
        const before = structuredClone({ settings, operations });
        try {
          return await run(account as unknown as AutoTopUpAccountStore);
        } catch (error) {
          settings = before.settings;
          operations = before.operations;
          throw error;
        }
      });
      fence = turn.catch(() => {});
      return turn;
    },
  };
  const stripe = {
    customers: {
      retrieve: async () => ({
        id: "cus_org",
        livemode: wrongMode,
        currency: customerCurrency,
        email: "owner@example.test",
        metadata: { opengeni_account_id: accountId },
      }),
    },
    paymentMethods: {
      retrieve: async () => ({
        id: "pm_card",
        type: "card",
        livemode: false,
        customer: wrongCustomer ? "cus_other" : "cus_org",
      }),
    },
    tax: {
      calculations: {
        create: async () => ({
          id: "taxcalc_quote",
          currency: "usd",
          livemode: false,
          customer: "cus_org",
          amount_total: taxAmount,
          expires_at: Math.floor(Date.now() / 1000) + 86400 * 30,
        }),
      },
    },
    paymentIntents: {
      list: () =>
        (async function* () {
          for (const p of payments.values()) yield structuredClone(p);
        })(),
      create: async (params: Stripe.PaymentIntentCreateParams) => {
        createCalls++;
        expect(params.confirm).toBe(false);
        const payment = {
          ...params,
          id: `pi_${createCalls}`,
          object: "payment_intent",
          status: "requires_confirmation",
          livemode: false,
          amount_received: 0,
          created: Math.floor(clock / 1000),
          latest_charge: null,
          last_payment_error: null,
        } as unknown as Stripe.PaymentIntent;
        payments.set(payment.id, payment);
        if (createLost) {
          createLost = false;
          throw new Error("create timeout");
        }
        return structuredClone(payment);
      },
      retrieve: async (pi: string) => structuredClone(payments.get(pi)!),
      confirm: async (pi: string) => {
        const canonical = [...operations.values()].find((o) => o.payment_intent_id === pi);
        expect(canonical?.confirmation_started_at).toBeTruthy();
        confirmCalls++;
        const payment = payments.get(pi)!;
        if (decline || authentication) {
          payment.status = authentication ? "requires_action" : "requires_payment_method";
          payment.last_payment_error = {
            code: authentication ? "authentication_required" : "card_declined",
            message: "private issuer detail",
          } as Stripe.PaymentIntent.LastPaymentError;
          throw new Stripe.errors.StripeCardError({ message: "declined", type: "card_error" });
        }
        if (payment.status !== "succeeded") charged++;
        payment.status = "succeeded";
        payment.amount_received = payment.amount;
        payment.latest_charge = {
          id: `ch_${pi}`,
          paid: true,
          payment_intent: pi,
          livemode: false,
          created: Math.floor(clock / 1000),
        } as Stripe.Charge;
        if (confirmLost) {
          confirmLost = false;
          throw new Error("confirm timeout");
        }
        return structuredClone(payment);
      },
      cancel: async (pi: string) => {
        const p = payments.get(pi)!;
        if (p.status !== "succeeded") p.status = "canceled";
        return structuredClone(p);
      },
    },
  } as unknown as Stripe;
  const service = (enabled = true) =>
    new StripeAutoTopUps(stripe, store, { enabled, provider: "stripe:test" });
  return {
    service,
    stripe,
    store,
    payments,
    granted,
    get settings() {
      return settings;
    },
    get operations() {
      return operations;
    },
    get charged() {
      return charged;
    },
    get createCalls() {
      return createCalls;
    },
    get confirmCalls() {
      return confirmCalls;
    },
    get capEvents() {
      return capEvents;
    },
    set balance(v: number) {
      balance = v;
    },
    set spent(v: number) {
      spentBefore = v;
    },
    set tax(v: number) {
      taxAmount = v;
    },
    set createLost(v: boolean) {
      createLost = v;
    },
    set confirmLost(v: boolean) {
      confirmLost = v;
    },
    set rollbackBind(v: boolean) {
      rollbackBind = v;
    },
    set rollbackSettlement(v: boolean) {
      rollbackSettlement = v;
    },
    set decline(v: boolean) {
      decline = v;
    },
    set authentication(v: boolean) {
      authentication = v;
    },
    set ownerActive(v: boolean) {
      ownerActive = v;
    },
    set currency(v: string) {
      customerCurrency = v;
    },
    set mode(v: boolean) {
      wrongMode = v;
    },
    set wrongCustomer(v: boolean) {
      wrongCustomer = v;
    },
    age(days: number) {
      clock += days * 86400_000;
    },
  };
}

test("decision service covers off, missing card, failure, processing, and tax-inclusive cap", () => {
  const h = harness();
  expect(decideAutoTopUp({ settings: null, spent: 0, pending: false })).toBe("off");
  expect(
    decideAutoTopUp({
      settings: h.settings,
      spent: 75_000_000,
      pending: false,
      chargeMicros: 27_500_000,
    }),
  ).toBe("cap_reached");
  expect(
    decideAutoTopUp({
      settings: { ...h.settings, payment_method_id: null },
      spent: 0,
      pending: false,
    }),
  ).toBe("payment_method_required");
  expect(
    decideAutoTopUp({
      settings: { ...h.settings, enabled: false, failure_reason: "failed" },
      spent: 0,
      pending: false,
    }),
  ).toBe("payment_failed");
  expect(
    decideAutoTopUp({ settings: { ...h.settings, enabled: false }, spent: 0, pending: true }),
  ).toBe("processing");
});
test("a concurrent low-wallet pass confirms one canonical payment and grants purchased credits once", async () => {
  const h = harness();
  await Promise.all(Array.from({ length: 4 }, () => h.service().process(accountId)));
  expect(h.charged).toBe(1);
  expect(h.granted.size).toBe(1);
  expect(h.createCalls).toBe(1);
  expect([...h.operations.values()][0]!.charge_micros).toBe(27_500_000);
});
test.each(["createLost", "rollbackBind", "confirmLost", "rollbackSettlement"] as const)(
  "%s recovers beyond the provider request cache without a second charge",
  async (fault) => {
    const h = harness();
    h[fault] = true;
    await expect(h.service().process(accountId)).rejects.toThrow();
    h.age(3);
    await h.service().process(accountId);
    expect(h.charged).toBe(1);
    expect(h.granted.size).toBe(1);
    expect(h.createCalls).toBe(1);
    expect([...h.operations.values()][0]!.state).toBe("succeeded");
  },
);
test("webhook/worker settlement race and repeated old events converge", async () => {
  const h = harness();
  h.confirmLost = true;
  await expect(h.service().process(accountId)).rejects.toThrow("confirm timeout");
  const payment = [...h.payments.values()][0]!;
  await Promise.all([
    h.service().handlePaymentIntent(payment),
    h.service().process(accountId),
    h.service().handlePaymentIntent(payment),
  ]);
  expect(h.granted.size).toBe(1);
  expect(h.charged).toBe(1);
});
test.each(["decline", "authentication"] as const)(
  "%s cancels the same PI before releasing the reservation and disables automatic retries",
  async (kind) => {
    const h = harness();
    h[kind] = true;
    await h.service().process(accountId);
    expect(h.settings.enabled).toBe(false);
    expect([...h.payments.values()][0]!.status).toBe("canceled");
    expect([...h.operations.values()][0]!.state).toBe("failed");
    await h.service().process(accountId);
    expect(h.confirmCalls).toBe(1);
    expect(h.granted.size).toBe(0);
    expect(h.settings.failure_reason).not.toContain("private issuer detail");
  },
);
test("disabled deployments never create charges but settle already-successful payments", async () => {
  const h = harness();
  await h.service(false).process(accountId);
  expect(h.createCalls).toBe(0);
  h.confirmLost = true;
  await expect(h.service().process(accountId)).rejects.toThrow();
  h.settings.enabled = false;
  await h.service(false).process(accountId);
  expect(h.granted.size).toBe(1);
  expect(h.charged).toBe(1);
});
test("disable after an unknown create cancels instead of confirming", async () => {
  const h = harness();
  h.createLost = true;
  await expect(h.service().process(accountId)).rejects.toThrow();
  h.settings.enabled = false;
  await h.service().process(accountId);
  expect(h.charged).toBe(0);
  expect(h.confirmCalls).toBe(0);
  expect([...h.payments.values()][0]!.status).toBe("canceled");
});
test("tax cannot bypass the cap, high balance and revoked owner cause no provider payment", async () => {
  const h = harness();
  h.spent = 75_000_000;
  await h.service().process(accountId);
  expect(h.capEvents).toBe(1);
  expect(h.createCalls).toBe(0);
  h.spent = 0;
  h.balance = 10_000_000;
  await h.service().process(accountId);
  expect(h.createCalls).toBe(0);
  h.balance = 0;
  h.ownerActive = false;
  await h.service().process(accountId);
  expect(h.settings.enabled).toBe(false);
  expect(h.createCalls).toBe(0);
});
test.each(["currency", "mode", "wrongCustomer"] as const)(
  "mismatched %s never charges",
  async (kind) => {
    const h = harness();
    if (kind === "currency") h.currency = "eur";
    else h[kind] = true;
    await h.service().process(accountId);
    expect(h.settings.enabled).toBe(false);
    expect(h.charged).toBe(0);
    expect(h.createCalls).toBe(0);
  },
);
test("the payment binding rejects amount, currency, mode, metadata, customer and method substitutions", async () => {
  const h = harness();
  await h.service().process(accountId);
  const op = [...h.operations.values()][0]!,
    pi = [...h.payments.values()][0]!;
  for (const patch of [
    { amount: 1 },
    { amount_received: 1 },
    { currency: "eur" },
    { customer: "cus_other" },
    { payment_method: "pm_other" },
    { livemode: true },
    { metadata: {} },
    { hooks: {} },
  ]) {
    expect(() => assertAutoTopUpPayment(op, { ...pi, ...patch } as Stripe.PaymentIntent)).toThrow();
  }
});
test("default-off routes refuse before touching credentials, auth, or storage", async () => {
  const app = new Hono();
  registerBillingRoutes(app, {
    settings: testSettings({ billingAutoTopUpEnabled: false }),
  } as ApiRouteDeps);
  for (const [method, path] of [
    ["GET", "/v1/billing/auto-top-up"],
    ["PUT", "/v1/billing/auto-top-up"],
    ["POST", "/v1/billing/auto-top-up/setup"],
  ]) {
    expect((await app.request(path!, { method })).status).toBe(404);
  }
});
test("a bearer/delegated owner claim is not direct owner consent", async () => {
  const app = new Hono();
  app.post("/owner", async (c) => {
    await requireAutoTopUpOwner(c, {
      settings: testSettings({ productAccessMode: "managed" }),
    } as ApiRouteDeps);
    return c.text("accepted");
  });
  for (const headers of [
    { authorization: "Bearer claimed-owner" },
    { cookie: "fake-session" },
    {},
  ]) {
    expect((await app.request("/owner", { method: "POST", headers })).status).toBe(403);
  }
});
