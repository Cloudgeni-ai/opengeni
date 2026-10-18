import { describe, expect, mock, test } from "bun:test";
import Stripe from "stripe";
import { Hono } from "hono";
import { testSettings } from "@opengeni/testing";
import type { SubscriptionPlan } from "@opengeni/contracts";
import type { BillingSubscriptionOperation } from "@opengeni/db";
import {
  StripeSubscriptions,
  subscriptionCheckoutParams,
  subscriptionItem,
} from "../src/billing-subscriptions";
import type {
  StoredSubscriptionPlan,
  SubscriptionAccountStore,
  SubscriptionStore,
} from "../src/billing-subscription-store";
import {
  serializedStripeCustomer,
  type StripeCustomerTransaction,
} from "../src/billing-stripe-customer";
import {
  registerBillingRoutes,
  requireSelectedAccount,
  stripeCheckoutCreditDecision,
} from "../src/routes/billing";

const accountId = "7d6c2b1e-4a5f-4e3d-9c8b-1a2b3c4d5e6f";
const requestKey = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const plans: SubscriptionPlan[] = [
  {
    key: "free",
    label: "Free",
    stripePriceId: null,
    monthlyPriceMicros: 0,
    monthlyCreditMicros: 10_000_000,
    seatLimit: 5,
    freeCredit: true,
  },
  {
    key: "pro",
    label: "Pro",
    stripePriceId: "price_pro",
    monthlyPriceMicros: 20_000_000,
    monthlyCreditMicros: 200_000_000,
    seatLimit: 10,
    freeCredit: false,
  },
  {
    key: "max",
    label: "Max",
    stripePriceId: "price_max",
    monthlyPriceMicros: 200_000_000,
    monthlyCreditMicros: 2_000_000_000,
    seatLimit: null,
    freeCredit: false,
  },
  {
    key: "enterprise",
    label: "Enterprise",
    stripePriceId: "price_enterprise",
    monthlyPriceMicros: 500_000_000,
    monthlyCreditMicros: 0,
    seatLimit: null,
    freeCredit: false,
  },
];

function price(key = "pro"): Stripe.Price {
  return {
    id: `price_${key}`,
    active: true,
    currency: "usd",
    billing_scheme: "per_unit",
    unit_amount: key.startsWith("max") ? 20_000 : 2_000,
    recurring: { interval: "month", interval_count: 1 },
  } as Stripe.Price;
}

function subscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_main",
    customer: "cus_org",
    created: 100,
    status: "active",
    cancel_at_period_end: false,
    metadata: { opengeni_account_id: accountId },
    latest_invoice: "in_main",
    schedule: null,
    items: {
      has_more: false,
      data: [
        {
          id: "si_plan",
          quantity: 1,
          price: price(),
          current_period_start: 1000,
          current_period_end: 2000,
        },
      ],
    },
    ...overrides,
  } as Stripe.Subscription;
}

function invoice(subscriptionId = "sub_main", invoiceId = "in_main"): Stripe.Invoice {
  return {
    id: invoiceId,
    created: 1000,
    customer: "cus_org",
    status: "paid",
    status_transitions: { paid_at: 1000 },
    billing_reason: "subscription_cycle",
    parent: { subscription_details: { subscription: subscriptionId } },
  } as Stripe.Invoice;
}

function line(plan = "pro", start = 1000, end = 2000): Stripe.InvoiceLineItem {
  return {
    id: "il_plan",
    amount: 2000,
    parent: { subscription_item_details: { subscription_item: "si_plan" } },
    pricing: { price_details: { price: `price_${plan}` } },
    period: { start, end },
  } as Stripe.InvoiceLineItem;
}

function event(type: string, object: unknown): Stripe.Event {
  return { id: `evt_${type}`, type, livemode: false, data: { object } } as Stripe.Event;
}

async function* listed<T>(values: T[]) {
  yield* values;
}

/** A real serialized callback boundary, without a network or PostgreSQL. Plan
 * receipt replay emulates the separately tested DB seam, not Stripe event IDs. */
