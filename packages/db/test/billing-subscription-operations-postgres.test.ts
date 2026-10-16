import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing";
import { sql } from "drizzle-orm";
import {
  assertBillingSubscriptionOperationRoot,
  beginBillingSubscriptionOperation,
  completeBillingSubscriptionOperation,
  getBillingSubscriptionOperation,
  createDb,
  ensureManagedAccessForUser,
  nestedPostgresSqlState,
  withRlsContext,
  type DbClient,
} from "../src";
import { rawRows } from "../src/database";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
} from "../src/runtime-posture";

let fixture: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;
beforeAll(async () => {
  fixture = await acquireRestrictedRuntimeTestDatabase(
    "billing-subscription-operations",
    "operation_data",
  );
  if (!fixture) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(fixture.appUrl, { max: 2, searchPath: fixture.schema });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 180_000);

async function account() {
  const userId = crypto.randomUUID();
  return (
    await ensureManagedAccessForUser(client!.db, {
      userId,
      email: `${userId}@example.test`,
      name: "Operation receipt owner",
    })
  ).defaultAccountId!;
}
async function expectState(run: () => Promise<unknown>, state: string) {
  let failure: unknown;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  expect(nestedPostgresSqlState(failure)).toBe(state);
}
const intent = { subscriptionId: "sub_original", periodEnd: 2000 };
const result = { response: { subscriptionId: "sub_original", cancelAtPeriodEnd: true } };

test("new receipt table and routines satisfy restricted runtime posture in a non-public schema", async () => {
  if (!client || !fixture) return;
  const options = {
    expectedRole: "opengeni_app",
    rlsStrategy: "force" as const,
    targetSchema: fixture.schema,
  };
  expect(
    evaluateRuntimeDatabasePosture(
      await inspectRuntimeDatabasePosture(client.db, options),
      options,
    ),
  ).toEqual([]);
  const [table] =
    await fixture.admin`select c.relrowsecurity, c.relforcerowsecurity, r.rolsuper, r.rolbypassrls
    from pg_class c join pg_roles r on r.oid=c.relowner join pg_namespace n on n.oid=c.relnamespace
    where n.nspname=${fixture.schema} and c.relname='billing_subscription_operations'`;
  expect(table).toEqual({
    relrowsecurity: true,
    relforcerowsecurity: true,
    rolsuper: false,
    rolbypassrls: false,
  });
}, 180_000);

test("intent and result bind an org-scoped UUID immutably; concurrent attempts converge", async () => {
  if (!client) return;
  const accountId = await account();
  const input = {
    accountId,
    operationKey: crypto.randomUUID(),
    kind: "cancel" as const,
    request: {},
    intent,
  };
  const receipts = await Promise.all(
    Array.from({ length: 4 }, () => beginBillingSubscriptionOperation(client!.db, input)),
  );
  expect(new Set(receipts.map((receipt) => receipt.created_at)).size).toBe(1);
  expect(
    (
      await beginBillingSubscriptionOperation(client.db, {
        ...input,
        intent: { subscriptionId: "sub_replacement" },
      })
    ).intent,
  ).toEqual(intent);
  await expectState(
    () =>
      beginBillingSubscriptionOperation(client!.db, {
        ...input,
        kind: "upgrade",
        request: { planKey: "max" },
      }),
    "23505",
  );
  await expectState(
    () =>
      beginBillingSubscriptionOperation(client!.db, {
        ...input,
        operationKey: crypto.randomUUID(),
      }),
    "P0S02",
  );
  await completeBillingSubscriptionOperation(client.db, { ...input, result });
  await completeBillingSubscriptionOperation(client.db, { ...input, result });
  await expectState(
    () =>
      completeBillingSubscriptionOperation(client!.db, {
        ...input,
        result: { response: "changed" },
      }),
    "23505",
  );
  expect(
    (await getBillingSubscriptionOperation(client.db, accountId, input.operationKey))?.result,
  ).toEqual(result);
  expect(
    (
      await beginBillingSubscriptionOperation(client.db, {
        ...input,
        operationKey: crypto.randomUUID(),
      })
    ).result,
  ).toBeNull();
  // UUIDs are scoped to an organization rather than globally consuming keys.
  expect(
    (await beginBillingSubscriptionOperation(client.db, { ...input, accountId: await account() }))
      .result,
  ).toBeNull();
}, 180_000);

test("runtime cannot directly mutate receipts or cross organization scope", async () => {
  if (!client) return;
  const accountId = await account();
  const otherAccountId = await account();
  const operationKey = crypto.randomUUID();
  await beginBillingSubscriptionOperation(client.db, {
    accountId,
    operationKey,
    kind: "cancel",
    request: {},
    intent,
  });
  await withRlsContext(client.db, { accountId: otherAccountId }, async (tx) => {
    expect(
      await rawRows(
        tx,
        sql`select * from billing_subscription_operations where account_id=${accountId}::uuid`,
      ),
    ).toEqual([]);
  });
  for (const query of [
    sql`update billing_subscription_operations set intent='{}'::jsonb where account_id=${accountId}::uuid`,
    sql`delete from billing_subscription_operations where account_id=${accountId}::uuid`,
    sql`insert into billing_subscription_operations(account_id,operation_key,kind,request,intent) values (${accountId}::uuid,${crypto.randomUUID()}::uuid,'cancel','{}','{"subscriptionId":"sub"}')`,
  ])
    await expectState(
      () => withRlsContext(client!.db, { accountId }, (tx) => tx.execute(query)),
      "42501",
    );
  await expectState(
    () =>
      withRlsContext(client!.db, { accountId: otherAccountId }, (tx) =>
        tx.execute(
          sql`select complete_billing_subscription_operation(${accountId}::uuid,${operationKey}::uuid,'{}'::jsonb)`,
        ),
      ),
    "42501",
  );
  await expectState(
    () =>
      withRlsContext(client!.db, { accountId: otherAccountId }, (tx) =>
        tx.execute(
          sql`select begin_billing_subscription_operation(${accountId}::uuid,${operationKey}::uuid,'cancel','{}'::jsonb,'{"subscriptionId":"sub"}'::jsonb)`,
        ),
      ),
    "42501",
  );
  await expectState(
    () =>
      beginBillingSubscriptionOperation(client!.db, {
        accountId: otherAccountId,
        operationKey,
        kind: "cancel",
        request: {},
        intent: {},
      }),
    "23514",
  );
}, 180_000);

test("a separate intent commit survives reconciliation rollback; nested stores cannot promise that boundary", async () => {
  if (!client) return;
  const accountId = await account();
  const operationKey = crypto.randomUUID();
  expect(() => assertBillingSubscriptionOperationRoot(client!.db)).not.toThrow();
  await beginBillingSubscriptionOperation(client.db, {
    accountId,
    operationKey,
    kind: "cancel",
    request: {},
    intent,
  });
  await expect(
    withRlsContext(client.db, { accountId }, async (tx) => {
      expect(() => assertBillingSubscriptionOperationRoot(tx)).toThrow("root database handle");
      await completeBillingSubscriptionOperation(tx, { accountId, operationKey, result });
      throw new Error("rollback reconciliation");
    }),
  ).rejects.toThrow("rollback reconciliation");
  expect(
    (await getBillingSubscriptionOperation(client.db, accountId, operationKey))?.intent,
  ).toEqual(intent);
  expect(
    (await getBillingSubscriptionOperation(client.db, accountId, operationKey))?.result,
  ).toBeNull();
}, 180_000);
