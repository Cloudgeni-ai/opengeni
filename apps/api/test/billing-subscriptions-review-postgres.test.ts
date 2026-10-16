import { beforeAll, afterAll, expect, test } from "bun:test";
import type Stripe from "stripe";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import {
  createDb,
  ensureManagedAccessForUser,
  getBillingBalance,
  getBillingSubscriptionOperation,
  readSubscriptionPlanCatalog,
  upsertBillingCustomer,
  type DbClient,
} from "@opengeni/db";
import { StripeSubscriptions } from "../src/billing-subscriptions";
import { subscriptionStore } from "../src/billing-subscription-store";

let shared: RestrictedRuntimeTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const databaseFixture = await acquireRestrictedRuntimeTestDatabase(
    "subscription-stripe-fixes-381d7801",
    "stripe_receipt_data",
  );
  if (!databaseFixture) throw new Error("real independent PostgreSQL required");
  shared = databaseFixture;
  client = createDb(shared.appUrl, { max: 4, searchPath: shared.schema });
  const catalog = await readSubscriptionPlanCatalog(client.db);
  for (const plan of catalog.plans)
    if (plan.key === "pro" || plan.key === "max") plan.stripePriceId = `price_${plan.key}`;
  await shared.admin`select set_subscription_plan_catalog(${shared.admin.json(catalog.plans)}, 'independent-review', 'fixture prices only')`;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

const price = (key: string) => ({
  id: `price_${key}`,
  active: true,
  currency: "usd",
  billing_scheme: "per_unit",
  unit_amount: key === "max" ? 20_000 : 2_000,
  recurring: { interval: "month", interval_count: 1 },
});
async function* listed<T>(values: T[]) {
  yield* values;
}

