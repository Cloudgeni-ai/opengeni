import type {
  BillingSubscriptionCatalog,
  BillingSubscriptionChange,
  SubscriptionPlan,
} from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import Stripe from "stripe";
import type { BillingSubscriptionOperationKind } from "@opengeni/db";
import type { SubscriptionAccountStore, SubscriptionStore } from "./billing-subscription-store";

const terminal = (subscription: Stripe.Subscription) =>
  subscription.status === "canceled" || subscription.status === "incomplete_expired";
const liveSubscription = (subscription: Stripe.Subscription) =>
  !terminal(subscription) && subscription.status !== "unpaid";
const id = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;

type MutationIntent = {
  subscriptionId: string;
  customerId: string;
  itemId: string;
  priceId: string;
  periodStart: number;
  periodEnd: number;
  scheduleId: string | null;
  phaseStart: number;
  planKey: string;
  targetPriceId: string | null;
};
type MutationResult =
  | { response: BillingSubscriptionChange }
  | { error: string; status: 409 | 422 };

class SubscriptionMutationRejected extends Error {}

/** Enterprise is assigned only by operators, never inferred from an embedder. */
export function selfServicePlan(plan: SubscriptionPlan): boolean {
  return (
    plan.key !== "enterprise" &&
    plan.key !== "free" &&
    !plan.freeCredit &&
    Boolean(plan.stripePriceId) &&
    (plan.monthlyPriceMicros ?? 0) > 0
  );
}

export function subscriptionItem(subscription: Stripe.Subscription): Stripe.SubscriptionItem {
  const item = subscription.items.data[0];
  if (
    subscription.items.has_more ||
    subscription.items.data.length !== 1 ||
    !item ||
    item.quantity !== 1 ||
    item.price.currency !== "usd" ||
    item.price.recurring?.interval !== "month" ||
    item.price.recurring.interval_count !== 1 ||
    !Number.isSafeInteger(item.current_period_start) ||
    !Number.isSafeInteger(item.current_period_end) ||
    item.current_period_end <= item.current_period_start
  ) {
    throw new Error(`Subscription ${subscription.id} must have one monthly USD plan item`);
  }
  return item;
}

export function subscriptionCheckoutParams(input: {
  accountId: string;
  customerId: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "subscription",
    customer: input.customerId,
    customer_update: { address: "auto", name: "auto" },
    automatic_tax: { enabled: true },
    billing_address_collection: "auto",
    line_items: [{ price: input.priceId, quantity: 1 }],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // No Checkout/PaymentIntent credit metadata: subscription fees are never
    // top-ups in the existing refund/dispute handlers.
    subscription_data: { metadata: { opengeni_account_id: input.accountId } },
  };
}

export function subscriptionWebhookEvent(event: Stripe.Event): boolean {
  return [
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_failed",
  ].includes(event.type);
}

export class StripeSubscriptions {
  constructor(
    private readonly stripe: Stripe,
    private readonly store: SubscriptionStore,
    private readonly enabled: boolean,
    private readonly provider: "stripe:live" | "stripe:test",
  ) {}

  private requireEnabled() {
    if (!this.enabled)
      throw new HTTPException(404, { message: "subscription plans are not enabled" });
  }

  async catalog(accountId: string): Promise<BillingSubscriptionCatalog> {
    this.requireEnabled();
    const catalog = await this.store.catalog();
    return await this.store.locked(accountId, async (tx) => ({
      accountId,
      revision: catalog.revision,
      plans: catalog.plans.map((plan) => ({ ...plan, selfService: selfServicePlan(plan) })),
      plan: await tx.balance(),
    }));
  }

  private async paidPlan(key: string) {
    const { plans } = await this.store.catalog();
    const plan = plans.find((candidate) => candidate.key === key && selfServicePlan(candidate));
    if (!plan) throw new HTTPException(422, { message: "plan is not available for self-service" });
    const price = await this.stripe.prices.retrieve(plan.stripePriceId!);
    if (
      !price.active ||
      price.currency !== "usd" ||
      price.recurring?.interval !== "month" ||
      price.recurring.interval_count !== 1 ||
      price.billing_scheme !== "per_unit" ||
      price.unit_amount === null ||
      price.unit_amount * 10_000 !== plan.monthlyPriceMicros
    ) {
      throw new HTTPException(422, {
        message: "plan Stripe price does not match the runtime catalog",
      });
    }
    return plan;
  }

