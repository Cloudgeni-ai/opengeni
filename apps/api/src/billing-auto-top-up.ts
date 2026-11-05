import Stripe from "stripe";
import type { BillingAutoTopUpSettings } from "@opengeni/contracts";
import {
  autoTopUpCreditKey,
  AutoTopUpStoreError,
  type AutoTopUpAccountStore,
  type AutoTopUpIntent,
  type AutoTopUpOperation,
  type AutoTopUpSettingsRow,
  type AutoTopUpStore,
} from "@opengeni/db";

export type AutoTopUpDecision =
  | "off"
  | "payment_method_required"
  | "payment_failed"
  | "processing"
  | "cap_reached"
  | "ready";
class AutoTopUpPrerequisiteError extends Error {}
export function decideAutoTopUp(input: {
  settings: AutoTopUpSettingsRow | null;
  pending: boolean;
  spent: number;
  chargeMicros?: number;
}): AutoTopUpDecision {
  if (input.pending) return "processing";
  if (input.settings?.failure_reason) return "payment_failed";
  if (!input.settings?.enabled) return "off";
  if (!input.settings.payment_method_id) return "payment_method_required";
  if (
    input.spent +
      (input.chargeMicros ?? input.settings.cap_required_micros ?? input.settings.amount_micros) >
    input.settings.monthly_cap_micros
  )
    return "cap_reached";
  return "ready";
}

