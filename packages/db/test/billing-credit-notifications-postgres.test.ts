import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  createDb,
  ensureManagedAccessForUser,
  withRlsContext,
  upsertOrganizationPlan,
  grantPlanCreditPeriod,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import {
  claimBillingCreditNotification,
  enqueueBillingCreditNotification,
  evaluateBillingCreditAlerts,
  getBillingAlertSettings,
  updateBillingAlertSettings,
  listBillingCreditNotifications,
  markBillingCreditNotificationRead,
  settleBillingCreditNotification,
  withBillingCreditDeliveryAuthority,
  unusualCreditSpend,
} from "../src/billing-credit-notifications";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";
import {
  loadRuntimePostureBaseline,
  readRuntimePostureBaseline,
} from "../../../scripts/runtime-posture-baseline";
import { resolve } from "node:path";

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase("credit-alerts", "credit_alerts_data");
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(fixture.appUrl, { max: 4, searchPath: fixture.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

async function account() {
  const userId = crypto.randomUUID();
  await fixture!
    .admin`insert into auth_users(id,name,email,email_verified) values(${userId},'Credit owner',${`${userId}@example.test`},true)`;
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Credit owner",
  });
  return { accountId: access.defaultAccountId!, subjectId: `user:${userId}`, userId };
}
async function ledger(
  accountId: string,
  amount: number,
  type = "grant",
  agoHours = 0,
  scope: string[] | null = null,
) {
  await fixture!
    .admin`insert into credit_ledger_entries(account_id,amount_micros,type,source_type,source_id,idempotency_key,eligible_model_ids,created_at)
    values(${accountId},${amount},${type},'credit-alert-test',${crypto.randomUUID()},${crypto.randomUUID()},${scope},clock_timestamp()-${agoHours}*interval '1 hour')`;
}
async function due(accountId: string) {
  await withRlsContext(client!.db, { accountId }, async (tx) => {
    await tx.execute(
      sql`update billing_credit_alert_settings set checked_at=null where account_id=${accountId}::uuid`,
    );
  });
}
const message = (_kind: unknown, _details: unknown, email: string) => ({
  from: "test@example.test",
  to: email,
  subject: "Credits",
  text: "Credits",
  html: "<p>Credits</p>",
});
const claim = (accountId: string) =>
  claimBillingCreditNotification(client!.db, {
    accountId,
    sender: "test@example.test",
    providerScope: "test-v1",
    retentionSeconds: 86400,
    message,
  });
const enqueue = (accountId: string, operationKey = crypto.randomUUID()) =>
  enqueueBillingCreditNotification(client!.db, {
    accountId,
    operationKey,
    kind: "topup_success",
    details: { availableBalanceMicros: 20_000_000, amountMicros: 10_000_000 },
  });

test("candidate and pinned previous binary accept new tables, invoker trigger and exact runtime grants", async () => {
  if (!client || !fixture) return;
  const options = {
    targetSchema: fixture.schema,
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
  };
  await assertRuntimeDatabasePosture(client.db, options);
  const root = resolve(import.meta.dir, "../../..");
  const pin = await readRuntimePostureBaseline(root);
  const baseline = await loadRuntimePostureBaseline(root, pin.sourceCommit);
  try {
    await baseline.module.assertRuntimeDatabasePosture(client.db, options);
  } finally {
    await baseline.cleanup();
  }
}, 180_000);

test("settings default to $10, validate integer micros and isolate tenants at runtime", async () => {
  if (!client) return;
  const a = await account(),
    b = await account();
  expect(await getBillingAlertSettings(client.db, a.accountId)).toEqual({
    accountId: a.accountId,
    lowBalanceThresholdMicros: 10_000_000,
  });
  await updateBillingAlertSettings(client.db, {
    accountId: a.accountId,
    lowBalanceThresholdMicros: 5_000_000,
  });
  await expect(
    updateBillingAlertSettings(client.db, {
      accountId: a.accountId,
      lowBalanceThresholdMicros: -1,
    }),
  ).rejects.toThrow();
  await withRlsContext(client.db, { accountId: b.accountId }, async (tx) => {
    expect(
      await rawRows(
        tx,
        sql`select * from billing_credit_alert_settings where account_id=${a.accountId}::uuid`,
      ),
    ).toEqual([]);
  });
  await expect(
    withRlsContext(client.db, { accountId: b.accountId }, async (tx) => {
      await tx.execute(
        sql`insert into billing_credit_alert_settings(account_id) values (${a.accountId}::uuid)`,
      );
    }),
  ).rejects.toThrow();
});