  private async subscriptions(customer: string, accountId: string) {
    const subscriptions: Stripe.Subscription[] = [];
    for await (const subscription of this.stripe.subscriptions.list({
      customer,
      status: "all",
      limit: 100,
    })) {
      if (subscription.metadata.opengeni_account_id === accountId) subscriptions.push(subscription);
    }
    return subscriptions;
  }

  async checkout(input: {
    accountId: string;
    customerId: string;
    planKey: string;
    idempotencyKey: string;
    successUrl: string;
    cancelUrl: string;
  }) {
    this.requireEnabled();
    const plan = await this.paidPlan(input.planKey);
    return await this.store.locked(input.accountId, async (tx) => {
      const state = await tx.state();
      if (
        state?.plan_key === "enterprise" ||
        (await this.subscriptions(input.customerId, input.accountId)).some(liveSubscription)
      ) {
        throw new HTTPException(409, {
          message: "organization already has a subscription; manage it instead",
        });
      }
      const session = await this.stripe.checkout.sessions.create(
        subscriptionCheckoutParams({
          ...input,
          priceId: plan.stripePriceId!,
        }),
        { idempotencyKey: `subscription-checkout:${input.accountId}:${input.idempotencyKey}` },
      );
      if (!session.url)
        throw new HTTPException(502, { message: "Stripe did not return a checkout URL" });
      return { checkoutSessionId: session.id, url: session.url };
    });
  }

  private async current(tx: SubscriptionAccountStore, accountId: string) {
    const state = await tx.state();
    if (!state?.stripe_subscription_id || state.plan_key === "enterprise") {
      throw new HTTPException(409, { message: "organization has no self-service subscription" });
    }
    const subscription = await this.stripe.subscriptions.retrieve(state.stripe_subscription_id);
    if (
      subscription.metadata.opengeni_account_id !== accountId ||
      id(subscription.customer) !== (await tx.customer(this.provider)) ||
      !liveSubscription(subscription)
    ) {
      throw new HTTPException(409, { message: "subscription is not available" });
    }
    return subscription;
  }

  /** Two independent commits are essential: provider success cannot roll back
   * the immutable target when local reconciliation fails. Replays resolve the
   * receipt before looking at the organization's current subscription/catalog. */
  private async mutate(
    kind: BillingSubscriptionOperationKind,
    input: { accountId: string; idempotencyKey: string; planKey?: string },
    prepare: (tx: SubscriptionAccountStore) => Promise<MutationIntent>,
    execute: (
      tx: SubscriptionAccountStore,
      intent: MutationIntent,
      key: string,
    ) => Promise<BillingSubscriptionChange>,
  ): Promise<BillingSubscriptionChange> {
    this.requireEnabled();
    const request = input.planKey === undefined ? {} : { planKey: input.planKey };
    await this.store.locked(input.accountId, async (tx) => {
      const existing = await tx.operation(input.idempotencyKey);
      if (existing) {
        if (existing.kind !== kind || JSON.stringify(existing.request) !== JSON.stringify(request))
          throw new HTTPException(409, {
            message: "idempotency key was already used for a different request",
          });
        return;
      }
      await tx.beginOperation({
        operationKey: input.idempotencyKey,
        kind,
        request,
        intent: await prepare(tx),
      });
    });
    const outcome = await this.store.locked(
      input.accountId,
      async (tx): Promise<MutationResult> => {
        const receipt = await tx.operation(input.idempotencyKey);
        if (!receipt) throw new Error("Committed subscription operation intent is missing");
        if (receipt.result) return receipt.result as MutationResult;
        let result: MutationResult;
        try {
          result = {
            response: await execute(
              tx,
              receipt.intent as MutationIntent,
              `subscription-${kind}:${input.accountId}:${input.idempotencyKey}`,
            ),
          };
        } catch (error) {
          // Only definitive provider rejection or a pre-mutation conflict can
          // finish an unsuccessful intent. Transport/DB errors remain pending.
          if (error instanceof HTTPException && (error.status === 409 || error.status === 422))
            result = { error: error.message, status: error.status };
          else if (error instanceof SubscriptionMutationRejected)
            result = { error: error.message, status: 422 };
          else throw error;
        }
        await tx.completeOperation(input.idempotencyKey, result);
        return result;
      },
    );
    if ("error" in outcome) throw new HTTPException(outcome.status, { message: outcome.error });
    return outcome.response;
  }