function fixture(enabled = true) {
  const subscriptions = new Map<string, Stripe.Subscription>();
  const invoices = new Map<string, Stripe.Invoice>();
  const lines = new Map<string, Stripe.InvoiceLineItem[]>();
  const payments = new Map<string, Stripe.InvoicePayment[]>();
  const charges = new Map<string, Stripe.Charge>();
  let state: StoredSubscriptionPlan | null = { plan_key: "free", stripe_subscription_id: null };
  let openPeriod: string | null = "free-period";
  const receipts = new Set<string>();
  const operations = new Map<string, BillingSubscriptionOperation>();
  const timeline: string[] = [];
  let queue = Promise.resolve();
  let updateFails = false;
  let onLock: (() => void) | undefined;
  const save = mock(async (input: Parameters<SubscriptionAccountStore["save"]>[0]) => {
    timeline.push(`save:${input.planKey}:${input.status}`);
    state = { plan_key: input.planKey, stripe_subscription_id: input.stripeSubscriptionId ?? null };
  });
  const replace = mock(async (input: Parameters<SubscriptionAccountStore["replace"]>[0]) => {
    const key = `${input.stripeSubscriptionId}:${input.periodStart.toISOString()}`;
    if (receipts.has(key)) return;
    if (openPeriod) timeline.push(`expire:${openPeriod}`);
    openPeriod = key;
    receipts.add(key);
    timeline.push(`grant:${input.planKey}`);
  });
  const store: SubscriptionStore = {
    catalog: mock(async () => ({ revision: 3, plans })),
    locked: async (_account, run) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      timeline.push("lock");
      onLock?.();
      onLock = undefined;
      try {
        return await run({
          operation: async (key) => structuredClone(operations.get(key) ?? null),
          beginOperation: async (input) => {
            if ([...operations.values()].some((operation) => !operation.result))
              throw new Error("pending subscription operation");
            const operation: BillingSubscriptionOperation = {
              account_id: accountId,
              operation_key: input.operationKey,
              kind: input.kind,
              request: input.request,
              intent: input.intent,
              result: null,
              created_at: new Date().toISOString(),
              completed_at: null,
            };
            operations.set(input.operationKey, operation);
            return structuredClone(operation);
          },
          completeOperation: async (key, result) => {
            Object.assign(operations.get(key)!, { result, completed_at: new Date().toISOString() });
          },
          exists: async () => true,
          state: async () => state,
          customer: async () => "cus_org",
          balance: async () => null,
          save,
          replace,
          expire: async () => {
            timeline.push("expire");
            openPeriod = null;
          },
        });
      } finally {
        release();
      }
    },
  };
  const stripe = {
    prices: { retrieve: mock(async (priceId: string) => price(priceId.slice(6))) },
    checkout: {
      sessions: {
        create: mock(
          async (
            _input: Stripe.Checkout.SessionCreateParams,
            _options?: Stripe.RequestOptions,
          ) => ({
            id: "cs_subscription",
            url: "https://checkout.stripe.test/session",
          }),
        ),
      },
    },
    subscriptions: {
      retrieve: mock(async (subscriptionId: string) =>
        structuredClone(subscriptions.get(subscriptionId)!),
      ),
      list: mock(() => listed([...subscriptions.values()].map((s) => structuredClone(s)))),
      update: mock(async (subscriptionId: string, input: Stripe.SubscriptionUpdateParams) => {
        if (updateFails)
          throw new Stripe.errors.StripeCardError({ message: "card declined", type: "card_error" });
        const sub = subscriptions.get(subscriptionId)!;
        if (input.metadata) Object.assign(sub.metadata, input.metadata);
        if (input.items) {
          const item = sub.items.data[0]!;
          item.price = price(input.items[0]!.price!.slice(6));
          item.current_period_start = 1500;
          item.current_period_end = 2500;
          sub.latest_invoice = "in_upgrade";
          invoices.set("in_upgrade", invoice(sub.id, "in_upgrade"));
          lines.set("in_upgrade", [line(input.items[0]!.price!.slice(6), 1500, 2500)]);
        }
        if (input.cancel_at_period_end !== undefined)
          sub.cancel_at_period_end = input.cancel_at_period_end;
        return structuredClone(sub);
      }),
      cancel: mock(async (subscriptionId: string) => {
        subscriptions.get(subscriptionId)!.status = "canceled";
      }),
    },
    invoices: {
      retrieve: mock(async (invoiceId: string) => structuredClone(invoices.get(invoiceId)!)),
      listLineItems: mock((invoiceId: string) => listed(lines.get(invoiceId) ?? [])),
      list: mock((input: { subscription: string }) =>
        listed(
          [...invoices.values()].filter(
            (inv) => inv.parent?.subscription_details?.subscription === input.subscription,
          ),
        ),
      ),
    },
    subscriptionSchedules: {
      list: mock(() => listed([])),
      create: mock(async () => {
        subscriptions.get("sub_main")!.schedule = "sub_sched";
        return { id: "sub_sched", current_phase: { start_date: 1000, end_date: 2000 } };
      }),
      retrieve: mock(async () => ({
        id: "sub_sched",
        current_phase: { start_date: 1000, end_date: 2000 },
      })),
      update: mock(async (_id: string, _input: Stripe.SubscriptionScheduleUpdateParams) => ({})),
      release: mock(async () => {
        subscriptions.get("sub_main")!.schedule = null;
      }),
    },
    invoicePayments: {
      list: mock((input: { invoice: string }) => listed(payments.get(input.invoice) ?? [])),
    },
    paymentIntents: { retrieve: mock(async () => ({ latest_charge: "ch_duplicate" })) },
    charges: {
      retrieve: mock(async (chargeId: string) => structuredClone(charges.get(chargeId)!)),
    },
    refunds: {
      create: mock(async (input: { charge: string; amount: number }) => {
        charges.get(input.charge)!.amount_refunded += input.amount;
        return { id: "re_duplicate" };
      }),
    },
  };
  const add = (sub = subscription()) => {
    subscriptions.set(sub.id, sub);
    invoices.set(
      `in_${sub.id === "sub_main" ? "main" : sub.id}`,
      invoice(sub.id, `in_${sub.id === "sub_main" ? "main" : sub.id}`),
    );
    lines.set("in_main", [line()]);
    return sub;
  };
  return {
    stripe,
    store,
    subscriptions,
    invoices,
    lines,
    payments,
    charges,
    receipts,
    operations,
    timeline,
    save,
    replace,
    add,
    service: new StripeSubscriptions(stripe as unknown as Stripe, store, enabled, "stripe:test"),
    state: () => state,
    setState: (value: StoredSubscriptionPlan) => {
      state = value;
    },
    failUpdate: () => {
      updateFails = true;
    },
    onLock: (callback: () => void) => {
      onLock = callback;
    },
  };
}