async function fixture(fixtureOptions: { upgradePeriodShiftSeconds?: number } = {}) {
  const userId = crypto.randomUUID();
  const accountId = (
    await ensureManagedAccessForUser(client.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Independent Stripe review",
    })
  ).defaultAccountId!;
  const customerId = `cus_${accountId}`;
  await upsertBillingCustomer(client.db, {
    accountId,
    provider: "stripe:test",
    providerCustomerId: customerId,
  });
  const subscriptions = new Map<string, any>();
  const invoices = new Map<string, any>();
  const lines = new Map<string, any[]>();
  const payments = new Map<string, any[]>();
  const charges = new Map<string, any>();
  const schedules = new Map<string, any>();
  let scheduleUpdates = 0;
  let providerSeconds = 0;
  let updates = 0;
  let rollbackCompletion = false;
  let disconnectAfterUpdate = false;
  const cache = new Map<string, { at: number; request: string; response: any }>();
  const invoiceFor = (sub: any, invoiceId: string) => {
    const item = sub.items.data[0];
    const invoice = {
      id: invoiceId,
      created: item.current_period_start,
      customer: customerId,
      status: "paid",
      status_transitions: { paid_at: item.current_period_start },
      billing_reason: "subscription_cycle",
      parent: { subscription_details: { subscription: sub.id } },
    };
    invoices.set(invoiceId, invoice);
    lines.set(invoiceId, [
      {
        id: `il_${invoiceId}`,
        amount: item.price.unit_amount,
        parent: { subscription_item_details: { subscription_item: item.id } },
        pricing: { price_details: { price: item.price.id } },
        period: { start: item.current_period_start, end: item.current_period_end },
      },
    ]);
    sub.latest_invoice = invoiceId;
    return invoice;
  };
  const add = (name: string, start: number) => {
    const sub = {
      id: `sub_${name}_${accountId}`,
      customer: customerId,
      created: start,
      status: "active",
      cancel_at_period_end: false,
      metadata: { opengeni_account_id: accountId },
      schedule: null,
      latest_invoice: "",
      items: {
        has_more: false,
        data: [
          {
            id: `si_${name}`,
            quantity: 1,
            price: price("pro"),
            current_period_start: start,
            current_period_end: start + 2_592_000,
          },
        ],
      },
    };
    subscriptions.set(sub.id, sub);
    invoiceFor(sub, `in_${name}_${accountId}`);
    return sub;
  };
  const original = add("original", Math.floor(Date.now() / 1000) - 60);
  const stripe = {
    prices: { retrieve: async (id: string) => price(id.slice(6)) },
    subscriptions: {
      retrieve: async (id: string) => structuredClone(subscriptions.get(id)),
      list: () => listed([...subscriptions.values()].map((sub) => structuredClone(sub))),
      update: async (id: string, params: any, options: { idempotencyKey: string }) => {
        const key = options.idempotencyKey;
        const request = JSON.stringify({ id, params });
        const prior = cache.get(key);
        if (prior && providerSeconds - prior.at < 86_400) {
          if (prior.request !== request) throw new Error("Stripe idempotency parameter mismatch");
          return structuredClone(prior.response);
        }
        updates++;
        const sub = subscriptions.get(id)!;
        if (params.metadata) Object.assign(sub.metadata, params.metadata);
        if (params.items) {
          sub.items.data[0].price = price(params.items[0].price.slice(6));
          sub.items.data[0].current_period_start += fixtureOptions.upgradePeriodShiftSeconds ?? 1;
          sub.items.data[0].current_period_end += fixtureOptions.upgradePeriodShiftSeconds ?? 1;
          const invoice = invoiceFor(sub, `in_upgrade_${accountId}`);
          invoice.billing_reason = "subscription_update";
        }
        if (params.cancel_at_period_end !== undefined)
          sub.cancel_at_period_end = params.cancel_at_period_end;
        const response = structuredClone(sub);
        cache.set(key, { at: providerSeconds, request, response });
        if (disconnectAfterUpdate) {
          disconnectAfterUpdate = false;
          throw new Error("provider response lost");
        }
        return response;
      },
      cancel: async (id: string) => {
        subscriptions.get(id)!.status = "canceled";
      },
    },
    invoices: {
      retrieve: async (id: string) => structuredClone(invoices.get(id)),
      listLineItems: (id: string) => listed(lines.get(id) ?? []),
      list: (input: { subscription: string }) =>
        listed(
          [...invoices.values()].filter(
            (invoice) =>
              invoice.parent.subscription_details.subscription === input.subscription &&
              invoice.status === "paid",
          ),
        ),
    },
    subscriptionSchedules: {
      list: () => listed([...schedules.values()].map((schedule) => structuredClone(schedule))),
      retrieve: async (id: string) => structuredClone(schedules.get(id)),
      create: async (input: { from_subscription: string }) => {
        const sub = subscriptions.get(input.from_subscription)!;
        const schedule = {
          id: `sched_${sub.id}`,
          subscription: sub.id,
          metadata: {},
          current_phase: {
            start_date: sub.items.data[0].current_period_start,
            end_date: sub.items.data[0].current_period_end,
          },
        };
        sub.schedule = schedule.id;
        schedules.set(schedule.id, schedule);
        return structuredClone(schedule);
      },
      update: async (id: string, input: any) => {
        scheduleUpdates++;
        Object.assign(schedules.get(id), input);
        return structuredClone(schedules.get(id));
      },
    },
    invoicePayments: {
      list: (input: { invoice: string }) => listed(payments.get(input.invoice) ?? []),
    },
    charges: { retrieve: async (id: string) => structuredClone(charges.get(id)) },
    refunds: {
      create: async (input: { charge: string; amount: number }) => {
        charges.get(input.charge).amount_refunded += input.amount;
        return { id: `re_${input.charge}` };
      },
    },
  };
  const store = subscriptionStore(client.db);
  const service = new StripeSubscriptions(
    stripe as unknown as Stripe,
    {
      ...store,
      locked: (account, run) =>
        store.locked(account, (tx) =>
          run({
            ...tx,
            completeOperation: async (key, result) => {
              await tx.completeOperation(key, result);
              if (rollbackCompletion) {
                rollbackCompletion = false;
                throw new Error("local completion rolled back");
              }
            },
          }),
        ),
    },
    true,
    "stripe:test",
  );
  const paid = (sub: any) =>
    service.handleEvent({
      id: `evt_${sub.latest_invoice}`,
      type: "invoice.paid",
      livemode: false,
      data: { object: invoices.get(sub.latest_invoice) },
    } as Stripe.Event);
  return {
    accountId,
    original,
    service,
    add,
    paid,
    invoices,
    invoiceFor,
    payments,
    charges,
    schedules,
    scheduleUpdates: () => scheduleUpdates,
    rollbackCompletion: () => {
      rollbackCompletion = true;
    },
    disconnectAfterUpdate: () => {
      disconnectAfterUpdate = true;
    },
    advanceProviderClock: () => {
      providerSeconds += 86_401;
    },
    updates: () => updates,
  };
}