test("runtime cannot forge billing recipients", async () => {
  if (!client) return;
  const a = await account();
  await expect(
    withRlsContext(client.db, { accountId: a.accountId }, async (tx) => {
      await tx.execute(
        sql`delete from billing_credit_notification_recipients where account_id=${a.accountId}::uuid`,
      );
    }),
  ).rejects.toThrow();
});

test("unfunded and scoped-only accounts stay silent; four workers claim one crossing; recovery rearms", async () => {
  if (!client) return;
  const a = await account();
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toEqual([]);
  await ledger(a.accountId, 15_000_000, "grant", 0, ["test/model"]);
  await due(a.accountId);
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toEqual([]);
  await ledger(a.accountId, 20_000_000);
  await due(a.accountId);
  await evaluateBillingCreditAlerts(client.db, a.accountId);
  await ledger(a.accountId, -12_000_000, "model_usage");
  await due(a.accountId);
  const ids = (
    await Promise.all(
      Array.from({ length: 4 }, () => evaluateBillingCreditAlerts(client!.db, a.accountId)),
    )
  ).flat();
  expect(ids).toHaveLength(1);
  expect((await listBillingCreditNotifications(client.db, a))[0]?.kind).toBe("low_balance");
  await due(a.accountId);
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toEqual([]);
  await ledger(a.accountId, -8_000_000, "model_usage");
  await due(a.accountId);
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toHaveLength(1);
  await ledger(a.accountId, 30_000_000);
  await due(a.accountId);
  await evaluateBillingCreditAlerts(client.db, a.accountId);
  await ledger(a.accountId, -25_000_000, "model_usage");
  await due(a.accountId);
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toHaveLength(1);
  expect((await listBillingCreditNotifications(client.db, a)).map((n) => n.kind)).toEqual([
    "low_balance",
    "exhausted",
    "low_balance",
  ]);
});

test("keyed top-up enqueue binds original details and fanout once across workers", async () => {
  if (!client) return;
  const a = await account();
  const key = crypto.randomUUID();
  const ids = await Promise.all(Array.from({ length: 4 }, () => enqueue(a.accountId, key)));
  expect(new Set(ids).size).toBe(1);
  await expect(
    enqueueBillingCreditNotification(client.db, {
      accountId: a.accountId,
      operationKey: key,
      kind: "topup_failed",
      details: { availableBalanceMicros: 0 },
    }),
  ).rejects.toThrow("different details");
  expect(await listBillingCreditNotifications(client.db, a)).toHaveLength(1);
  await markBillingCreditNotificationRead(client.db, { ...a, notificationId: ids[0]! });
  expect((await listBillingCreditNotifications(client.db, a))[0]?.read).toBe(true);
});

