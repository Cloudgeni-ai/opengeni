/** Explicit operator proof, never part of automatic unit discovery. No live keys. */
import Stripe from "stripe";
import { sql } from "drizzle-orm";
import { acquireRestrictedRuntimeTestDatabase } from "@opengeni/testing/shared-pg";
import {
  applyCreditLedgerEntryOnce,
  billingAutoTopUpStore,
  createDb,
  ensureManagedAccessForUser,
  enqueueBillingAutoTopUpNotification,
  getCreditLedgerEntry,
  autoTopUpCreditKey,
  listBillingCreditAlertAccounts,
  upsertBillingCustomer,
  type AutoTopUpStore,
} from "@opengeni/db";
import type { ApiRouteDeps } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import { rawRows } from "../../../packages/db/src/database";
import { StripeAutoTopUps } from "../src/billing-auto-top-up";
import { billingAutoTopUpMaintenance } from "../src/billing-auto-top-up-maintenance";
import { createBillingAutoTopUpService } from "../src/routes/billing-auto-top-up";
import { handleStripeWebhookEvent } from "../src/routes/billing";

export async function runStripeAutoTopUpProof(input: {
  key: string;
  userId: string;
  accountId: string;
}) {
  if (!/^(sk|rk)_test_/.test(input.key))
    throw new Error("Only an explicitly verified Stripe test key is accepted");
  const stripe = new Stripe(input.key, { maxNetworkRetries: 0 });
  const fixture = await acquireRestrictedRuntimeTestDatabase(
    "auto-top-up-stripe-proof",
    "stripe_proof_data",
  );
  if (!fixture) throw new Error("Real restricted PostgreSQL is required");
  const client = createDb(fixture.appUrl, { max: 2, searchPath: fixture.schema });
  const customerIds: string[] = [];
  const sessionIds: string[] = [];
  const evidence: Record<string, unknown> = {
    accountId: input.accountId,
    stripeMode: "test",
    productionTouched: false,
  };
  const require = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  try {
    await fixture.admin`insert into auth_users(id,name,email,email_verified)
      values (${input.userId}, 'Stripe proof owner', 'auto-topup-81ed4694@example.test', true)`;
    await fixture.admin`insert into managed_accounts(id, name, external_source, external_id)
      values (${input.accountId}, 'Stripe proof local mirror', 'better-auth:user', ${input.userId})`;
    const context = await ensureManagedAccessForUser(client.db, {
      userId: input.userId,
      email: "auto-topup-81ed4694@example.test",
      name: "Stripe proof owner",
    });
    require(context.defaultAccountId ===
      input.accountId, "Local fixture identity does not match the dedicated staging organization");
    const customer = await stripe.customers.create({
      name: "Opengeni auto-top-up test 81ed4694",
      email: "auto-topup-81ed4694@example.test",
      address: {
        line1: "510 Townsend St",
        city: "San Francisco",
        state: "CA",
        postal_code: "94103",
        country: "US",
      },
      metadata: { opengeni_account_id: input.accountId, opengeni_test_owner: "81ed4694" },
    });
    require(customer.livemode === false, "Stripe returned a live customer");
    customerIds.push(customer.id);
    await upsertBillingCustomer(client.db, {
      accountId: input.accountId,
      provider: "stripe:test",
      providerCustomerId: customer.id,
      email: customer.email,
    });
    const root = billingAutoTopUpStore(client.db, enqueueBillingAutoTopUpNotification);
    let rollbackSettlement = false;
    const store: AutoTopUpStore = {
      locked: (accountId, run) =>
        root.locked(accountId, async (account) => {
          const pending = await account.pending();
          const result = await run(account);
          if (
            rollbackSettlement &&
            pending &&
            (await account.operation(pending.operation_key))?.state === "succeeded"
          ) {
            rollbackSettlement = false;
            throw new Error("proof: local settlement rollback");
          }
          return result;
        }),
    };
    const service = new StripeAutoTopUps(stripe, store, { enabled: true, provider: "stripe:test" });
    const request = {
      accountId: input.accountId,
      enabled: true,
      thresholdMicros: 10_000_000,
      amountMicros: 25_000_000,
      monthlyCapMicros: 100_000_000,
      idempotencyKey: crypto.randomUUID(),
    };
    const subject = `user:${input.userId}`;
    await root.locked(input.accountId, (a) => a.update(subject, request));
    async function setup(paymentMethod: string) {
      const key = crypto.randomUUID();
      const metadata = {
        opengeni_account_id: input.accountId,
        opengeni_auto_top_up_setup: "1",
        opengeni_setup_key: key,
        opengeni_setup_subject: subject,
      };
      await root.locked(input.accountId, (a) =>
        a.startSetup(subject, key, "stripe:test", customer.id),
      );
      const setupIntent = await stripe.setupIntents.create({
        customer: customer.id,
        payment_method: paymentMethod,
        payment_method_types: ["card"],
        usage: "off_session",
        confirm: true,
        metadata,
      });
      require(!setupIntent.livemode &&
        setupIntent.status === "succeeded", "Test card did not complete off-session setup");
      await service.handleSetup({
        id: `cs_fixture_${key}`,
        mode: "setup",
        status: "complete",
        livemode: false,
        customer: customer.id,
        setup_intent: setupIntent.id,
        metadata,
      } as unknown as Stripe.Checkout.Session);
      return setupIntent.id;
    }
    evidence.setupIntentSuccess = await setup("pm_card_visa");
    const setupSession = await stripe.checkout.sessions.create({
      mode: "setup",
      customer: customer.id,
      currency: "usd",
      payment_method_types: ["card"],
      billing_address_collection: "required",
      customer_update: { address: "auto", name: "auto" },
      success_url: "https://staging.app.opengeni.ai/billing?autoTopUp=setup",
      cancel_url: "https://staging.app.opengeni.ai/billing",
      metadata: {
        opengeni_account_id: input.accountId,
        opengeni_auto_top_up_setup: "1",
        opengeni_setup_key: crypto.randomUUID(),
        opengeni_setup_subject: subject,
      },
      setup_intent_data: { metadata: { opengeni_test_owner: "81ed4694" } },
      custom_text: {
        submit: {
          message:
            "Save this card for recurring off-session Opengeni credit top-ups when enabled. Your selected amount plus tax is charged below your threshold, up to your UTC monthly cap. Saving a card does not enable top-ups.",
        },
      },
    });
    require(!setupSession.livemode &&
      setupSession.url, "Stripe Checkout setup did not create a test-mode URL");
    sessionIds.push(setupSession.id);
    evidence.checkoutSetupSession = setupSession.id;

    const create = stripe.paymentIntents.create.bind(stripe.paymentIntents);
    const confirm = stripe.paymentIntents.confirm.bind(stripe.paymentIntents);
    let loseCreate = true,
      loseConfirm = true,
      confirmations = 0;
    stripe.paymentIntents.create = (async (...args: Parameters<typeof create>) => {
      const result = await create(...args);
      require(!result.livemode, "Live PaymentIntent refused");
      if (loseCreate) {
        loseCreate = false;
        throw new Error("proof: lost create response");
      }
      return result;
    }) as typeof stripe.paymentIntents.create;
    stripe.paymentIntents.confirm = (async (...args: Parameters<typeof confirm>) => {
      confirmations++;
      const result = await confirm(...args);
      require(!result.livemode, "Live payment refused");
      if (loseConfirm) {
        loseConfirm = false;
        throw new Error("proof: lost confirm response");
      }
      return result;
    }) as typeof stripe.paymentIntents.confirm;
    async function expectedFailure(message: string) {
      try {
        await service.process(input.accountId);
        throw new Error("Expected injected failure was absent");
      } catch (error) {
        if (!(error instanceof Error) || error.message !== message) throw error;
      }
    }
    await expectedFailure("proof: lost create response");
    await expectedFailure("proof: lost confirm response");
    const operation = await root.locked(input.accountId, (a) => a.pending());
    require(operation?.payment_intent_id &&
      operation.confirmation_started_at, "Canonical PI was not durable before confirmation");
    rollbackSettlement = true;
    await expectedFailure("proof: local settlement rollback");
    require(!(await getCreditLedgerEntry(
      client.db,
      input.accountId,
      autoTopUpCreditKey(operation!.operation_key),
    )), "Rolled-back settlement granted credits");
    const recoveryDeps = {
      db: client.db,
      settings: testSettings({
        billingMode: "stripe",
        stripeSecretKey: input.key,
        billingAutoTopUpEnabled: false,
      }),
    } as ApiRouteDeps;
    const recovery = createBillingAutoTopUpService(recoveryDeps, stripe);
    const recoveryErrors: unknown[] = [];
    const maintenance = billingAutoTopUpMaintenance({
      discover: (after, limit) => listBillingCreditAlertAccounts(client.db, after, limit),
      process: (accountId) => recovery.process(accountId),
      onError: (error) => {
        recoveryErrors.push(error);
      },
    });
    const recoveredPayment = await stripe.paymentIntents.retrieve(operation!.payment_intent_id!);
    await Promise.all([
      maintenance.run(),
      handleStripeWebhookEvent(recoveryDeps, stripe, {
        id: `evt_fixture_${crypto.randomUUID()}`,
        type: "payment_intent.succeeded",
        livemode: false,
        data: { object: recoveredPayment },
      } as Stripe.Event),
      recovery.process(input.accountId),
    ]);
    maintenance.stop();
    require(recoveryErrors.length === 0, "Maintenance recovery failed");
    require(confirmations === 1, "Recovery repeated confirmation despite known success");
    require((
      await getCreditLedgerEntry(
        client.db,
        input.accountId,
        autoTopUpCreditKey(operation!.operation_key),
      )
    )?.amountMicros === 25_000_000, "Success did not grant exactly one paid receipt");
    evidence.recoveredPaymentIntent = operation!.payment_intent_id;
    evidence.recoveredCreditReceipt = autoTopUpCreditKey(operation!.operation_key);
    evidence.taxCalculation = operation!.intent.taxCalculationId;
    evidence.createTimeoutConfirmTimeoutRollbackRecovered = true;
    evidence.disabledMaintenanceAndWebhookRaceRecovered = true;

    await applyCreditLedgerEntryOnce(client.db, {
      accountId: input.accountId,
      type: "test_usage",
      amountMicros: -25_000_000,
      sourceType: "auto_top_up_test",
      sourceId: crypto.randomUUID(),
      idempotencyKey: `proof:consume:${crypto.randomUUID()}`,
    });
    evidence.setupIntentDecline = await setup("pm_card_chargeCustomerFail");
    await service.process(input.accountId);
    const failedSettings = await service.settings(input.accountId);
    require(!failedSettings.enabled &&
      failedSettings.status ===
        "payment_failed", "Decline did not disable and communicate failure");
    const before = confirmations;
    await service.process(input.accountId);
    require(confirmations === before, "Disabled decline retried automatically");
    evidence.declineDisabled = true;
    evidence.setupIntentRetry = await setup("pm_card_visa");
    await root.locked(input.accountId, (a) =>
      a.update(subject, { ...request, idempotencyKey: crypto.randomUUID() }),
    );
    await service.process(input.accountId);
    const afterRetry = await service.settings(input.accountId);
    require(afterRetry.enabled &&
      afterRetry.status === "ready", "Owner-authorized retry did not recover");
    await root.locked(input.accountId, (a) =>
      a.update(subject, {
        ...request,
        monthlyCapMicros: afterRetry.spentThisMonthMicros,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    await applyCreditLedgerEntryOnce(client.db, {
      accountId: input.accountId,
      type: "test_usage",
      amountMicros: -25_000_000,
      sourceType: "auto_top_up_test",
      sourceId: crypto.randomUUID(),
      idempotencyKey: `proof:consume:${crypto.randomUUID()}`,
    });
    await service.process(input.accountId);
    require((await service.settings(input.accountId)).status ===
      "cap_reached", "Tax-inclusive exact cap did not stop subsequent top-ups");
    const intents: {
      id: string;
      status: string;
      amount: number;
      amountReceived: number;
      livemode: boolean;
    }[] = [];
    for await (const payment of stripe.paymentIntents.list({ customer: customer.id, limit: 100 })) {
      require(!payment.livemode, "Proof list contained live payments");
      intents.push({
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        amountReceived: payment.amount_received,
        livemode: payment.livemode,
      });
    }
    require(intents.filter((p) => p.status === "succeeded").length ===
      2, "Proof did not produce exactly two authorized successful payments");
    require(intents.filter((p) => p.status === "canceled").length ===
      1, "Failed PI was not terminally canceled");
    evidence.payments = intents;
    evidence.spentThisMonthMicros = afterRetry.spentThisMonthMicros;
    evidence.notificationKinds = await root.locked(input.accountId, async (account) => {
      const rows = await rawRows<{ kind: string }>(
        account.tx,
        sql`select kind from billing_credit_notifications
        where account_id = ${input.accountId}::uuid order by created_at,id`,
      );
      return rows.map((row) => row.kind);
    });
    require(JSON.stringify(evidence.notificationKinds) ===
      JSON.stringify([
        "topup_success",
        "topup_failed",
        "topup_success",
        "cap_reached",
      ]), "Shared outbox did not contain exactly the committed operation outcomes");
    const [deliveries] =
      await fixture.admin`select count(*)::int as count from billing_credit_notification_deliveries
      where account_id=${input.accountId} and subject_id=${subject} and status='pending'`;
    require(deliveries!.count ===
      4, "Shared outbox did not fan out exactly once to the current owner");
    evidence.sharedOutboxOwnerDeliveries = deliveries!.count;
    evidence.customerId = customer.id;
    return evidence;
  } finally {
    // Keep provider identities in the returned evidence, but remove active test
    // setup/customer resources. Stripe retains immutable payment history.
    const cleanup: { kind: string; id: string; removed: boolean }[] = [];
    for (const id of sessionIds) {
      try {
        await stripe.checkout.sessions.expire(id);
        cleanup.push({ kind: "checkout_session", id, removed: true });
      } catch {
        cleanup.push({ kind: "checkout_session", id, removed: false });
      }
    }
    for (const id of customerIds) {
      try {
        await stripe.customers.del(id);
        cleanup.push({ kind: "customer", id, removed: true });
      } catch {
        cleanup.push({ kind: "customer", id, removed: false });
      }
    }
    evidence.cleanup = cleanup;
    console.log(JSON.stringify({ stripeTestResourceCleanup: cleanup }));
    await client.close();
    await fixture.release();
  }
}
