import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";
import {
  billingAutoTopUpStore,
  createDb,
  ensureManagedAccessForUser,
  upsertBillingCustomer,
  withRlsContext,
  nestedPostgresSqlState,
  type DbClient,
  type AutoTopUpIntent,
} from "../src";
import { rawRows } from "../src/database";
import { assertRuntimeDatabasePosture } from "../src/runtime-posture";

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase("auto-top-up", "topup_data");
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

async function ready(cap = 100_000_000) {
  const userId = crypto.randomUUID();
  const access = await ensureManagedAccessForUser(client!.db, {
    userId,
    email: `${userId}@example.test`,
    name: "Top-up owner",
  });
  const accountId = access.defaultAccountId!;
  const subject = `user:${userId}`;
  const store = billingAutoTopUpStore(client!.db);
  const request = {
    accountId,
    enabled: true,
    thresholdMicros: 10_000_000,
    amountMicros: 25_000_000,
    monthlyCapMicros: cap,
    idempotencyKey: crypto.randomUUID(),
  };
  await store.locked(accountId, (account) => account.update(subject, request));
  await upsertBillingCustomer(client!.db, {
    accountId,
    provider: "stripe:test",
    providerCustomerId: `cus_${userId}`,
    email: null,
  });
  const key = crypto.randomUUID();
  await store.locked(accountId, async (account) => {
    await account.startSetup(subject, key, "stripe:test", `cus_${userId}`);
    await account.finishSetup({
      key,
      subject,
      provider: "stripe:test",
      customerId: `cus_${userId}`,
      methodId: `pm_${userId}`,
      brand: "visa",
      last4: "4242",
    });
  });
  const intent: AutoTopUpIntent = {
    provider: "stripe:test",
    customerId: `cus_${userId}`,
    paymentMethodId: `pm_${userId}`,
    consentSubject: subject,
    settingsRevision: request.idempotencyKey,
    taxCalculationId: "taxcalc_test",
    taxExpiresAt: 2_000_000_000,
    receiptEmail: null,
  };
  return { accountId, subject, store, request, intent };
}
async function state(run: () => Promise<unknown>, expected: string) {
  let error: unknown;
  try {
    await run();
  } catch (caught) {
    error = caught;
  }
  expect(nestedPostgresSqlState(error)).toBe(expected);
}

test("restricted runtime posture accepts the new account-isolated append-only journal", async () => {
  if (!client || !fixture) return;
  await assertRuntimeDatabasePosture(client.db, {
    expectedRole: "opengeni_app",
    rlsStrategy: "force",
    targetSchema: fixture.schema,
  });
}, 180_000);

test("concurrent reservations permit one pending and include tax in the monthly cap", async () => {
  if (!client) return;
  const { store, accountId, intent } = await ready(55_000_000);
  const attempt = () =>
    store.locked(accountId, (account) =>
      account.reserve({
        key: crypto.randomUUID(),
        creditMicros: 25_000_000,
        chargeMicros: 27_500_000,
        intent,
      }),
    );
  const results = await Promise.allSettled(Array.from({ length: 4 }, attempt));
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const first = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof attempt>>
    >
  ).value;
  await store.locked(accountId, async (account) => {
    await account.bind(first.operation_key, `pi_${crypto.randomUUID()}`);
    const bound = (await account.operation(first.operation_key))!;
    await account.succeeded(bound, new Date().toISOString());
    expect(await account.spent()).toBe(27_500_000);
  });
  const second = await attempt();
  await store.locked(accountId, async (account) => {
    await account.bind(second.operation_key, `pi_${crypto.randomUUID()}`);
    await account.succeeded(
      (await account.operation(second.operation_key))!,
      new Date().toISOString(),
    );
  });
  await state(attempt, "P0T01");
}, 180_000);

test("cap notification replays preserve the known tax-inclusive requirement until settings change", async () => {
  if (!client) return;
  const { store, accountId, subject, request } = await ready(25_000_000);
  await store.locked(accountId, async (account) => {
    await account.capReached((await account.settings())!, 27_500_000);
  });
  for (let pass = 0; pass < 3; pass++) {
    await store.locked(accountId, async (account) => {
      await account.capReached((await account.settings())!);
      expect((await account.settings())!.cap_required_micros).toBe(27_500_000);
    });
  }
  await store.locked(accountId, async (account) => {
    await account.update(subject, {
      ...request,
      monthlyCapMicros: 30_000_000,
      idempotencyKey: crypto.randomUUID(),
    });
    expect((await account.settings())!.cap_required_micros).toBeNull();
  });
}, 180_000);