describe("subscription checkout and catalog", () => {
  test("legacy subscriptions synchronize at their old amount while checkout and upgrades target only current prices", async () => {
    const f = fixture();
    const changed = plans.map((plan) =>
      plan.stripePriceId && ["pro", "max"].includes(plan.key)
        ? {
            ...plan,
            stripePriceId: `${plan.stripePriceId}_v2`,
            legacyStripePriceIds: [plan.stripePriceId],
          }
        : plan,
    );
    f.store.catalog = async () => ({ revision: 4, plans: changed });
    await f.service.checkout({
      accountId,
      customerId: "cus_org",
      planKey: "pro",
      idempotencyKey: requestKey,
      successUrl: "https://app.test/success",
      cancelUrl: "https://app.test/cancel",
    });
    expect(f.stripe.checkout.sessions.create.mock.calls[0]![0]).toMatchObject({
      line_items: [{ price: "price_pro_v2", quantity: 1 }],
    });
    const sub = f.add();
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.state()?.plan_key).toBe("pro");
    await f.service.upgrade({ accountId, planKey: "max", idempotencyKey: requestKey });
    expect(f.stripe.subscriptions.update.mock.calls.at(-1)![1]).toMatchObject({
      items: [{ id: "si_plan", price: "price_max_v2", quantity: 1 }],
    });
    expect(sub.items.data[0]!.price.id).toBe("price_max_v2");
  });

  test("legacy prices may differ from today's price; unknown and mismatched current prices remain rejected", async () => {
    const f = fixture();
    f.store.catalog = async () => ({
      revision: 4,
      plans: plans.map((plan) =>
        plan.key === "pro"
          ? {
              ...plan,
              stripePriceId: "price_pro_v2",
              legacyStripePriceIds: ["price_pro"],
              monthlyPriceMicros: 30_000_000,
            }
          : plan,
      ),
    });
    const sub = f.add();
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.replace).toHaveBeenCalledTimes(1);
    sub.items.data[0]!.price.id = "price_unknown";
    await expect(f.service.handleEvent(event("invoice.paid", invoice()))).rejects.toThrow(
      "not in the self-service catalog",
    );
    sub.items.data[0]!.price.id = "price_pro_v2";
    await expect(f.service.handleEvent(event("invoice.paid", invoice()))).rejects.toThrow(
      "price does not match catalog",
    );
  });

  test("downgrade from a legacy price preserves its current phase and schedules the current target price", async () => {
    const f = fixture();
    f.store.catalog = async () => ({
      revision: 4,
      plans: plans.map((plan) =>
        plan.stripePriceId && ["pro", "max"].includes(plan.key)
          ? {
              ...plan,
              stripePriceId: `${plan.stripePriceId}_v2`,
              legacyStripePriceIds: [plan.stripePriceId],
            }
          : plan,
      ),
    });
    const sub = f.add();
    sub.items.data[0]!.price = price("max");
    f.setState({ plan_key: "max", stripe_subscription_id: sub.id });
    await f.service.change({ accountId, planKey: "pro", idempotencyKey: requestKey });
    expect(f.stripe.subscriptionSchedules.update.mock.calls[0]![1]).toMatchObject({
      phases: [
        { items: [{ price: "price_max", quantity: 1 }] },
        { items: [{ price: "price_pro_v2", quantity: 1 }] },
      ],
    });
  });

  test("reuses the customer, enables tax, and isolates subscription metadata from top-ups", async () => {
    const f = fixture();
    await f.service.checkout({
      accountId,
      customerId: "cus_org",
      planKey: "pro",
      idempotencyKey: requestKey,
      successUrl: "https://app.test/billing",
      cancelUrl: "https://app.test/billing",
    });
    const params = subscriptionCheckoutParams({
      accountId,
      customerId: "cus_org",
      priceId: "price_pro",
      successUrl: "https://app.test/billing",
      cancelUrl: "https://app.test/billing",
    });
    expect(params).toMatchObject({
      mode: "subscription",
      customer: "cus_org",
      automatic_tax: { enabled: true },
      subscription_data: { metadata: { opengeni_account_id: accountId } },
    });
    expect(params).not.toHaveProperty("payment_intent_data");
    expect(params).not.toHaveProperty("metadata");
    expect(
      stripeCheckoutCreditDecision({
        ...params,
        metadata: { opengeni_account_id: accountId },
      } as never),
    ).toMatchObject({ action: "ignore", reason: "not_payment_mode" });
    expect(f.stripe.checkout.sessions.create.mock.calls[0]![1]).toEqual({
      idempotencyKey: `subscription-checkout:${accountId}:${requestKey}`,
    });
  });

  test("returns runtime USD prices, credit, seats and excludes Enterprise from self-service", async () => {
    const catalog = await fixture().service.catalog(accountId);
    expect(catalog.revision).toBe(3);
    expect(catalog.plans.find((p) => p.key === "pro")).toMatchObject({
      monthlyPriceMicros: 20_000_000,
      monthlyCreditMicros: 200_000_000,
      seatLimit: 10,
      selfService: true,
    });
    expect(catalog.plans.find((p) => p.key === "enterprise")!.selfService).toBe(false);
    expect(catalog.plans.find((p) => p.key === "free")!.selfService).toBe(false);
  });

  test("rejects a second active subscription and operator-only plans", async () => {
    const f = fixture();
    f.add();
    const input = {
      accountId,
      customerId: "cus_org",
      planKey: "pro",
      idempotencyKey: requestKey,
      successUrl: "https://app.test",
      cancelUrl: "https://app.test",
    };
    await expect(f.service.checkout(input)).rejects.toThrow("already has a subscription");
    await expect(f.service.checkout({ ...input, planKey: "enterprise" })).rejects.toThrow(
      "not available for self-service",
    );
    expect(f.stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("Stripe v22 paid receipt synchronization", () => {
  test("created/updated/failed events synchronize state, but ONLY paid invoices replace Free credit", async () => {
    const f = fixture();
    f.add();
    for (const type of [
      "customer.subscription.created",
      "customer.subscription.updated",
      "invoice.payment_failed",
    ]) {
      await f.service.handleEvent(
        event(type, type.startsWith("invoice") ? invoice() : subscription()),
      );
    }
    expect(f.replace).not.toHaveBeenCalled();
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.timeline.slice(-3)).toEqual(["save:pro:active", "expire:free-period", "grant:pro"]);
    expect(f.receipts.size).toBe(1);
    // Same/different event IDs share the DB subscription+period receipt.
    await Promise.all([
      f.service.handleEvent(event("invoice.paid", invoice())),
      f.service.handleEvent(event("invoice.paid", invoice())),
    ]);
    expect(f.receipts.size).toBe(1);
    expect(f.timeline.filter((entry) => entry === "grant:pro")).toHaveLength(1);
  });

  test("retrieves subscription again after locking, ignores stale payloads/invoices", async () => {
    const f = fixture();
    const sub = f.add();
    f.onLock(() => {
      sub.items.data[0]!.current_period_start = 2000;
      sub.items.data[0]!.current_period_end = 3000;
    });
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2);
    expect(f.replace).not.toHaveBeenCalled();
    f.invoices.set("in_new", invoice(sub.id, "in_new"));
    f.lines.set("in_new", [line("pro", 2000, 3000)]);
    await f.service.handleEvent(event("invoice.paid", invoice(sub.id, "in_new")));
    expect(f.receipts.size).toBe(1);
  });

  test("paid renewal replaces the old period once and never stacks", async () => {
    const f = fixture();
    const sub = f.add();
    await f.service.handleEvent(event("invoice.paid", invoice()));
    sub.items.data[0]!.current_period_start = 2000;
    sub.items.data[0]!.current_period_end = 3000;
    f.invoices.set("in_next", invoice(sub.id, "in_next"));
    f.lines.set("in_next", [line("pro", 2000, 3000)]);
    await f.service.handleEvent(event("invoice.paid", invoice(sub.id, "in_next")));
    expect(f.receipts.size).toBe(2);
    expect(f.timeline.filter((entry) => entry.startsWith("expire:"))).toHaveLength(2);
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.receipts.size).toBe(2);
  });

  test("unpaid invoices/foreign lines never grant, and v22 item periods are required", async () => {
    const f = fixture();
    f.add();
    f.invoices.get("in_main")!.status = "open";
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.replace).not.toHaveBeenCalled();
    f.invoices.get("in_main")!.status = "paid";
    f.lines.set("in_main", [line("max")]);
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.replace).not.toHaveBeenCalled();
    const invalid = subscription();
    delete (invalid.items.data[0] as Partial<Stripe.SubscriptionItem>).current_period_start;
    expect(() => subscriptionItem(invalid)).toThrow("one monthly USD plan item");
  });

  test("failed renewal preserves remaining paid period; terminal state returns Free without any Free grant", async () => {
    const f = fixture();
    const sub = f.add();
    await f.service.handleEvent(event("invoice.paid", invoice()));
    sub.status = "past_due";
    await f.service.handleEvent(event("invoice.payment_failed", invoice()));
    expect(f.save.mock.calls.at(-1)![0].status).toBe("past_due");
    expect(f.timeline.at(-1)).toBe("save:pro:past_due");
    sub.status = "canceled";
    await f.service.handleEvent(event("customer.subscription.deleted", subscription()));
    expect(f.state()).toEqual({ plan_key: "free", stripe_subscription_id: null });
    expect(f.timeline.at(-1)).toBe("expire");
    expect(f.receipts.size).toBe(1);
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.receipts.size).toBe(1);
  });

  test("Stripe's final unpaid state returns Free and does not block a later checkout", async () => {
    const f = fixture();
    const sub = f.add();
    await f.service.handleEvent(event("invoice.paid", invoice()));
    sub.status = "unpaid";
    await f.service.handleEvent(event("invoice.payment_failed", invoice()));
    expect(f.state()).toEqual({ plan_key: "free", stripe_subscription_id: null });
    await f.service.checkout({
      accountId,
      customerId: "cus_org",
      planKey: "pro",
      idempotencyKey: requestKey,
      successUrl: "https://app.test/billing",
      cancelUrl: "https://app.test/billing",
    });
    expect(f.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(f.receipts.size).toBe(1);
  });

  test("operator Enterprise assignment cannot be overwritten, inferred or historically refunded by webhooks", async () => {
    const f = fixture();
    f.add();
    f.setState({ plan_key: "enterprise", stripe_subscription_id: null });
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.save).not.toHaveBeenCalled();
    expect(f.replace).not.toHaveBeenCalled();
    expect(f.stripe.subscriptions.cancel).not.toHaveBeenCalled();
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  });

  test("a mismatched customer cannot write any organization plan state", async () => {
    const f = fixture();
    f.add(subscription({ customer: "cus_other_org" }));
    await expect(f.service.handleEvent(event("invoice.paid", invoice()))).rejects.toThrow(
      "does not match organization",
    );
    expect(f.save).not.toHaveBeenCalled();
    expect(f.replace).not.toHaveBeenCalled();
  });
});

