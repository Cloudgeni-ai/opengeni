import { afterAll, beforeAll, expect, test } from "bun:test";
import type Stripe from "stripe";
import { sql } from "drizzle-orm";
import type { ApiRouteDeps } from "@opengeni/core";
import { deliverBillingCreditNotification } from "@opengeni/core";
import { testSettings } from "@opengeni/testing/settings";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  applyCreditLedgerEntryOnce,
  autoTopUpCreditKey,
  billingAutoTopUpStore,
  createDb,
  enqueueBillingAutoTopUpNotification,
  ensureManagedAccessForUser,
  getCreditLedgerEntry,
  listBillingCreditAlertAccounts,
  upsertBillingCustomer,
  withAccountRls,
  type AutoTopUpIntent,
  type AutoTopUpOperation,
  type DbClient,
} from "@opengeni/db";
import { autoTopUpPaymentMetadata } from "../src/billing-auto-top-up";
import { billingAutoTopUpMaintenance } from "../src/billing-auto-top-up-maintenance";
import { createBillingAutoTopUpService } from "../src/routes/billing-auto-top-up";
import { handleStripeWebhookEvent } from "../src/routes/billing";

let fixture: RestrictedRuntimeTestDatabase | null = null,
  client: DbClient | null = null;
beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase(
    "auto-top-up-integration",
    "topup_integration_data",
  );
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(fixture.appUrl, { searchPath: fixture.schema, max: 2 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

async function ready() {
  const userId = crypto.randomUUID(),
    email = `${userId}@example.test`;
  await fixture!
    .admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Top-up owner',${email},true)`;
  const accountId = (
    await ensureManagedAccessForUser(client!.db, { userId, email, name: "Top-up owner" })
  ).defaultAccountId!;
  const subject = `user:${userId}`,
    customerId = `cus_${userId}`,
    methodId = `pm_${userId}`;
  const store = billingAutoTopUpStore(client!.db, enqueueBillingAutoTopUpNotification);
  const request = {
    accountId,
    enabled: true,
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: 100_000_000,
    idempotencyKey: crypto.randomUUID(),
  };
  await store.locked(accountId, (account) => account.update(subject, request));
  await upsertBillingCustomer(client!.db, {
    accountId,
    provider: "stripe:test",
    providerCustomerId: customerId,
    email,
  });
  await store.locked(accountId, async (account) => {
    const key = crypto.randomUUID();
    await account.startSetup(subject, key, "stripe:test", customerId);
    await account.finishSetup({
      key,
      subject,
      provider: "stripe:test",
      customerId,
      methodId,
      brand: "visa",
      last4: "4242",
    });
  });
  const intent: AutoTopUpIntent = {
    provider: "stripe:test",
    customerId,
    paymentMethodId: methodId,
    consentSubject: subject,
    settingsRevision: request.idempotencyKey,
    taxCalculationId: "taxcalc_test",
    taxExpiresAt: 2_000_000_000,
    receiptEmail: email,
  };
  const reserve = async () =>
    store.locked(accountId, async (account) => {
      const operation = await account.reserve({
        key: crypto.randomUUID(),
        creditMicros: 25_000_000,
        chargeMicros: 27_500_000,
        intent,
      });
      await account.bind(operation.operation_key, `pi_${operation.operation_key}`);
      await account.markConfirmation(operation.operation_key);
      return (await account.operation(operation.operation_key))!;
    });
  const deps = {
    db: client!.db,
    settings: testSettings({
      billingMode: "stripe",
      stripeSecretKey: "sk_test_fixture",
      billingAutoTopUpEnabled: false,
    }),
  } as ApiRouteDeps;
  return { accountId, subject, email, store, request, reserve, deps };
}

function payment(
  operation: AutoTopUpOperation,
  status: "succeeded" | "canceled",
): Stripe.PaymentIntent {
  return {
    id: operation.payment_intent_id!,
    status,
    livemode: false,
    currency: "usd",
    customer: operation.intent.customerId,
    amount: operation.charge_micros / 10_000,
    amount_received: status === "succeeded" ? operation.charge_micros / 10_000 : 0,
    payment_method: operation.intent.paymentMethodId,
    capture_method: "automatic",
    hooks: { inputs: { tax: { calculation: operation.intent.taxCalculationId } } },
    metadata: autoTopUpPaymentMetadata(operation),
    latest_charge:
      status === "succeeded"
        ? {
            paid: true,
            payment_intent: operation.payment_intent_id,
            livemode: false,
            created: Math.floor(Date.now() / 1000),
          }
        : null,
  } as Stripe.PaymentIntent;
}
function provider(value: Stripe.PaymentIntent) {
  let reads = 0;
  return {
    stripe: {
      paymentIntents: {
        retrieve: async (id: string) => {
          expect(id).toBe(value.id);
          reads++;
          return value;
        },
      },
    } as unknown as Stripe,
    reads: () => reads,
  };
}
function event(value: Stripe.PaymentIntent): Stripe.Event {
  return {
    id: `evt_${crypto.randomUUID()}`,
    type: value.status === "succeeded" ? "payment_intent.succeeded" : "payment_intent.canceled",
    livemode: false,
    data: { object: value },
  } as Stripe.Event;
}
async function notifications(accountId: string) {
  return fixture!
    .admin`select kind,details,operation_key from billing_credit_notifications where account_id=${accountId} order by created_at,id`;
}

test("maintenance discovers organizations and races webhook recovery with one grant, outbox receipt and owner delivery while charging is off", async () => {
  if (!client) return;
  const f = await ready(),
    operation = await f.reserve(),
    paid = payment(operation, "succeeded"),
    p = provider(paid);
  await f.store.locked(f.accountId, (account) =>
    account.update(f.subject, {
      ...f.request,
      enabled: false,
      idempotencyKey: crypto.randomUUID(),
    }),
  );
  const service = createBillingAutoTopUpService(f.deps, p.stripe);
  const failures: unknown[] = [],
    runner = billingAutoTopUpMaintenance({
      discover: (after, limit) => listBillingCreditAlertAccounts(client!.db, after, limit),
      process: (id) => service.process(id),
      onError: (error) => {
        failures.push(error);
      },
    });
  await Promise.all([runner.run(), handleStripeWebhookEvent(f.deps, p.stripe, event(paid))]);
  await runner.run();
  await handleStripeWebhookEvent(f.deps, p.stripe, event(paid));
  expect(failures).toEqual([]);
  expect(p.reads()).toBeGreaterThan(0);
  expect(
    (
      await getCreditLedgerEntry(
        client.db,
        f.accountId,
        autoTopUpCreditKey(operation.operation_key),
      )
    )?.amountMicros,
  ).toBe(25_000_000);
  const rows = await notifications(f.accountId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.kind).toBe("topup_success");
  expect(rows[0]!.details.amountMicros).toBe(25_000_000);
  const deliveries = await fixture!
    .admin`select subject_id,status from billing_credit_notification_deliveries where account_id=${f.accountId}`;
  expect(deliveries).toEqual([
    expect.objectContaining({ subject_id: f.subject, status: "pending" }),
  ]);
  const sent: { to: string; text: string }[] = [];
  const deliver = () =>
    deliverBillingCreditNotification({
      db: client!.db,
      accountId: f.accountId,
      appUrl: "https://app.test",
      transport: {
        sender: "sender@example.test",
        idempotency: { scope: "test-v1", retentionSeconds: 86400 },
        send: async (message) => {
          sent.push(message);
          return { status: "sent", providerMessageId: "test-delivery" };
        },
      },
    });
  expect(await deliver()).toBe(true);
  expect(await deliver()).toBe(false);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe(f.email);
  expect(sent[0]!.text).toContain("Credits added: $25.00");
  expect(sent[0]!.text).not.toContain("invoice");
}, 180_000);

test("webhook failure disables settings and commits one actionable shared-outbox notification", async () => {
  if (!client) return;
  const f = await ready(),
    operation = await f.reserve(),
    canceled = payment(operation, "canceled"),
    p = provider(canceled);
  await handleStripeWebhookEvent(f.deps, p.stripe, event(canceled));
  await handleStripeWebhookEvent(f.deps, p.stripe, event(canceled));
  await createBillingAutoTopUpService(f.deps, p.stripe).process(f.accountId);
  const settings = await createBillingAutoTopUpService(f.deps, p.stripe).settings(f.accountId);
  expect(settings.enabled).toBe(false);
  expect(settings.status).toBe("payment_failed");
  expect(settings.failureReason).toBeTruthy();
  expect(
    await getCreditLedgerEntry(client.db, f.accountId, autoTopUpCreditKey(operation.operation_key)),
  ).toBeNull();
  expect((await notifications(f.accountId)).map((row) => row.kind)).toEqual(["topup_failed"]);
}, 180_000);

test("settlement rollback also rolls back the shared outbox and delivery checkpoint, then retry commits once", async () => {
  if (!client) return;
  const f = await ready(),
    operation = await f.reserve();
  await expect(
    f.store.locked(f.accountId, async (account) => {
      await account.succeeded(operation, new Date().toISOString());
      expect(await notifications(f.accountId)).toHaveLength(0);
      throw new Error("crash before transaction commit");
    }),
  ).rejects.toThrow("crash before transaction commit");
  expect(await notifications(f.accountId)).toHaveLength(0);
  expect(
    await getCreditLedgerEntry(client.db, f.accountId, autoTopUpCreditKey(operation.operation_key)),
  ).toBeNull();
  const pending = await f.store.locked(f.accountId, (account) => account.pending());
  expect(pending?.notification_delivered_at).toBeNull();
  const p = provider(payment(operation, "succeeded"));
  await createBillingAutoTopUpService(f.deps, p.stripe).process(f.accountId);
  expect(await notifications(f.accountId)).toHaveLength(1);
  expect(
    (await f.store.locked(f.accountId, (account) => account.operation(operation.operation_key)))
      ?.notification_delivered_at,
  ).toBeTruthy();
}, 180_000);

test("old terminal operations without a port are enqueued by maintenance while new charges stay disabled", async () => {
  if (!client) return;
  const f = await ready(),
    operation = await f.reserve();
  await billingAutoTopUpStore(client.db).locked(f.accountId, (account) =>
    account.succeeded(operation, new Date().toISOString()),
  );
  expect(await notifications(f.accountId)).toHaveLength(0);
  // No provider method exists: recovery of an already-settled operation is local.
  await createBillingAutoTopUpService(f.deps, {} as Stripe).process(f.accountId);
  await createBillingAutoTopUpService(f.deps, {} as Stripe).process(f.accountId);
  expect((await notifications(f.accountId)).map((row) => row.kind)).toEqual(["topup_success"]);
}, 180_000);

test("repeated cap notification preserves the committed balance snapshot and refuses a different event", async () => {
  if (!client) return;
  const f = await ready();
  const cap = () =>
    f.store.locked(f.accountId, async (account) =>
      account.capReached((await account.settings())!, 27_500_000),
    );
  await cap();
  const [original] = await notifications(f.accountId);
  await applyCreditLedgerEntryOnce(client.db, {
    accountId: f.accountId,
    type: "credit_topup",
    amountMicros: 5_000_000,
    sourceType: "test",
    sourceId: "test",
    idempotencyKey: crypto.randomUUID(),
  });
  await Promise.all([cap(), cap()]);
  expect(await notifications(f.accountId)).toEqual([original]);
  await expect(
    f.store.locked(f.accountId, (account) =>
      enqueueBillingAutoTopUpNotification(account.tx, {
        accountId: f.accountId,
        operationKey: original!.operation_key,
        kind: "topup_failed",
        amountMicros: 25_000_000,
        chargeMicros: 0,
      }),
    ),
  ).rejects.toThrow("different event");
  const other = await ready();
  const foreign = await withAccountRls(client.db, other.accountId, async (tx) =>
    tx.execute(
      sql`select id from billing_credit_notifications where account_id=${f.accountId}::uuid`,
    ),
  );
  expect(foreign).toHaveLength(0);
}, 180_000);