  private async providerMutation<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeCardError ||
        error instanceof Stripe.errors.StripeInvalidRequestError
      )
        throw new SubscriptionMutationRejected(error.message);
      throw error;
    }
  }

  private intent(
    subscription: Stripe.Subscription,
    planKey: string,
    targetPriceId: string | null,
  ): MutationIntent {
    const item = subscriptionItem(subscription);
    return {
      subscriptionId: subscription.id,
      customerId: id(subscription.customer)!,
      itemId: item.id,
      priceId: item.price.id,
      periodStart: item.current_period_start,
      periodEnd: item.current_period_end,
      scheduleId: id(subscription.schedule) ?? null,
      phaseStart: item.current_period_start,
      planKey,
      targetPriceId,
    };
  }

  private async target(accountId: string, intent: MutationIntent) {
    const subscription = await this.stripe.subscriptions.retrieve(intent.subscriptionId);
    if (
      subscription.metadata.opengeni_account_id !== accountId ||
      id(subscription.customer) !== intent.customerId
    )
      throw new Error("Subscription operation target ownership changed");
    return subscription;
  }

  private async unchanged(
    tx: SubscriptionAccountStore,
    subscription: Stripe.Subscription,
    intent: MutationIntent,
  ) {
    const item = subscriptionItem(subscription);
    const state = await tx.state();
    if (
      state?.plan_key === "enterprise" ||
      state?.stripe_subscription_id !== intent.subscriptionId ||
      !liveSubscription(subscription) ||
      item.id !== intent.itemId ||
      item.price.id !== intent.priceId ||
      item.current_period_start !== intent.periodStart ||
      item.current_period_end !== intent.periodEnd
    )
      throw new HTTPException(409, {
        message: "original subscription changed; start a new operation",
      });
  }

  /** Stripe fails the entire update for an incomplete immediate payment. Only
   * its paid invoice may replace the old allowance, never the update itself. */
  async upgrade(input: {
    accountId: string;
    planKey: string;
    idempotencyKey: string;
  }): Promise<BillingSubscriptionChange> {
    return await this.mutate(
      "upgrade",
      input,
      async (tx) => {
        const target = await this.paidPlan(input.planKey);
        const subscription = await this.current(tx, input.accountId);
        const item = subscriptionItem(subscription);
        const previous = (await this.store.catalog()).plans.find(
          (plan) => plan.stripePriceId === item.price.id,
        );
        if (!previous || target.monthlyPriceMicros! <= previous.monthlyPriceMicros!) {
          throw new HTTPException(422, { message: "upgrade requires a higher-priced plan" });
        }
        if (
          subscription.schedule ||
          subscription.cancel_at_period_end ||
          subscription.status !== "active"
        ) {
          throw new HTTPException(409, {
            message: "manage the pending change or payment in the billing portal first",
          });
        }
        return this.intent(subscription, target.key, target.stripePriceId!);
      },
      async (tx, intent, key) => {
        const subscription = await this.target(input.accountId, intent);
        const replay = subscription.metadata.opengeni_last_upgrade_key === key;
        if (!replay) {
          await this.unchanged(tx, subscription, intent);
          if (
            subscription.schedule ||
            subscription.cancel_at_period_end ||
            subscription.status !== "active"
          )
            throw new HTTPException(409, {
              message: "original subscription has a pending change or payment",
            });
        }
        // Provider metadata also prevents a retry after Stripe's 24h request-key
        // cache expires from resetting the billing anchor and buying twice.
        const updated = replay
          ? subscription
          : await this.providerMutation(() =>
              this.stripe.subscriptions.update(
                subscription.id,
                {
                  items: [{ id: intent.itemId, price: intent.targetPriceId!, quantity: 1 }],
                  billing_cycle_anchor: "now",
                  proration_behavior: "always_invoice",
                  payment_behavior: "error_if_incomplete",
                  metadata: { opengeni_last_upgrade_key: key },
                },
                { idempotencyKey: key },
              ),
            );
        await this.synchronize(tx, input.accountId, subscription.id, id(updated.latest_invoice));
        return {
          subscriptionId: subscription.id,
          planKey: intent.planKey,
          effectiveAt: new Date(
            subscriptionItem(updated).current_period_start * 1000,
          ).toISOString(),
          cancelAtPeriodEnd: false,
        };
      },
    );
  }

  async change(input: {
    accountId: string;
    planKey: string;
    idempotencyKey: string;
  }): Promise<BillingSubscriptionChange> {
    return await this.mutate(
      "change",
      input,
      async (tx) => {
        const target = await this.paidPlan(input.planKey);
        const subscription = await this.current(tx, input.accountId);
        const item = subscriptionItem(subscription);
        const previous = (await this.store.catalog()).plans.find(
          (plan) => plan.stripePriceId === item.price.id,
        );
        if (
          !previous ||
          target.monthlyPriceMicros! >= previous.monthlyPriceMicros! ||
          subscription.cancel_at_period_end
        ) {
          throw new HTTPException(422, {
            message: "only a lower-priced plan can be scheduled at period end",
          });
        }
        const intent = this.intent(subscription, target.key, target.stripePriceId!);
        if (intent.scheduleId) {
          const schedule = await this.stripe.subscriptionSchedules.retrieve(intent.scheduleId);
          if (!schedule.current_phase)
            throw new HTTPException(409, { message: "subscription schedule has no current phase" });
          intent.phaseStart = schedule.current_phase.start_date;
        }
        return intent;
      },
      async (tx, intent, key) => {
        const subscription = await this.target(input.accountId, intent);
        const response = {
          subscriptionId: intent.subscriptionId,
          planKey: intent.planKey,
          effectiveAt: new Date(intent.periodEnd * 1000).toISOString(),
          cancelAtPeriodEnd: false,
        };
        let schedule: Stripe.SubscriptionSchedule | undefined;
        const scheduleId = intent.scheduleId ?? id(subscription.schedule);
        if (scheduleId) schedule = await this.stripe.subscriptionSchedules.retrieve(scheduleId);
        // A successful schedule update can complete/release before a DB retry.
        // Its marker is durable even after Stripe's request-key cache expires.
        if (!schedule) {
          for await (const candidate of this.stripe.subscriptionSchedules.list({
            customer: intent.customerId,
            limit: 100,
          })) {
            if (
              candidate.metadata?.opengeni_last_change_key === key &&
              (id(candidate.subscription) === intent.subscriptionId ||
                id(candidate.released_subscription) === intent.subscriptionId)
            ) {
              schedule = candidate;
              break;
            }
          }
        }
        if (schedule?.metadata?.opengeni_last_change_key === key) return response;
        await this.unchanged(tx, subscription, intent);
        if (
          subscription.cancel_at_period_end ||
          (intent.scheduleId && id(subscription.schedule) !== intent.scheduleId)
        )
          throw new HTTPException(409, { message: "original subscription schedule changed" });
        schedule ??= await this.providerMutation(() =>
          this.stripe.subscriptionSchedules.create(
            { from_subscription: intent.subscriptionId },
            { idempotencyKey: `${key}:create` },
          ),
        );
        if (!schedule.current_phase)
          throw new HTTPException(409, { message: "subscription schedule has no current phase" });
        await this.providerMutation(() =>
          this.stripe.subscriptionSchedules.update(
            schedule.id,
            {
              end_behavior: "release",
              proration_behavior: "none",
              metadata: { opengeni_last_change_key: key },
              phases: [
                {
                  start_date: intent.phaseStart,
                  end_date: intent.periodEnd,
                  items: [{ price: intent.priceId, quantity: 1 }],
                  proration_behavior: "none",
                },
                {
                  start_date: intent.periodEnd,
                  duration: { interval: "month", interval_count: 1 },
                  items: [{ price: intent.targetPriceId!, quantity: 1 }],
                  proration_behavior: "none",
                  automatic_tax: { enabled: true },
                  metadata: { opengeni_account_id: input.accountId },
                },
              ],
            },
            { idempotencyKey: key },
          ),
        );
        return response;
      },
    );
  }

  async cancel(input: {
    accountId: string;
    idempotencyKey: string;
  }): Promise<BillingSubscriptionChange> {
    return await this.mutate(
      "cancel",
      input,
      async (tx) => this.intent(await this.current(tx, input.accountId), "free", null),
      async (tx, intent, key) => {
        const subscription = await this.target(input.accountId, intent);
        const replay = subscription.metadata.opengeni_last_cancel_key === key;
        if (!replay && !terminal(subscription) && !subscription.cancel_at_period_end) {
          await this.unchanged(tx, subscription, intent);
          if (subscription.schedule && id(subscription.schedule) !== intent.scheduleId)
            throw new HTTPException(409, { message: "original subscription schedule changed" });
          // Release, not cancel, the schedule: preserve the current paid period.
          if (subscription.schedule)
            await this.providerMutation(() =>
              this.stripe.subscriptionSchedules.release(
                id(subscription.schedule)!,
                {},
                { idempotencyKey: `${key}:release` },
              ),
            );
          await this.providerMutation(() =>
            this.stripe.subscriptions.update(
              subscription.id,
              { cancel_at_period_end: true, metadata: { opengeni_last_cancel_key: key } },
              { idempotencyKey: key },
            ),
          );
        }
        await this.synchronize(tx, input.accountId, subscription.id);
        return {
          subscriptionId: subscription.id,
          planKey: "free",
          effectiveAt: new Date(intent.periodEnd * 1000).toISOString(),
          cancelAtPeriodEnd: true,
        };
      },
    );
  }

  async handleEvent(event: Stripe.Event): Promise<boolean> {
    if (!subscriptionWebhookEvent(event)) return false;
    if (!this.enabled) return true;
    const subscriptionEvent = event.type.startsWith("customer.subscription.");
    const object = event.data.object as Stripe.Subscription | Stripe.Invoice;
    const subscriptionId = subscriptionEvent
      ? object.id
      : id((object as Stripe.Invoice).parent?.subscription_details?.subscription);
    if (!subscriptionId) return true;
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    const accountId = subscription.metadata.opengeni_account_id;
    if (!accountId) return true; // Another product on the same Stripe account.
    await this.store.locked(accountId, async (tx) => {
      if (!(await tx.exists())) return;
      // synchronize re-reads AFTER the org fence; event.created is not ordering
      // authority, and another delivery may have committed while we waited.
      await this.synchronize(
        tx,
        accountId,
        subscriptionId,
        event.type === "invoice.paid" ? object.id : undefined,
      );
    });
    return true;
  }

  private async synchronize(
    tx: SubscriptionAccountStore,
    accountId: string,
    subscriptionId: string,
    paidInvoiceId?: string,
  ) {
    const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    if (subscription.metadata.opengeni_account_id !== accountId)
      throw new Error("subscription organization changed");
    const customerId = id(subscription.customer);
    if (!customerId || customerId !== (await tx.customer(this.provider)))
      throw new Error("subscription customer does not match organization");
    const state = await tx.state();
    if (state?.plan_key === "enterprise") return; // Operator assignment wins; no historical refunds.
    if (subscription.metadata.opengeni_duplicate_subscription === "1") {
      await this.rejectDuplicate(subscription);
      return;
    }
    const siblings = await this.subscriptions(customerId, accountId);
    const live = siblings
      .filter(
        (candidate) =>
          liveSubscription(candidate) && candidate.metadata.opengeni_duplicate_subscription !== "1",
      )
      .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
    const bound =
      state?.stripe_subscription_id &&
      live.find((candidate) => candidate.id === state.stripe_subscription_id);
    const canonical = bound || live[0];
    if (canonical && canonical.id !== subscriptionId) {
      // A stale deletion/paid event of a prior legitimate subscription must not
      // refund that past subscription or change the new subscription's state.
      if (liveSubscription(subscription))
        await this.rejectDuplicate(subscription, canonical.created);
      return;
    }
    for (const sibling of live)
      if (sibling.id !== subscriptionId) await this.rejectDuplicate(sibling, subscription.created);
    if (terminal(subscription) || subscription.status === "unpaid") {
      if (state?.stripe_subscription_id === subscriptionId) {
        await tx.save({ planKey: "free", status: "active", stripeSubscriptionId: null });
        await tx.expire();
      }
      // Free eligibility/grants are owned by maintenance, never these events.
      return;
    }
    const item = subscriptionItem(subscription);
    const plan = (await this.store.catalog()).plans.find(
      (candidate) => candidate.stripePriceId === item.price.id && selfServicePlan(candidate),
    );
    if (!plan)
      throw new Error(`Subscription ${subscription.id} price is not in the self-service catalog`);
    if (
      item.price.unit_amount === null ||
      item.price.unit_amount * 10_000 !== plan.monthlyPriceMicros
    )
      throw new Error("subscription price does not match catalog");
    const supported: Record<string, Parameters<SubscriptionAccountStore["save"]>[0]["status"]> = {
      active: "active",
      trialing: "trialing",
      past_due: "past_due",
      paused: "paused",
      incomplete: "incomplete",
    };
    const status = supported[subscription.status];
    if (!status) throw new Error(`Unsupported subscription status: ${subscription.status}`);
    await tx.save({
      planKey: plan.key,
      status,
      stripeSubscriptionId: subscription.id,
      currentPeriodStart: new Date(item.current_period_start * 1000),
      currentPeriodEnd: new Date(item.current_period_end * 1000),
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
    });
    if (!paidInvoiceId || subscription.status !== "active") return;
    const invoice = await this.stripe.invoices.retrieve(paidInvoiceId);
    if (
      invoice.status !== "paid" ||
      id(invoice.parent?.subscription_details?.subscription) !== subscription.id ||
      id(invoice.customer) !== customerId ||
      !["subscription_create", "subscription_cycle", "subscription_update"].includes(
        invoice.billing_reason ?? "",
      )
    )
      return;
    // Old paid invoices must never fund a newer period/price. v22 period bounds
    // live on subscription items; invoice coverage is described by its lines.
    let matches = false;
    for await (const line of this.stripe.invoices.listLineItems(invoice.id, { limit: 100 })) {
      if (
        line.parent?.subscription_item_details?.subscription_item === item.id &&
        id(line.pricing?.price_details?.price) === item.price.id &&
        line.period.start === item.current_period_start &&
        line.period.end === item.current_period_end &&
        line.amount >= 0
      )
        matches = true;
    }
    if (matches)
      await tx.replace({
        planKey: plan.key,
        stripeSubscriptionId: subscription.id,
        periodStart: new Date(item.current_period_start * 1000),
        periodEnd: new Date(item.current_period_end * 1000),
      });
  }

  private async rejectDuplicate(subscription: Stripe.Subscription, canonicalCreated?: number) {
    const storedCutoff = Number(subscription.metadata.opengeni_duplicate_refund_from);
    const refundFrom =
      Number.isSafeInteger(storedCutoff) && storedCutoff > 0
        ? storedCutoff
        : (canonicalCreated ?? subscription.created);
    // Persist the loser identity before canceling: replay after DB rollback or
    // cancellation still refunds it and can never adopt it as the current plan.
    if (subscription.metadata.opengeni_duplicate_subscription !== "1") {
      await this.stripe.subscriptions.update(
        subscription.id,
        {
          metadata: {
            opengeni_duplicate_subscription: "1",
            opengeni_duplicate_refund_from: String(refundFrom),
          },
        },
        { idempotencyKey: `subscription-duplicate:${subscription.id}:mark` },
      );
    }
    if (!terminal(subscription))
      await this.stripe.subscriptions.cancel(
        subscription.id,
        { prorate: false, invoice_now: false },
        { idempotencyKey: `subscription-duplicate:${subscription.id}:cancel` },
      );
    // Invoice payments moved off invoice.payment_intent in v22. Refund paid
    // duplicate-period invoices, including payments arriving after cancellation.
    for await (const invoice of this.stripe.invoices.list({
      subscription: subscription.id,
      status: "paid",
      limit: 100,
    })) {
      // An old, previously legitimate subscription can become a live loser
      // after a later subscription takes over. Never refund its prior history.
      for await (const payment of this.stripe.invoicePayments.list({
        invoice: invoice.id,
        status: "paid",
        limit: 100,
      })) {
        const fundedAt = payment.status_transitions?.paid_at ?? invoice.status_transitions?.paid_at;
        if (!Number.isSafeInteger(fundedAt) || !fundedAt || fundedAt < 0)
          throw new Error(`Paid invoice ${invoice.id} has no authoritative funding timestamp`);
        if (fundedAt < refundFrom) continue;
        let chargeId = id(payment.payment.charge);
        const paymentIntentId = id(payment.payment.payment_intent);
        if (paymentIntentId)
          chargeId = id((await this.stripe.paymentIntents.retrieve(paymentIntentId)).latest_charge);
        if (!chargeId)
          throw new Error(
            `Duplicate subscription invoice ${invoice.id} has no refundable Stripe charge`,
          );
        const charge = await this.stripe.charges.retrieve(chargeId);
        const remaining = charge.amount - charge.amount_refunded;
        if (remaining > 0)
          await this.stripe.refunds.create(
            { charge: charge.id, amount: remaining },
            {
              idempotencyKey: `subscription-duplicate-refund:${charge.id}:${charge.amount_refunded}`,
            },
          );
      }
    }
  }
}
