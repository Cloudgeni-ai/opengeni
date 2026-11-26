import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  acquireRestrictedRuntimeTestDatabase,
  type RestrictedRuntimeTestDatabase,
} from "@opengeni/testing/shared-pg";
import { createDb, getBillingBalance, withAccountRls, type DbClient } from "../src";

// The balance read no longer grows with the ledger (1576): reading an
// account with a large ledger costs about what a small one does, while the
// pre-1576 read, which summed the whole ledger in its totals CTE, grows with
// it. Measured as the restricted runtime role under FORCE RLS, as deployed.

setDefaultTimeout(300_000);

const LARGE_LEDGER_ROWS = 100_000;
const SAMPLES = 15;

let shared: RestrictedRuntimeTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireRestrictedRuntimeTestDatabase("credit-ledger-totals-perf");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") throw new Error("PostgreSQL required");
    return;
  }
  client = createDb(shared.appUrl, { max: 2, searchPath: shared.schema });
}, 300_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 120_000);

async function accountWithLedger(rows: number): Promise<string> {
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('ledger totals perf') returning id`;
  const accountId = account!.id;
  await shared!.admin.begin(async (tx) => {
    await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
    await tx`
      insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
      values (${accountId}::uuid, 'credit_topup', ${rows * 10}, null, ${crypto.randomUUID()})`;
    await tx`
      insert into credit_ledger_entries (account_id, type, amount_micros, source_type, source_id,
        usage_origin, idempotency_key)
      select ${accountId}::uuid, 'model_usage_debit', -1 - (n % 7), 'model_response',
        gen_random_uuid()::text, case when n % 3 = 0 then 'api' else 'app' end, gen_random_uuid()::text
      from generate_series(1, ${rows - 1}) n`;
  });
  return accountId;
}

/** The pre-1576 totals CTE: one pass over the account's whole ledger. */
async function previousTotalsRead(accountId: string) {
  return await withAccountRls(client!.db, accountId, async (tx) => {
    const result = await tx.execute(sql`
      select coalesce(sum(entry.amount_micros), 0)::text as balance,
        coalesce(sum(-entry.amount_micros) filter (where entry.usage_origin = 'api'
          and entry.type <> 'byok_platform_fee'), 0)::text as "apiSpent"
      from credit_ledger_entries entry
      where entry.account_id = ${accountId}`);
    return (result as unknown as { balance: string }[])[0]!.balance;
  });
}

async function medianMs(work: () => Promise<unknown>): Promise<number> {
  await work(); // warm caches and plans
  const samples: number[] = [];
  for (let index = 0; index < SAMPLES; index += 1) {
    const started = performance.now();
    await work();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

test("the balance read does not grow with the ledger; the pre-1576 read does", async () => {
  if (!shared || !client) return;
  const small = await accountWithLedger(10);
  const large = await accountWithLedger(LARGE_LEDGER_ROWS);
  await shared.admin`analyze credit_ledger_entries`;
  await shared.admin`analyze credit_ledger_account_totals`;

  // Same answer both ways.
  const recount = Number(await previousTotalsRead(large));
  expect((await getBillingBalance(client.db, large)).balanceMicros).toBe(recount);

  const newSmall = await medianMs(() => getBillingBalance(client!.db, small));
  const newLarge = await medianMs(() => getBillingBalance(client!.db, large));
  const previousSmall = await medianMs(() => previousTotalsRead(small));
  const previousLarge = await medianMs(() => previousTotalsRead(large));
  // eslint-disable-next-line no-console
  console.info(
    `[ledger totals perf] ${LARGE_LEDGER_ROWS} ledger rows, median of ${SAMPLES}: ` +
      `whole balance read ${newSmall.toFixed(2)} ms (10 rows) / ${newLarge.toFixed(2)} ms (large); ` +
      `pre-1576 totals CTE alone ${previousSmall.toFixed(2)} ms (10 rows) / ${previousLarge.toFixed(2)} ms (large)`,
  );
  // The pre-1576 totals CTE alone, at a large ledger, costs several times the
  // whole new read; the new read at a large ledger stays near a small one.
  expect(previousLarge).toBeGreaterThan(newLarge * 3);
  expect(newLarge).toBeLessThan(newSmall * 2 + 5);
});