test("real org-fenced DB adapter accepts paid invoices, upgrade and duplicate delivery", async () => {
  const f = await fixture();
  await f.paid(f.original);
  await f.service.upgrade({
    accountId: f.accountId,
    planKey: "max",
    idempotencyKey: crypto.randomUUID(),
  });
  await f.paid(f.original);
  expect((await getBillingBalance(client.db, f.accountId)).balanceMicros).toBe(2_000_000_000);
}, 180_000);

test("a paid same-second upgrade replaces plan credit exactly once through the real DB adapter", async () => {
  const f = await fixture({ upgradePeriodShiftSeconds: 0 });
  await f.paid(f.original);
  expect((await getBillingBalance(client.db, f.accountId)).balanceMicros).toBe(200_000_000);
  const originalStart = f.original.items.data[0].current_period_start;
  const input = {
    accountId: f.accountId,
    planKey: "max",
    idempotencyKey: crypto.randomUUID(),
  };
  const result = await f.service.upgrade(input);
  expect(f.original.items.data[0].current_period_start).toBe(originalStart);
  await f.paid(f.original);
  expect(await f.service.upgrade(input)).toEqual(result);
  expect(f.updates()).toBe(1);
  expect((await getBillingBalance(client.db, f.accountId)).balanceMicros).toBe(2_000_000_000);
}, 180_000);

test("an old cancellation retry after Stripe key retention cannot cancel a replacement subscription", async () => {
  const f = await fixture();
  await f.paid(f.original);
  const input = { accountId: f.accountId, idempotencyKey: crypto.randomUUID() };
  await f.service.cancel(input);
  await f.service.cancel(input);
  expect(f.updates()).toBe(1); // Provider idempotency works while its key is retained.
  f.original.status = "canceled";
  const replacement = f.add("replacement", f.original.items.data[0]!.current_period_start + 1);
  await f.paid(replacement);
  f.advanceProviderClock(); // Stripe may prune API-v1 request keys after 24 hours.
  await f.service.cancel(input);
  expect(replacement.cancel_at_period_end).toBe(false);
}, 180_000);

test("a previously unpaid overlapping invoice paid after replacement is refunded as duplicate funding", async () => {
  const f = await fixture();
  const now = Math.floor(Date.now() / 1000);
  const day = 86_400;
  // A legitimate older paid period, followed by an unpaid renewal ten days ago.
  f.original.created = now - 40 * day;
  f.original.items.data[0]!.current_period_start = now - 40 * day;
  f.original.items.data[0]!.current_period_end = now - 10 * day;
  f.invoiceFor(f.original, f.original.latest_invoice);
  const historicalInvoice = f.original.latest_invoice;
  const historicalCharge = `ch_historical_${f.accountId}`;
  f.charges.set(historicalCharge, { id: historicalCharge, amount: 2000, amount_refunded: 0 });
  f.payments.set(historicalInvoice, [{ payment: { type: "charge", charge: historicalCharge } }]);
  await f.paid(f.original);
  f.original.items.data[0]!.current_period_start = now - 10 * day;
  f.original.items.data[0]!.current_period_end = now + 20 * day;
  const renewal = f.invoiceFor(f.original, `in_unpaid_renewal_${f.accountId}`);
  renewal.status = "open";
  f.original.status = "unpaid";
  await f.service.handleEvent({
    id: `evt_failed_${f.accountId}`,
    type: "invoice.payment_failed",
    livemode: false,
    data: { object: renewal },
  } as Stripe.Event);
  // The API explicitly permits a fresh subscription while the old one is unpaid.
  const replacement = f.add("replacement", now - day);
  await f.paid(replacement);
  const chargeId = `ch_late_${f.accountId}`;
  f.charges.set(chargeId, { id: chargeId, amount: 2000, amount_refunded: 0 });
  f.payments.set(renewal.id, [{ payment: { type: "charge", charge: chargeId } }]);
  renewal.status = "paid";
  renewal.status_transitions = { paid_at: now };
  f.original.status = "active"; // Paying its required invoice reactivates an unpaid subscription.
  await f.paid(f.original);
  expect(f.original.status).toBe("canceled");
  expect((await getBillingBalance(client.db, f.accountId)).balanceMicros).toBe(200_000_000);
  expect(f.charges.get(chargeId).amount_refunded).toBe(2000);
  expect(f.charges.get(historicalCharge).amount_refunded).toBe(0);
  await f.paid(f.original);
  expect(f.charges.get(chargeId).amount_refunded).toBe(2000);
}, 180_000);