describe("upgrade, period-end downgrade and cancellation", () => {
  test("upgrade invoices now/error_if_incomplete and fully replaces credit only after paid success", async () => {
    const f = fixture();
    f.add();
    await f.service.handleEvent(event("invoice.paid", invoice()));
    const result = await f.service.upgrade({
      accountId,
      planKey: "max",
      idempotencyKey: requestKey,
    });
    expect(result.planKey).toBe("max");
    expect(f.stripe.subscriptions.update.mock.calls[0]![1]).toMatchObject({
      billing_cycle_anchor: "now",
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
    });
    expect(f.timeline.slice(-3)).toEqual([
      "save:max:active",
      "expire:sub_main:1970-01-01T00:16:40.000Z",
      "grant:max",
    ]);
    await f.service.upgrade({ accountId, planKey: "max", idempotencyKey: requestKey });
    expect(f.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(f.receipts.size).toBe(2);
    await expect(
      f.service.upgrade({ accountId, planKey: "pro", idempotencyKey: requestKey }),
    ).rejects.toThrow("already used for a different request");
    await expect(
      f.service.upgrade({ accountId, planKey: "max", idempotencyKey: crypto.randomUUID() }),
    ).rejects.toThrow("higher-priced");
  });

  test("a declined upgrade changes no plan state or allowance", async () => {
    const f = fixture();
    f.add();
    await f.service.handleEvent(event("invoice.paid", invoice()));
    const before = f.save.mock.calls.length;
    f.failUpdate();
    await expect(
      f.service.upgrade({ accountId, planKey: "max", idempotencyKey: requestKey }),
    ).rejects.toThrow("card declined");
    expect(f.save.mock.calls).toHaveLength(before);
    expect(f.receipts.size).toBe(1);
    expect(f.operations.get(requestKey)?.result).toEqual({ error: "card declined", status: 422 });
    await expect(
      f.service.upgrade({ accountId, planKey: "max", idempotencyKey: requestKey }),
    ).rejects.toThrow("card declined");
    expect(f.stripe.subscriptions.update).toHaveBeenCalledTimes(1);
  });

  test("downgrade schedules next period and cancellation preserves the paid period", async () => {
    const f = fixture();
    f.add(
      subscription({
        items: {
          has_more: false,
          data: [{ ...subscription().items.data[0]!, price: price("max") }],
        } as Stripe.ApiList<Stripe.SubscriptionItem>,
      }),
    );
    await f.service.handleEvent(event("customer.subscription.created", subscription()));
    const change = await f.service.change({
      accountId,
      planKey: "pro",
      idempotencyKey: requestKey,
    });
    expect(change.effectiveAt).toBe(new Date(2000 * 1000).toISOString());
    const schedule = (
      f.stripe.subscriptionSchedules.update.mock.calls[0] as unknown[]
    )[1] as Stripe.SubscriptionScheduleUpdateParams;
    expect(schedule.phases![0]).toMatchObject({
      end_date: 2000,
      items: [{ price: "price_max", quantity: 1 }],
    });
    expect(schedule.phases![1]).toMatchObject({
      start_date: 2000,
      items: [{ price: "price_pro", quantity: 1 }],
      proration_behavior: "none",
    });
    expect(f.replace).not.toHaveBeenCalled();
    const canceled = await f.service.cancel({ accountId, idempotencyKey: crypto.randomUUID() });
    expect(canceled.cancelAtPeriodEnd).toBe(true);
    expect(f.stripe.subscriptionSchedules.release).toHaveBeenCalledTimes(1);
    expect(f.stripe.subscriptions.update.mock.calls.at(-1)![1]).toMatchObject({
      cancel_at_period_end: true,
    });
    expect(f.timeline).not.toContain("expire");
  });
});

describe("duplicate subscriptions", () => {
  test("keeps one canonical subscription, cancels/refunds the duplicate idempotently using v22 invoice payments", async () => {
    const f = fixture();
    f.add();
    const loser = f.add(
      subscription({ id: "sub_duplicate", created: 200, latest_invoice: "in_sub_duplicate" }),
    );
    f.payments.set("in_sub_duplicate", [
      {
        payment: { type: "payment_intent", payment_intent: "pi_duplicate" },
      } as Stripe.InvoicePayment,
    ]);
    f.charges.set("ch_duplicate", {
      id: "ch_duplicate",
      amount: 2000,
      amount_refunded: 0,
    } as Stripe.Charge);
    await f.service.handleEvent(event("customer.subscription.created", loser));
    expect(f.stripe.subscriptions.cancel.mock.calls[0]![0]).toBe(loser.id);
    expect(f.stripe.refunds.create.mock.calls[0]).toEqual([
      { charge: "ch_duplicate", amount: 2000 },
      { idempotencyKey: "subscription-duplicate-refund:ch_duplicate:0" },
    ]);
    expect(f.save).not.toHaveBeenCalled();
    // Cancelled loser events remain recognizable after cancellation/DB rollback.
    await f.service.handleEvent(event("invoice.paid", invoice(loser.id, "in_sub_duplicate")));
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
    await f.service.handleEvent(event("invoice.paid", invoice()));
    expect(f.state()!.stripe_subscription_id).toBe("sub_main");
    expect(f.receipts.size).toBe(1);
  });

  test("an existing binding wins even if its duplicate was created earlier", async () => {
    const f = fixture();
    f.add();
    f.setState({ plan_key: "pro", stripe_subscription_id: "sub_main" });
    f.add(subscription({ id: "sub_earlier_duplicate", created: 1 }));
    await f.service.handleEvent(event("customer.subscription.updated", subscription()));
    expect(f.stripe.subscriptions.cancel.mock.calls[0]![0]).toBe("sub_earlier_duplicate");
    expect(f.state()!.stripe_subscription_id).toBe("sub_main");
  });

  test("duplicate recovery never refunds a subscription's legitimate pre-overlap history", async () => {
    const f = fixture();
    f.add(subscription({ created: 200 }));
    f.setState({ plan_key: "pro", stripe_subscription_id: "sub_main" });
    const old = f.add(subscription({ id: "sub_old_active", created: 1 }));
    f.invoices.set("in_historical", {
      ...invoice(old.id, "in_historical"),
      created: 100,
      status_transitions: { ...invoice().status_transitions, paid_at: 100 },
    });
    f.payments.set("in_historical", [
      {
        payment: { type: "payment_intent", payment_intent: "pi_historical" },
      } as Stripe.InvoicePayment,
    ]);
    await f.service.handleEvent(event("customer.subscription.updated", old));
    expect(f.stripe.subscriptions.cancel.mock.calls[0]![0]).toBe(old.id);
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
    expect(old.metadata.opengeni_duplicate_refund_from).toBe("200");
  });

  test("a delayed deletion of a prior subscription cannot demote or refund a new one", async () => {
    const f = fixture();
    f.add();
    f.setState({ plan_key: "pro", stripe_subscription_id: "sub_main" });
    const old = f.add(subscription({ id: "sub_old", status: "canceled" }));
    await f.service.handleEvent(event("customer.subscription.deleted", old));
    expect(f.save).not.toHaveBeenCalled();
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  });

  test("funding timestamps, not invoice creation, separate historical payments from late duplicate funding", async () => {
    const f = fixture();
    f.add(subscription({ created: 200 }));
    f.setState({ plan_key: "pro", stripe_subscription_id: "sub_main" });
    const old = f.add(subscription({ id: "sub_old_active", created: 1 }));
    const paidInvoice = invoice(old.id, "in_mixed");
    paidInvoice.created = 100;
    paidInvoice.status_transitions.paid_at = 300;
    f.invoices.set(paidInvoice.id, paidInvoice);
    f.payments.set(paidInvoice.id, [
      {
        payment: { type: "charge", charge: "ch_historical" },
        status_transitions: { paid_at: 150 },
      },
      { payment: { type: "charge", charge: "ch_late" }, status_transitions: { paid_at: 300 } },
    ] as Stripe.InvoicePayment[]);
    for (const chargeId of ["ch_historical", "ch_late"])
      f.charges.set(chargeId, {
        id: chargeId,
        amount: 2000,
        amount_refunded: 0,
      } as Stripe.Charge);
    await f.service.handleEvent(event("invoice.paid", paidInvoice));
    expect(f.charges.get("ch_historical")?.amount_refunded).toBe(0);
    expect(f.charges.get("ch_late")?.amount_refunded).toBe(2000);
    await f.service.handleEvent(event("invoice.paid", paidInvoice));
    expect(f.stripe.refunds.create).toHaveBeenCalledTimes(1);
  });

  test("missing funding timestamps never turn invoice.created into payment evidence", async () => {
    const f = fixture();
    f.add();
    const loser = f.add(subscription({ id: "sub_duplicate", created: 200 }));
    const paidInvoice = f.invoices.get("in_sub_duplicate")!;
    paidInvoice.status_transitions.paid_at = null;
    f.payments.set(paidInvoice.id, [
      { payment: { type: "charge", charge: "ch_duplicate" } } as Stripe.InvoicePayment,
    ]);
    await expect(f.service.handleEvent(event("invoice.paid", paidInvoice))).rejects.toThrow(
      "authoritative funding timestamp",
    );
    expect(loser.status).toBe("canceled");
    expect(f.stripe.refunds.create).not.toHaveBeenCalled();
  });
});

describe("default-off and billing authority", () => {
  test("disabled webhook paths create no state, perform no Stripe I/O, and new endpoints return 404", async () => {
    const f = fixture(false);
    expect(await f.service.handleEvent(event("invoice.paid", invoice()))).toBe(true);
    expect(f.timeline).toEqual([]);
    expect(f.stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(await f.service.handleEvent(event("checkout.session.completed", {}))).toBe(false);
    const app = new Hono();
    registerBillingRoutes(app, {
      db: {},
      settings: testSettings({ billingMode: "stripe", subscriptionPlansEnabled: false }),
    } as never);
    for (const action of ["plans", "checkout", "upgrade", "change", "cancel", "portal"]) {
      const response = await app.request(`/v1/billing/subscription/${action}`, {
        method: action === "plans" ? "GET" : "POST",
      });
      expect(response.status).toBe(404);
    }
  });

  test("uses the existing selected-organization billing permission check", () => {
    const context = {
      defaultAccountId: accountId,
      accountGrants: [{ accountId, permissions: ["billing:read"] }],
    } as Parameters<typeof requireSelectedAccount>[0];
    expect(requireSelectedAccount(context, undefined, "billing:read")).toBe(accountId);
    expect(() => requireSelectedAccount(context, undefined, "billing:manage")).toThrow(
      "missing permission",
    );
    expect(() => requireSelectedAccount(context, crypto.randomUUID(), "billing:read")).toThrow(
      "missing permission",
    );
  });
});

test("all first-use customer callers serialize read/create/persist and recover a DB rollback with the same provider key", async () => {
  let queue = Promise.resolve();
  let customerId: string | null = null;
  let failSave = true;
  const create = mock(async () => ({ id: "cus_only", email: null }));
  const update = mock(async () => ({ id: "cus_only", email: null }));
  const locked = async (run: (tx: StripeCustomerTransaction) => Promise<string>) => {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await run({
        read: async () => customerId,
        account: async () => ({ name: "Org" }),
        save: async (customer) => {
          if (failSave) {
            failSave = false;
            throw new Error("database rollback");
          }
          customerId = customer.id;
        },
      });
    } finally {
      release();
    }
  };
  const input = {
    stripe: { customers: { create, update } } as unknown as Stripe,
    accountId,
    provider: "stripe:test",
    locked,
  };
  await expect(
    serializedStripeCustomer({ ...input, email: "first-admin@example.test" }),
  ).rejects.toThrow("database rollback");
  expect(
    await Promise.all(
      Array.from({ length: 4 }, () =>
        serializedStripeCustomer({ ...input, email: "second-admin@example.test" }),
      ),
    ),
  ).toEqual(Array(4).fill("cus_only"));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
  expect((create.mock.calls[0] as unknown[])[1]).toEqual({
    idempotencyKey: `billing-customer:stripe:test:${accountId}`,
  });
});