test("pending plan expiry is exhausted before maintenance writes an expiry debit", async () => {
  if (!client) return;
  const a = await account();
  const periodStart = new Date(Date.now() - 48 * 3_600_000),
    periodEnd = new Date(Date.now() + 24 * 3_600_000);
  const stripeSubscriptionId = `sub_${crypto.randomUUID()}`;
  await upsertOrganizationPlan(client.db, {
    accountId: a.accountId,
    planKey: "pro",
    status: "active",
    stripeSubscriptionId,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  await grantPlanCreditPeriod(client.db, {
    accountId: a.accountId,
    planKey: "pro",
    periodStart,
    periodEnd,
    stripeSubscriptionId,
  });
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toEqual([]);
  await fixture!
    .admin`update plan_credit_periods set period_end=now()-interval '1 hour' where account_id=${a.accountId}`;
  await due(a.accountId);
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toHaveLength(1);
  expect((await listBillingCreditNotifications(client.db, a))[0]?.kind).toBe("exhausted");
});

test("concurrent email claims, failed retry and uncertain crash retry retain exact key and payload", async () => {
  if (!client) return;
  const a = await account();
  await enqueue(a.accountId);
  const claims = (await Promise.all(Array.from({ length: 4 }, () => claim(a.accountId)))).filter(
    (c) => c !== null,
  );
  expect(claims).toHaveLength(1);
  const first = claims[0]!;
  await settleBillingCreditNotification(client.db, first, {
    status: "failed",
    errorClass: "refused",
  });
  await fixture!
    .admin`update billing_credit_notification_deliveries set next_attempt_at=now()-interval '1 minute' where id=${first.id}`;
  const second = (await claim(a.accountId))!;
  expect(second.id).toBe(first.id);
  expect(second.message).toEqual(first.message);
  expect(second.claimId).not.toBe(first.claimId);
  await settleBillingCreditNotification(client.db, first, { status: "sent" }); // stale ACK cannot settle the new claim
  await fixture!
    .admin`update billing_credit_notification_deliveries set lease_until=now()-interval '1 minute' where id=${first.id}`;
  const crash = (await claim(a.accountId))!;
  expect(crash.id).toBe(first.id);
  expect(crash.message).toEqual(first.message);
  await settleBillingCreditNotification(client.db, crash, { status: "outcome_unknown" });
  await fixture!
    .admin`update billing_credit_notification_deliveries set next_attempt_at=now()-interval '1 minute',retry_before=now()-interval '1 second' where id=${first.id}`;
  expect(await claim(a.accountId)).toBeNull();
});

test("revocation hides inbox and suppresses I/O even after durable claim", async () => {
  if (!client) return;
  const a = await account();
  await enqueue(a.accountId);
  const pending = (await claim(a.accountId))!;
  await fixture!
    .admin`update organization_memberships set status='suspended' where account_id=${a.accountId} and subject_id=${a.subjectId}`;
  expect(await listBillingCreditNotifications(client.db, a)).toEqual([]);
  let sent = false;
  expect(
    await withBillingCreditDeliveryAuthority(client.db, pending, async () => {
      sent = true;
      return true;
    }),
  ).toBeNull();
  expect(sent).toBe(false);
});

test("retry deadline is rechecked after claim and expired ambiguity survives settlement", async () => {
  if (!client) return;
  const a = await account();
  await enqueue(a.accountId);
  const first = (await claim(a.accountId))!;
  await settleBillingCreditNotification(client.db, first, { status: "outcome_unknown" });
  await fixture!
    .admin`update billing_credit_notification_deliveries set next_attempt_at=now()-interval '1 minute',retry_before=clock_timestamp()+interval '31 seconds' where id=${first.id}`;
  const retry = (await claim(a.accountId))!;
  expect(retry).not.toBeNull();
  // Simulate a delay after claim but within its one-minute lease.
  await fixture!
    .admin`update billing_credit_notification_deliveries set retry_before=clock_timestamp()-interval '1 second' where id=${retry.id}`;
  let sends = 0;
  expect(
    await withBillingCreditDeliveryAuthority(client.db, retry, async () => ++sends),
  ).toBeNull();
  expect(sends).toBe(0);
  await settleBillingCreditNotification(client.db, retry, { status: "suppressed" });
  const [saved] = await fixture!
    .admin`select status,error_class,attempt_count from billing_credit_notification_deliveries where id=${retry.id}`;
  expect(saved).toMatchObject({
    status: "outcome_unknown",
    error_class: "idempotency_window_expired",
    attempt_count: 2,
  });
  expect(await claim(a.accountId)).toBeNull();
});

test("non-idempotent transport can dispatch its initial claim but never a retry", async () => {
  if (!client) return;
  const a = await account();
  await enqueue(a.accountId);
  const initial = (await claimBillingCreditNotification(client.db, {
    accountId: a.accountId,
    sender: "test@example.test",
    providerScope: "no-retention",
    retentionSeconds: 0,
    message,
  }))!;
  expect(initial).not.toBeNull();
  let sends = 0;
  expect(await withBillingCreditDeliveryAuthority(client.db, initial, async () => ++sends)).toBe(1);
  await settleBillingCreditNotification(client.db, initial, { status: "outcome_unknown" });
  await fixture!
    .admin`update billing_credit_notification_deliveries set next_attempt_at=now()-interval '1 minute' where id=${initial.id}`;
  expect(await claim(a.accountId)).toBeNull();
  expect(sends).toBe(1);
});

test("caller transaction rollback removes the notification and its recipient obligations", async () => {
  if (!client) return;
  const a = await account();
  const operationKey = crypto.randomUUID();
  await expect(
    client.db.transaction(async (tx) => {
      await enqueueBillingCreditNotification(tx, {
        accountId: a.accountId,
        operationKey,
        kind: "topup_success",
        details: { availableBalanceMicros: 12_000_000, amountMicros: 12_000_000 },
      });
      throw new Error("rollback-charge-and-notice");
    }),
  ).rejects.toThrow("rollback-charge-and-notice");
  expect(await listBillingCreditNotifications(client.db, a)).toEqual([]);
});

test("migration backfill projects existing memberships under the restricted migration owner", async () => {
  if (!client || !fixture) return;
  const a = await account();
  const source = await Bun.file(
    resolve(import.meta.dir, "../drizzle/1241_billing_credit_notifications.sql"),
  ).text();
  const start = source.indexOf("DO $backfill$");
  const endMarker = "END $backfill$;";
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  await fixture.admin`delete from billing_credit_notification_recipients where account_id=${a.accountId}`;
  await fixture.admin.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${fixture!.ownerRole}"`);
    const [role] = await tx`select rolsuper,rolbypassrls from pg_roles where rolname=current_user`;
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
    await tx.unsafe(source.slice(start, end + endMarker.length));
  });
  const rows =
    await fixture.admin`select subject_id from billing_credit_notification_recipients where account_id=${a.accountId}`;
  expect(rows.map((r) => r.subject_id)).toEqual([a.subjectId]);
});