test("provider success plus DB rollback retains the original cancellation target across replacement and key expiry", async () => {
  const f = await fixture();
  await f.paid(f.original);
  const input = { accountId: f.accountId, idempotencyKey: crypto.randomUUID() };
  f.rollbackCompletion();
  await expect(f.service.cancel(input)).rejects.toThrow("local completion rolled back");
  const pending = await getBillingSubscriptionOperation(
    client.db,
    f.accountId,
    input.idempotencyKey,
  );
  expect(pending?.intent.subscriptionId).toBe(f.original.id);
  expect(pending?.result).toBeNull();
  expect(f.original.cancel_at_period_end).toBe(true);
  f.original.status = "canceled";
  const replacement = f.add("replacement", f.original.items.data[0]!.current_period_start + 1);
  await f.paid(replacement);
  f.advanceProviderClock();
  const result = await f.service.cancel(input);
  expect(result.subscriptionId).toBe(f.original.id);
  expect(result.effectiveAt).toBe(
    new Date(f.original.items.data[0]!.current_period_end * 1000).toISOString(),
  );
  expect(replacement.cancel_at_period_end).toBe(false);
  expect(f.updates()).toBe(1);
  expect(
    (await getBillingSubscriptionOperation(client.db, f.accountId, input.idempotencyKey))?.result,
  ).toEqual({ response: result });
}, 180_000);

test("unknown provider outcome blocks a different operation until same-key recovery without charging again", async () => {
  const f = await fixture();
  await f.paid(f.original);
  const input = { accountId: f.accountId, planKey: "max", idempotencyKey: crypto.randomUUID() };
  f.disconnectAfterUpdate();
  await expect(f.service.upgrade(input)).rejects.toThrow("provider response lost");
  expect((await getBillingBalance(client.db, f.accountId)).balanceMicros).toBe(200_000_000);
  await expect(
    f.service.cancel({ accountId: f.accountId, idempotencyKey: crypto.randomUUID() }),
  ).rejects.toThrow("pending subscription operation");
  f.advanceProviderClock();
  const result = await f.service.upgrade(input);
  expect(result.planKey).toBe("max");
  expect(f.updates()).toBe(1);
  expect((await getBillingBalance(client.db, f.accountId)).balanceMicros).toBe(2_000_000_000);
  await expect(
    f.service.cancel({ accountId: f.accountId, idempotencyKey: input.idempotencyKey }),
  ).rejects.toThrow("different request");
}, 180_000);

test("completed upgrades replay their result without upgrading a replacement subscription", async () => {
  const f = await fixture();
  await f.paid(f.original);
  const input = { accountId: f.accountId, planKey: "max", idempotencyKey: crypto.randomUUID() };
  const originalResult = await f.service.upgrade(input);
  f.original.status = "canceled";
  const replacement = f.add("replacement", f.original.items.data[0]!.current_period_start + 1);
  await f.paid(replacement);
  f.advanceProviderClock();
  expect(await f.service.upgrade(input)).toEqual(originalResult);
  expect(replacement.items.data[0].price.id).toBe("price_pro");
  expect(f.updates()).toBe(1);
}, 180_000);

test("downgrade recovery finds its released schedule after local rollback and never schedules the replacement", async () => {
  const f = await fixture();
  f.original.items.data[0].price = price("max");
  f.invoiceFor(f.original, f.original.latest_invoice);
  await f.paid(f.original);
  const input = { accountId: f.accountId, planKey: "pro", idempotencyKey: crypto.randomUUID() };
  f.rollbackCompletion();
  await expect(f.service.change(input)).rejects.toThrow("local completion rolled back");
  const schedule = f.schedules.get(f.original.schedule)!;
  schedule.released_subscription = f.original.id;
  schedule.subscription = null;
  schedule.current_phase = null;
  f.original.schedule = null;
  f.original.status = "canceled";
  const replacement = f.add("replacement", f.original.items.data[0].current_period_start + 1);
  await f.paid(replacement);
  f.advanceProviderClock();
  const result = await f.service.change(input);
  expect(result.subscriptionId).toBe(f.original.id);
  expect(result.planKey).toBe("pro");
  expect(replacement.schedule).toBeNull();
  expect(f.scheduleUpdates()).toBe(1);
  expect(await f.service.change(input)).toEqual(result);
}, 180_000);