test("settings retries cannot reset spend, replay over newer consent or accept a changed request", async () => {
  if (!client) return;
  const { store, accountId, subject, request, intent } = await ready();
  const op = await store.locked(accountId, (account) =>
    account.reserve({
      key: crypto.randomUUID(),
      creditMicros: 25_000_000,
      chargeMicros: 27_500_000,
      intent,
    }),
  );
  await store.locked(accountId, async (account) => {
    await account.update(subject, {
      ...request,
      enabled: false,
      idempotencyKey: crypto.randomUUID(),
    });
    await account.update(subject, request);
    expect((await account.settings())?.enabled).toBe(false);
    expect(await account.spent()).toBe(op.charge_micros);
    await expect(account.update(subject, { ...request, amountMicros: 30_000_000 })).rejects.toThrow(
      "different top-up settings",
    );
    await expect(
      account.update(subject, {
        ...request,
        monthlyCapMicros: 25_000_000,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("pending top-ups");
  });
}, 180_000);

test("a canonical PI and intent are immutable, success and ledger settlement survive replay once", async () => {
  if (!client) return;
  const { store, accountId, intent } = await ready();
  const op = await store.locked(accountId, (account) =>
    account.reserve({
      key: crypto.randomUUID(),
      creditMicros: 25_000_000,
      chargeMicros: 25_000_000,
      intent,
    }),
  );
  await store.locked(accountId, (account) =>
    account.bind(op.operation_key, `pi_${op.operation_key}`),
  );
  await state(
    () => store.locked(accountId, (account) => account.bind(op.operation_key, "pi_wrong")),
    "23505",
  );
  const chargedAt = new Date().toISOString();
  await Promise.all(
    Array.from({ length: 4 }, () =>
      store.locked(accountId, async (account) => {
        await account.succeeded((await account.operation(op.operation_key))!, chargedAt);
      }),
    ),
  );
  await withRlsContext(client.db, { accountId }, async (tx) => {
    const rows = await rawRows(
      tx,
      sql`select amount_micros from credit_ledger_entries where account_id = ${accountId}::uuid and source_type = 'stripe_auto_top_up'`,
    );
    expect(rows).toHaveLength(1);
  });
}, 180_000);

test("rollback after payment does not lose intent, and late success grants after disable", async () => {
  if (!client) return;
  const { store, accountId, intent, request, subject } = await ready();
  const op = await store.locked(accountId, (account) =>
    account.reserve({
      key: crypto.randomUUID(),
      creditMicros: 25_000_000,
      chargeMicros: 25_000_000,
      intent,
    }),
  );
  await store.locked(accountId, async (account) => {
    await account.bind(op.operation_key, `pi_${op.operation_key}`);
    await account.markConfirmation(op.operation_key);
  });
  await expect(
    store.locked(accountId, async (account) => {
      await account.succeeded(
        (await account.operation(op.operation_key))!,
        new Date().toISOString(),
      );
      throw new Error("local commit failed");
    }),
  ).rejects.toThrow("local commit failed");
  await store.locked(accountId, async (account) => {
    expect((await account.operation(op.operation_key))?.state).toBe("pending");
    await account.update(subject, {
      ...request,
      enabled: false,
      idempotencyKey: crypto.randomUUID(),
    });
    await account.succeeded((await account.operation(op.operation_key))!, new Date().toISOString());
    expect((await account.operation(op.operation_key))?.state).toBe("succeeded");
    expect(await account.spent()).toBe(25_000_000);
  });
}, 180_000);

test("RLS blocks other accounts, nonowners cannot consent, and root transaction handles are refused", async () => {
  if (!client) return;
  const one = await ready();
  const two = await ready();
  await expect(
    one.store.locked(one.accountId, (a) => a.update(two.subject, one.request)),
  ).rejects.toThrow("Only the organization owner");
  await withRlsContext(client.db, { accountId: two.accountId }, async (tx) => {
    expect(
      await rawRows(
        tx,
        sql`select * from billing_auto_top_up_settings where account_id = ${one.accountId}::uuid`,
      ),
    ).toEqual([]);
    expect(() => billingAutoTopUpStore(tx)).toThrow("root database handle");
  });
  await state(
    () =>
      withRlsContext(client!.db, { accountId: two.accountId }, (tx) =>
        tx.execute(
          sql`insert into billing_auto_top_up_mutations(account_id, operation_key, actor_subject, request) values (${one.accountId}::uuid, ${crypto.randomUUID()}::uuid, 'attacker', '{}')`,
        ),
      ),
    "42501",
  );
}, 180_000);

test("setup is not enrollment and stale setup completions cannot replace the card", async () => {
  if (!client) return;
  const { store, accountId, subject, request, intent } = await ready();
  await store.locked(accountId, async (account) => {
    await account.update(subject, {
      ...request,
      enabled: false,
      idempotencyKey: crypto.randomUUID(),
    });
    const oldKey = crypto.randomUUID(),
      newKey = crypto.randomUUID();
    await account.startSetup(subject, oldKey, "stripe:test", intent.customerId);
    await account.startSetup(subject, newKey, "stripe:test", intent.customerId);
    expect(
      await account.finishSetup({
        key: oldKey,
        subject,
        provider: "stripe:test",
        customerId: intent.customerId,
        methodId: "pm_old",
        brand: "visa",
        last4: "1111",
      }),
    ).toBe(false);
    expect((await account.settings())?.enabled).toBe(false);
  });
}, 180_000);

test("a previous-month pending reservation and this-month late success remain capped", async () => {
  if (!client || !fixture) return;
  const { store, accountId, intent, subject, request } = await ready(55_000_000);
  const op = await store.locked(accountId, (account) =>
    account.reserve({
      key: crypto.randomUUID(),
      creditMicros: 25_000_000,
      chargeMicros: 27_500_000,
      intent,
    }),
  );
  // Historical fixture only: model an operation admitted before UTC rollover.
  await fixture.admin.begin(async (tx) => {
    await tx`alter table billing_auto_top_up_operations disable trigger billing_auto_top_up_operations_guard`;
    await tx`update billing_auto_top_up_operations set reservation_month = (date_trunc('month', clock_timestamp() at time zone 'UTC') - interval '1 month')::date where account_id = ${accountId}`;
    await tx`alter table billing_auto_top_up_operations enable trigger billing_auto_top_up_operations_guard`;
  });
  await store.locked(accountId, async (account) => {
    expect(await account.spent()).toBe(27_500_000);
    await expect(
      account.update(subject, {
        ...request,
        monthlyCapMicros: 25_000_000,
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toThrow("pending top-ups");
    await account.bind(op.operation_key, `pi_${op.operation_key}`);
    await account.markConfirmation(op.operation_key);
    await account.succeeded((await account.operation(op.operation_key))!, new Date().toISOString());
    expect(await account.spent()).toBe(27_500_000);
    const next = await account.reserve({
      key: crypto.randomUUID(),
      creditMicros: 25_000_000,
      chargeMicros: 27_500_000,
      intent,
    });
    await account.bind(next.operation_key, `pi_${next.operation_key}`);
    await account.succeeded(
      (await account.operation(next.operation_key))!,
      new Date().toISOString(),
    );
    expect(await account.spent()).toBe(55_000_000);
  });
  await state(
    () =>
      store.locked(accountId, (a) =>
        a.reserve({
          key: crypto.randomUUID(),
          creditMicros: 25_000_000,
          chargeMicros: 25_000_000,
          intent,
        }),
      ),
    "P0T01",
  );
}, 180_000);

test("notification enqueue and successful ledger settlement commit together", async () => {
  if (!client) return;
  const { store, accountId, intent } = await ready();
  const op = await store.locked(accountId, (account) =>
    account.reserve({
      key: crypto.randomUUID(),
      creditMicros: 25_000_000,
      chargeMicros: 25_000_000,
      intent,
    }),
  );
  await store.locked(accountId, (account) =>
    account.bind(op.operation_key, `pi_${op.operation_key}`),
  );
  let fail = true;
  const notified = billingAutoTopUpStore(client.db, async (tx, event) => {
    await tx.execute(sql`insert into billing_auto_top_up_mutations(account_id, operation_key, actor_subject, request)
      values (${accountId}::uuid, ${op.operation_key}::uuid, 'notification-fixture', ${JSON.stringify(event)}::jsonb) on conflict do nothing`);
    if (fail) throw new Error("outbox unavailable");
  });
  await expect(
    notified.locked(accountId, async (a) =>
      a.succeeded((await a.operation(op.operation_key))!, new Date().toISOString()),
    ),
  ).rejects.toThrow("outbox unavailable");
  await store.locked(accountId, async (a) =>
    expect((await a.operation(op.operation_key))?.state).toBe("pending"),
  );
  fail = false;
  await notified.locked(accountId, async (a) => {
    await a.succeeded((await a.operation(op.operation_key))!, new Date().toISOString());
    await a.deliverOutstanding();
    expect((await a.operation(op.operation_key))?.notification_delivered_at).toBeTruthy();
  });
}, 180_000);