function id(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function autoTopUpPaymentMetadata(operation: AutoTopUpOperation): Stripe.MetadataParam {
  return {
    opengeni_account_id: operation.account_id,
    opengeni_auto_top_up_operation: operation.operation_key,
    opengeni_credit_micros: String(operation.credit_micros),
    opengeni_credit_idempotency_key: autoTopUpCreditKey(operation.operation_key),
    opengeni_credit_coupon_v1: "1",
    opengeni_auto_top_up_v1: "1",
  };
}

/** No network result grants money until its exact customer, mode, amount, currency,
 * tax quote and immutable operation all match. Never trust webhook ordering. */
export function assertAutoTopUpPayment(
  operation: AutoTopUpOperation,
  payment: Stripe.PaymentIntent,
): void {
  const metadata = autoTopUpPaymentMetadata(operation);
  const paymentMethodId = id(payment.payment_method);
  const clearedAfterFailure =
    paymentMethodId === null && ["requires_payment_method", "canceled"].includes(payment.status);
  if (
    (operation.payment_intent_id && operation.payment_intent_id !== payment.id) ||
    payment.livemode !== (operation.intent.provider === "stripe:live") ||
    payment.currency !== "usd" ||
    id(payment.customer) !== operation.intent.customerId ||
    payment.amount !== operation.charge_micros / 10_000 ||
    (paymentMethodId !== operation.intent.paymentMethodId && !clearedAfterFailure) ||
    payment.capture_method !== "automatic" ||
    payment.hooks?.inputs?.tax?.calculation !== operation.intent.taxCalculationId ||
    Object.entries(metadata).some(([key, value]) => payment.metadata[key] !== value)
  ) {
    throw new Error("Automatic top-up payment does not match its durable reservation");
  }
  if (payment.status === "succeeded" && payment.amount_received !== payment.amount) {
    throw new Error("Automatic top-up payment was not received in full");
  }
}

export class StripeAutoTopUps {
  constructor(
    private readonly stripe: Stripe,
    private readonly store: AutoTopUpStore,
    private readonly options: {
      enabled: boolean;
      provider: AutoTopUpIntent["provider"];
      creditsProductId?: string;
    },
  ) {}

  async settings(accountId: string): Promise<BillingAutoTopUpSettings> {
    return await this.store.locked(accountId, async (account) => {
      const settings = await account.settings();
      const spent = await account.spent();
      return {
        accountId,
        enabled: settings?.enabled ?? false,
        thresholdMicros: settings?.threshold_micros ?? 10_000_000,
        amountMicros: settings?.amount_micros ?? 25_000_000,
        monthlyCapMicros: settings?.monthly_cap_micros ?? 100_000_000,
        spentThisMonthMicros: spent,
        status: decideAutoTopUp({ settings, spent, pending: Boolean(await account.pending()) }),
        paymentMethod: settings?.payment_method_id
          ? { brand: settings.payment_method_brand!, last4: settings.payment_method_last4! }
          : null,
        failureReason: settings?.failure_reason ?? null,
      };
    });
  }

  /** Bounded one-operation pass. The caller's maintenance scheduler supplies account
   * IDs; an advisory discovery result never grants consent or payment authority. */
  async process(accountId: string): Promise<void> {
    const operation = await this.store.locked(accountId, async (account) => {
      await account.deliverOutstanding();
      const pending = await account.pending();
      if (pending) return pending; // Recovery runs even after user/deployment disable.
      if (!this.options.enabled) return null;
      const settings = await account.settings();
      const spent = await account.spent();
      const decision = decideAutoTopUp({ settings, spent, pending: false });
      if (decision === "cap_reached") {
        await account.capReached(settings!);
        return null;
      }
      if (
        decision !== "ready" ||
        !settings ||
        (await account.balance()) >= settings.threshold_micros
      )
        return null;
      try {
        await account.assertOwner(settings.consent_subject!);
      } catch (error) {
        if (!(error instanceof AutoTopUpStoreError) || error.status !== 403) throw error;
        await account.failBeforePayment(
          settings,
          "The consenting owner no longer owns this organization. An owner must enable top-ups again.",
        );
        return null;
      }
      let customer: Stripe.Customer;
      try {
        customer = await this.validCustomer(account, settings);
      } catch (error) {
        if (
          error instanceof AutoTopUpPrerequisiteError ||
          (error instanceof Stripe.errors.StripeInvalidRequestError &&
            error.code === "resource_missing")
        ) {
          await account.failBeforePayment(
            settings,
            "This organization's saved card is unavailable or belongs to another billing currency or Stripe mode. Set up a USD card and enable top-ups again.",
          );
          return null;
        }
        throw error;
      }
      const key = crypto.randomUUID();
      // A Tax calculation moves no money. Its exact tax-inclusive amount is
      // reserved before any PaymentIntent creation or confirmation.
      const tax = await this.stripe.tax.calculations.create({
        currency: "usd",
        customer: customer.id,
        line_items: [
          {
            amount: settings.amount_micros / 10_000,
            reference: key,
            tax_behavior: "exclusive",
            ...(this.options.creditsProductId ? { product: this.options.creditsProductId } : {}),
          },
        ],
      });
      if (
        !tax.id ||
        tax.currency !== "usd" ||
        tax.livemode !== (this.options.provider === "stripe:live") ||
        tax.customer !== customer.id ||
        !Number.isSafeInteger(tax.amount_total) ||
        tax.amount_total * 10_000 < settings.amount_micros ||
        !tax.expires_at ||
        tax.expires_at <= Date.now() / 1000 + 60
      )
        throw new Error("Stripe returned an unusable automatic top-up tax calculation");
      if (
        decideAutoTopUp({
          settings,
          spent,
          pending: false,
          chargeMicros: tax.amount_total * 10_000,
        }) === "cap_reached"
      ) {
        await account.capReached(settings, tax.amount_total * 10_000);
        return null;
      }
      return await account.reserve({
        key,
        creditMicros: settings.amount_micros,
        chargeMicros: tax.amount_total * 10_000,
        intent: {
          provider: this.options.provider,
          customerId: customer.id,
          paymentMethodId: settings.payment_method_id!,
          consentSubject: settings.consent_subject!,
          settingsRevision: settings.revision,
          taxCalculationId: tax.id,
          taxExpiresAt: tax.expires_at,
          receiptEmail: customer.email,
        },
      });
    });
    if (!operation) return;

    // Unconfirmed creates can safely leave orphaned *uncharged* objects after
    // lost responses and Stripe's request cache expiry. Only one canonical ID
    // can bind in PostgreSQL, and nothing confirms a merely returned ID.
    await this.store.locked(accountId, async (account) => {
      const current = await account.operation(operation.operation_key);
      if (!current || current.state !== "pending" || current.payment_intent_id) return;
      if (current.intent.provider !== this.options.provider)
        throw new Error(
          "Automatic top-up Stripe mode changed; restore the original mode to reconcile",
        );
      const candidates: Stripe.PaymentIntent[] = [];
      for await (const candidate of this.stripe.paymentIntents.list({
        customer: current.intent.customerId,
        created: { gte: Math.floor(new Date(current.created_at).getTime() / 1000) - 60 },
        limit: 100,
      })) {
        if (candidate.metadata.opengeni_auto_top_up_operation !== current.operation_key) continue;
        assertAutoTopUpPayment(current, candidate);
        candidates.push(candidate);
      }
      if (
        candidates.some(
          (p) =>
            !["requires_confirmation", "requires_payment_method", "canceled"].includes(p.status),
        )
      ) {
        throw new Error(
          "An unbound automatic top-up PaymentIntent unexpectedly progressed; reconciliation required",
        );
      }
      let payment = candidates
        .filter((p) => p.status !== "canceled")
        .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))[0];
      const settings = await account.settings();
      if (
        !payment &&
        (!this.options.enabled ||
          !settings?.enabled ||
          current.intent.taxExpiresAt <= Date.now() / 1000 + 60)
      ) {
        await account.failed(
          current,
          "Automatic top-up stopped before payment. Enable it again when ready.",
        );
        return;
      }
      if (!payment)
        payment = await this.stripe.paymentIntents.create(
          {
            amount: current.charge_micros / 10_000,
            currency: "usd",
            customer: current.intent.customerId,
            payment_method: current.intent.paymentMethodId,
            payment_method_types: ["card"],
            confirm: false,
            capture_method: "automatic",
            metadata: autoTopUpPaymentMetadata(current),
            hooks: { inputs: { tax: { calculation: current.intent.taxCalculationId } } },
            description: "Opengeni automatic credit top-up",
            ...(current.intent.receiptEmail ? { receipt_email: current.intent.receiptEmail } : {}),
          },
          { idempotencyKey: `auto-top-up:create:${current.operation_key}` },
        );
      assertAutoTopUpPayment(current, payment);
      await account.bind(current.operation_key, payment.id);
    });

    // This marker commits before confirmation, independently of the settlement
    // transaction. It is not a lease and never authorizes a different PI.
    await this.store.locked(accountId, async (account) => {
      const current = await account.operation(operation.operation_key);
      if (
        !current ||
        current.state !== "pending" ||
        !current.payment_intent_id ||
        current.confirmation_started_at
      )
        return;
      const settings = await account.settings();
      if (
        this.options.enabled &&
        settings?.enabled &&
        (await account.spent()) <= settings.monthly_cap_micros
      ) {
        await account.markConfirmation(current.operation_key);
      }
    });
    await this.store.locked(accountId, async (account) => {
      const current = await account.operation(operation.operation_key);
      if (!current || current.state !== "pending" || !current.payment_intent_id) return;
      let payment = await this.stripe.paymentIntents.retrieve(current.payment_intent_id, {
        expand: ["latest_charge"],
      });
      assertAutoTopUpPayment(current, payment);
      if (await this.settle(account, current, payment)) return;
      const settings = await account.settings();
      let ownerActive = true;
      try {
        await account.assertOwner(current.intent.consentSubject);
      } catch (error) {
        if (!(error instanceof AutoTopUpStoreError) || error.status !== 403) throw error;
        ownerActive = false;
      }
      if (
        !this.options.enabled ||
        !settings?.enabled ||
        !ownerActive ||
        !current.confirmation_started_at ||
        current.intent.taxExpiresAt <= Date.now() / 1000 + 60 ||
        (await account.spent()) > settings.monthly_cap_micros ||
        payment.status === "requires_action" ||
        payment.status === "requires_payment_method" ||
        payment.last_payment_error
      ) {
        await this.cancel(
          account,
          current,
          payment,
          payment.status === "requires_action" ||
            payment.status === "requires_payment_method" ||
            payment.last_payment_error
            ? "Your card could not be charged off-session. Update the card and enable automatic top-ups again."
            : "Automatic top-up stopped before payment. Enable it again when ready.",
        );
        return;
      }
      if (payment.status !== "requires_confirmation") return;
      // Settings/settlement share this fence. If this connection dies while the
      // provider request continues, a retry still targets this *same* PI.
      try {
        payment = await this.stripe.paymentIntents.confirm(
          current.payment_intent_id,
          { off_session: true, error_on_requires_action: true, expand: ["latest_charge"] },
          { idempotencyKey: `auto-top-up:confirm:${current.operation_key}` },
        );
      } catch (error) {
        // Even a card error can race a webhook. Re-read Stripe instead of
        // treating a transport error or local rollback as payment failure.
        if (!(error instanceof Stripe.errors.StripeCardError)) throw error;
        payment = await this.stripe.paymentIntents.retrieve(current.payment_intent_id, {
          expand: ["latest_charge"],
        });
      }
      assertAutoTopUpPayment(current, payment);
      if (await this.settle(account, current, payment)) return;
      if (
        payment.status === "requires_action" ||
        payment.status === "requires_payment_method" ||
        payment.last_payment_error
      ) {
        await this.cancel(
          account,
          current,
          payment,
          "Your card could not be charged off-session. Update the card and enable automatic top-ups again.",
        );
      }
    });
  }

  private async validCustomer(
    account: AutoTopUpAccountStore,
    settings: AutoTopUpSettingsRow,
  ): Promise<Stripe.Customer> {
    if (
      settings.provider !== this.options.provider ||
      !settings.customer_id ||
      settings.customer_id !== (await account.customer(this.options.provider))
    )
      throw new AutoTopUpPrerequisiteError("Automatic top-up customer or Stripe mode mismatch");
    const customer = await this.stripe.customers.retrieve(settings.customer_id);
    const method = await this.stripe.paymentMethods.retrieve(settings.payment_method_id!);
    if (
      customer.deleted ||
      customer.livemode !== (this.options.provider === "stripe:live") ||
      (customer.currency && customer.currency !== "usd") ||
      customer.metadata.opengeni_account_id !== account.accountId ||
      method.livemode !== customer.livemode ||
      id(method.customer) !== customer.id ||
      method.type !== "card"
    ) {
      throw new AutoTopUpPrerequisiteError(
        "Automatic top-up requires this organization's saved USD card in the correct Stripe mode",
      );
    }
    return customer;
  }

  private async settle(
    account: AutoTopUpAccountStore,
    operation: AutoTopUpOperation,
    payment: Stripe.PaymentIntent,
  ): Promise<boolean> {
    if (payment.status === "succeeded") {
      const charge =
        typeof payment.latest_charge === "string"
          ? await this.stripe.charges.retrieve(payment.latest_charge)
          : payment.latest_charge;
      if (
        !charge ||
        !charge.paid ||
        id(charge.payment_intent) !== payment.id ||
        charge.livemode !== payment.livemode
      ) {
        throw new Error("Automatic top-up payment has no authoritative paid charge");
      }
      await account.succeeded(operation, new Date(charge.created * 1000).toISOString());
      return true;
    }
    if (payment.status === "canceled") {
      await account.failed(
        operation,
        "Automatic top-up was canceled. Update the card and enable it again.",
      );
      return true;
    }
    return false;
  }
  private async cancel(
    account: AutoTopUpAccountStore,
    operation: AutoTopUpOperation,
    payment: Stripe.PaymentIntent,
    reason: string,
  ): Promise<void> {
    // Processing is uncertain, not a failure. Keep its cap reservation until
    // Stripe establishes either a successful payment or a canceled PI.
    if (payment.status === "processing") return;
    let canceled: Stripe.PaymentIntent;
    try {
      canceled = await this.stripe.paymentIntents.cancel(
        payment.id,
        {},
        { idempotencyKey: `auto-top-up:cancel:${operation.operation_key}` },
      );
    } catch (error) {
      const latest = await this.stripe.paymentIntents.retrieve(payment.id, {
        expand: ["latest_charge"],
      });
      assertAutoTopUpPayment(operation, latest);
      if (await this.settle(account, operation, latest)) return;
      throw error;
    }
    assertAutoTopUpPayment(operation, canceled);
    if (canceled.status === "canceled") await account.failed(operation, reason);
    else await this.settle(account, operation, canceled);
  }

  async handlePaymentIntent(eventPayment: Stripe.PaymentIntent): Promise<boolean> {
    if (eventPayment.metadata?.opengeni_auto_top_up_v1 !== "1") return false;
    const accountId = eventPayment.metadata.opengeni_account_id;
    const key = eventPayment.metadata.opengeni_auto_top_up_operation;
    if (!accountId || !key || !uuid.test(accountId) || !uuid.test(key))
      throw new Error("Invalid automatic top-up webhook identity");
    await this.store.locked(accountId, async (account) => {
      const operation = await account.operation(key);
      if (!operation) return; // Other deployment sharing this Stripe account.
      if (operation.intent.provider !== this.options.provider)
        throw new Error("Automatic top-up webhook mode mismatch");
      if (operation.payment_intent_id !== eventPayment.id) return; // Unconfirmed orphan, never funding authority.
      const payment = await this.stripe.paymentIntents.retrieve(eventPayment.id, {
        expand: ["latest_charge"],
      });
      assertAutoTopUpPayment(operation, payment);
      if (operation.state !== "pending") {
        await account.deliver(key);
        return;
      }
      if (await this.settle(account, operation, payment)) return;
      if (
        payment.status === "requires_action" ||
        payment.status === "requires_payment_method" ||
        payment.last_payment_error
      ) {
        await this.cancel(
          account,
          operation,
          payment,
          "Your card could not be charged off-session. Update the card and enable automatic top-ups again.",
        );
      }
    });
    return true;
  }

  async handleSetup(session: Stripe.Checkout.Session): Promise<boolean> {
    if (session.metadata?.opengeni_auto_top_up_setup !== "1") return false;
    if (
      session.mode !== "setup" ||
      session.status !== "complete" ||
      session.livemode !== (this.options.provider === "stripe:live")
    )
      throw new Error("Invalid automatic top-up setup mode");
    const accountId = session.metadata.opengeni_account_id;
    const key = session.metadata.opengeni_setup_key;
    const subject = session.metadata.opengeni_setup_subject;
    if (
      !accountId ||
      !key ||
      !subject ||
      !uuid.test(accountId) ||
      !uuid.test(key) ||
      !id(session.setup_intent)
    )
      throw new Error("Invalid automatic top-up setup identity");
    const setup = await this.stripe.setupIntents.retrieve(id(session.setup_intent)!);
    const method = await this.stripe.paymentMethods.retrieve(id(setup.payment_method)!);
    if (
      setup.status !== "succeeded" ||
      setup.usage !== "off_session" ||
      setup.livemode !== session.livemode ||
      id(setup.customer) !== id(session.customer) ||
      id(method.customer) !== id(session.customer) ||
      method.livemode !== session.livemode ||
      method.type !== "card" ||
      !method.card ||
      setup.metadata?.opengeni_account_id !== accountId ||
      setup.metadata?.opengeni_setup_key !== key
    )
      throw new Error("Automatic top-up setup does not match this organization's card");
    await this.store.locked(accountId, async (account) => {
      if ((await account.customer(this.options.provider)) !== id(session.customer))
        throw new Error("Automatic top-up setup customer mismatch");
      await account.finishSetup({
        key,
        subject,
        provider: this.options.provider,
        customerId: id(session.customer)!,
        methodId: method.id,
        brand: method.card!.brand,
        last4: method.card!.last4,
      });
    });
    return true;
  }
}