test("ordinary members receive nothing and a changed email cannot reuse a frozen message", async () => {
  if (!client) return;
  const a = await account();
  await fixture!
    .admin`update organization_memberships set role='member' where account_id=${a.accountId} and subject_id=${a.subjectId}`;
  await enqueue(a.accountId);
  expect(await listBillingCreditNotifications(client.db, a)).toEqual([]);
  await fixture!
    .admin`update organization_memberships set role='admin' where account_id=${a.accountId} and subject_id=${a.subjectId}`;
  await enqueue(a.accountId);
  const first = (await claim(a.accountId))!;
  await settleBillingCreditNotification(client.db, first, { status: "outcome_unknown" });
  await fixture!
    .admin`update auth_users set email=${`new-${a.userId}@example.test`} where id=${a.userId}`;
  await fixture!
    .admin`update billing_credit_notification_deliveries set next_attempt_at=now()-interval '1 minute' where id=${first.id}`;
  expect(await claim(a.accountId)).toBeNull();
});

test("spend floors, baseline history, excluded reversals, recovery and rolling-day suppression", async () => {
  expect(
    unusualCreditSpend({
      historyHours: 23.99,
      baselineSpendMicros: 0,
      lastHourSpendMicros: 10_000_000,
    }),
  ).toBe(false);
  expect(
    unusualCreditSpend({
      historyHours: 168,
      baselineSpendMicros: 0,
      lastHourSpendMicros: 9_999_999,
    }),
  ).toBe(false);
  expect(
    unusualCreditSpend({
      historyHours: 24,
      baselineSpendMicros: 48_000_000,
      lastHourSpendMicros: 10_000_000,
    }),
  ).toBe(true);
  if (!client) return;
  const a = await account();
  await ledger(a.accountId, 100_000_000, "grant", 48);
  await ledger(a.accountId, -15_000_000, "credit_refund");
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toEqual([]);
  await ledger(a.accountId, -10_000_000, "model_usage");
  await due(a.accountId);
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toHaveLength(1);
  await due(a.accountId);
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toEqual([]);
  await fixture!
    .admin`update credit_ledger_entries set created_at=now()-interval '2 hours' where account_id=${a.accountId} and type='model_usage'`;
  await due(a.accountId);
  await evaluateBillingCreditAlerts(client.db, a.accountId);
  await ledger(a.accountId, -10_000_000, "model_usage");
  await due(a.accountId);
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toEqual([]);
  await fixture!
    .admin`update billing_credit_alert_settings set last_unusual_at=now()-interval '25 hours',checked_at=null where account_id=${a.accountId}`;
  expect(await evaluateBillingCreditAlerts(client.db, a.accountId)).toHaveLength(1);
});
