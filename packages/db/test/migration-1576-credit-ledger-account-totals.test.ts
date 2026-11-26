import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  acquireOwnerMigratedTestDatabase,
  type OwnerMigratedTestDatabase,
} from "@opengeni/testing/shared-pg";
import {
  applyCreditLedgerEntry,
  checkCreditLedgerAccountTotals,
  createDb,
  getBillingBalance,
  withRlsContext,
  type DbClient,
} from "../src/index";
import { migrate } from "../src/migrate";
import { provisionRoles } from "../src/provision-roles";

// Contract (1576): credit_ledger_account_totals holds, for every account, the
// ledger's sum(amount_micros) and the sum(-amount_micros) of its API rows other
// than own-key fees, exactly as a full recount gives them, in any snapshot.
// 1576 installs the triggers and not-ready rows without reading the ledger;
// 1577 backfills one account per transaction, online, as the NOSUPERUSER
// NOBYPASSRLS owner (FORCE RLS binds it), while readers recount not-ready
// accounts. Every insert, update and delete, through the application role,
// the owner, foreign-key actions or concurrent writers (also during the
// backfill), keeps the totals equal to the recount; the runtime role cannot
// write the totals itself.

const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";
const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const M = 1_000_000;

/** Every ledger type the product writes, plus one it does not know yet. */
const TYPES = [
  "credit_topup",
  "manual_credit_grant",
  "credit_dispute_release",
  "credit_refund",
  "credit_dispute_hold",
  "grant",
  "plan_credit_grant",
  "plan_credit_expiry",
  "byok_platform_fee",
  "model_usage_debit",
  "image_generation_debit",
  "video_generation_debit",
  "video_generation_refund",
  "document_embedding_debit",
  "future_unknown_type",
] as const;
const ORIGINS = ["api", "app", null] as const;

setDefaultTimeout(300_000);

let owned: OwnerMigratedTestDatabase | null = null;
let client: DbClient | null = null;
let directory: string | null = null;
/** Seeded before the migration ran: [account, has ledger rows]. */
const seeded: { accountId: string; rows: number }[] = [];

/** Deterministic PRNG (mulberry32), so a failure replays. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function newAccount(name: string): Promise<string> {
  const [row] = await owned!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${name}) returning id`;
  return row!.id;
}

type Row = { type: string; amount: number; origin: string | null };

function randomRow(random: () => number): Row {
  const type = TYPES[Math.floor(random() * TYPES.length)]!;
  const magnitude = 1 + Math.floor(random() * 5 * M);
  // Credits add, debits and reversals take away; a few of each sign anyway.
  const credit = /topup|grant|release|refund$/u.test(type) && type !== "credit_refund";
  const sign = random() < 0.1 ? -1 : 1;
  return {
    type,
    amount: (credit ? magnitude : -magnitude) * sign,
    origin: ORIGINS[Math.floor(random() * ORIGINS.length)]!,
  };
}

/** Insert rows for one account in one statement, as the runtime role in its tenant context. */
async function insertAsRuntime(accountId: string, rows: Row[]) {
  await withRlsContext(client!.db, { accountId }, async (tx) => {
    await tx.execute(sql`
      insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
      select ${accountId}::uuid, row.type, row.amount, row.origin, gen_random_uuid()::text
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as row(type text, amount bigint, origin text)`);
  });
}

/** The database's message for a rejected query (drizzle wraps it as the cause). */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? String(error);
  }
  return "no error";
}

type Mismatch = {
  account_id: string;
  ledger_balance: string;
  ledger_api: string;
  ledger_rows: number;
  total_balance: string | null;
  total_api: string | null;
};

/** Accounts whose kept totals differ from a full recount of the ledger. */
async function mismatches(accountIds: string[]): Promise<Mismatch[]> {
  return await owned!.admin<Mismatch[]>`
    select account.id as account_id,
      coalesce(ledger.balance, 0)::text as ledger_balance,
      coalesce(ledger.api, 0)::text as ledger_api,
      coalesce(ledger.n, 0)::int as ledger_rows,
      total.balance_micros::text as total_balance,
      total.api_spent_micros::text as total_api
    from unnest(${accountIds}::uuid[]) as account(id)
    left join (
      select entry.account_id, sum(entry.amount_micros) as balance,
        coalesce(sum(-entry.amount_micros) filter (where entry.usage_origin = 'api'
          and entry.type <> 'byok_platform_fee'), 0) as api,
        count(*) as n
      from credit_ledger_entries entry group by entry.account_id
    ) ledger on ledger.account_id = account.id
    left join credit_ledger_account_totals total on total.account_id = account.id
    where coalesce(total.balance_micros, 0) <> coalesce(ledger.balance, 0)
      or coalesce(total.api_spent_micros, 0) <> coalesce(ledger.api, 0)
      or (coalesce(ledger.n, 0) > 0 and total.account_id is null)`;
}

/** Files up to and including `last`, linked into the test's migration directory. */
async function linkThrough(files: string[], last: number) {
  for (const file of files.slice(0, last + 1)) {
    await symlink(join(SHIPPED, file), join(directory!, file)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
  }
}

let shippedFiles: string[] = [];
/** The large pre-existing account the backfill reads under FORCE RLS. */
let bigAccountId = "";
const BIG_ROWS = 60_000;

beforeAll(async () => {
  owned = await acquireOwnerMigratedTestDatabase("migration-1576-ledger-totals");
  if (!owned) {
    if (requireRealDatabase) throw new Error("PostgreSQL fixture is unavailable");
    return;
  }
  // A database with a ledger already, then 1576 alone; the first test runs
  // the rest of the release (1577's batched backfill) under live writers.
  directory = await mkdtemp(join(tmpdir(), "og-migration-1576-"));
  shippedFiles = (await readdir(SHIPPED)).filter((file) => file.endsWith(".sql")).sort();
  const ours = shippedFiles.findIndex((file) => file.endsWith("_credit_ledger_account_totals.sql"));
  if (ours < 0) throw new Error("the credit ledger totals migration is missing");
  await linkThrough(shippedFiles, ours - 1);
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: directory });

  const random = prng(1576);
  for (let index = 0; index < 24; index += 1) {
    const accountId = await newAccount(`totals-backfill-${index}`);
    // One account has no ledger rows at all.
    const rows = index === 5 ? 0 : 1 + Math.floor(random() * 400);
    if (rows > 0) {
      const values = Array.from({ length: rows }, () => randomRow(random));
      await owned.admin.begin(async (tx) => {
        // Refund triggers check the tenant context.
        await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
        await tx`
          insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
          select ${accountId}::uuid, row.type, row.amount, row.origin, gen_random_uuid()::text
          from jsonb_to_recordset(${tx.json(values)}::jsonb) as row(type text, amount bigint, origin text)`;
      });
    }
    seeded.push({ accountId, rows });
  }
  bigAccountId = await newAccount("totals-backfill-big");
  await owned.admin`
    insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
    select ${bigAccountId}::uuid,
      case when i % 7 = 0 then 'credit_topup' when i % 11 = 0 then 'byok_platform_fee' else 'model_usage_debit' end,
      case when i % 7 = 0 then 5000 + i else -(i % 997) - 1 end,
      case when i % 3 = 0 then 'api' when i % 3 = 1 then 'app' else null end,
      'big-' || i
    from generate_series(1, ${BIG_ROWS}) i`;
  seeded.push({ accountId: bigAccountId, rows: BIG_ROWS });

  await linkThrough(shippedFiles, ours);
  await migrate(owned.ownerUrl, undefined, { migrationsDirectory: directory });
}, 900_000);

afterAll(async () => {
  await client?.close();
  await owned?.release();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 60_000);

test("the batched backfill completes every pre-existing account exactly while writers keep writing", async () => {
  if (!owned) return;
  const ids = seeded.map((entry) => entry.accountId);
  // After 1576 alone: a not-ready zero row for every account, no ledger read.
  const [before] = await owned.admin<{ rows: number; ready: number }[]>`
    select count(*)::int as rows, count(*) filter (where ready)::int as ready
    from credit_ledger_account_totals where account_id = any(${ids}::uuid[])`;
  expect(before).toEqual({ rows: ids.length, ready: 0 });

  // Owner-connection writers in the tenant context (FORCE RLS binds the
  // owner as it binds the runtime role): half take the account's credit lock
  // first, as the application does, half write raw.
  const writers = postgres(owned.ownerUrl, { max: 4 });
  const hot = [bigAccountId, ...ids.slice(0, 6)];
  const writing = { stop: false };
  let writes = 0;
  let maxWriteMs = 0;
  const loops = Array.from({ length: 4 }, (_, writer) =>
    (async () => {
      const random = prng(9000 + writer);
      while (!writing.stop) {
        const accountId = hot[Math.floor(random() * hot.length)]!;
        const rows = [randomRow(random), randomRow(random)];
        const started = performance.now();
        await writers.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
          if (writer % 2 === 0) await tx`select pg_advisory_xact_lock(hashtext(${accountId}))`;
          await tx`
            insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
            select ${accountId}::uuid, row.type, row.amount, row.origin, gen_random_uuid()::text
            from jsonb_to_recordset(${tx.json(rows)}::jsonb) as row(type text, amount bigint, origin text)
            where row.type <> 'video_generation_refund'`;
        });
        maxWriteMs = Math.max(maxWriteMs, performance.now() - started);
        writes += 1;
      }
    })(),
  );
  const backfillStarted = performance.now();
  try {
    await linkThrough(shippedFiles, shippedFiles.length - 1);
    await migrate(owned.ownerUrl, undefined, { migrationsDirectory: directory! });
  } finally {
    writing.stop = true;
    await Promise.all(loops);
    await writers.end();
  }
  const backfillMs = performance.now() - backfillStarted;
  console.info(
    `[ledger totals backfill] ${seeded.length} accounts (${BIG_ROWS} rows in the largest), ` +
      `${backfillMs.toFixed(0)} ms with ${writes} concurrent writes; max write ${maxWriteMs.toFixed(1)} ms`,
  );
  expect(writes).toBeGreaterThan(20);
  // A writer waits at most for one account's single-row update, never for a
  // ledger read (the largest account's read alone takes far longer).
  expect(maxWriteMs).toBeLessThan(400);

  expect(await mismatches(ids)).toEqual([]);
  const [after] = await owned.admin<{ ready: number }[]>`
    select count(*) filter (where ready)::int as ready
    from credit_ledger_account_totals where account_id = any(${ids}::uuid[])`;
  expect(after!.ready).toBe(ids.length);
  const [everything] = await owned.admin<{ n: number }[]>`
    select count(*)::int as n from credit_ledger_account_totals where not ready`;
  expect(everything!.n).toBe(0);

  await provisionRoles(owned.adminUrl, { appPassword: owned.appPassword, rlsStrategy: "force" });
  const appUrl = new URL(owned.ownerUrl);
  appUrl.username = "opengeni_app";
  appUrl.password = owned.appPassword;
  client = createDb(appUrl.toString(), { max: 8, rlsStrategy: "force" });

  // The table is FORCE-RLS and owned by the migration owner; its routines are
  // owner-only invokers; the runtime may read, and insert and update only
  // through the triggers (RLS), never delete.
  const [posture] = await owned.admin<
    {
      force: boolean;
      owner: string;
      definer: boolean;
      public_execute: boolean;
      app_select: boolean;
      app_insert_update: boolean;
      app_delete: boolean;
      gauge_path: string[] | null;
    }[]
  >`
    select c.relforcerowsecurity as force, pg_get_userbyid(c.relowner) as owner,
      p.prosecdef as definer,
      has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
      has_table_privilege('opengeni_app', c.oid, 'SELECT') as app_select,
      has_table_privilege('opengeni_app', c.oid, 'INSERT')
        and has_table_privilege('opengeni_app', c.oid, 'UPDATE') as app_insert_update,
      has_table_privilege('opengeni_app', c.oid, 'DELETE') as app_delete,
      (select proconfig from pg_proc where oid = 'opengeni_private.credit_balance_by_account()'::regprocedure) as gauge_path
    from pg_class c, pg_proc p
    where c.oid = 'credit_ledger_account_totals'::regclass
      and p.oid = 'opengeni_private.maintain_credit_ledger_account_totals()'::regprocedure`;
  expect(posture).toMatchObject({
    force: true,
    owner: owned.ownerRole,
    definer: false,
    public_execute: false,
    app_select: true,
    app_insert_update: true,
    app_delete: false,
  });
  expect(posture!.gauge_path?.[0]).toStartWith("search_path=pg_catalog, ");
});

test("random inserts of every type, updates, refunds and deletes keep the totals equal to a recount", async () => {
  if (!owned || !client) return;
  const random = prng(20261126);
  const accounts = [...seeded.map((entry) => entry.accountId)];
  for (let index = 0; index < 4; index += 1) accounts.push(await newAccount(`totals-${index}`));
  const pick = () => accounts[Math.floor(random() * accounts.length)]!;
  const owner = postgres(owned.ownerUrl, { max: 1 });
  try {
    for (let step = 0; step < 120; step += 1) {
      const accountId = pick();
      const action = random();
      if (action < 0.55) {
        // Runtime inserts, one to several rows per statement.
        const count = 1 + Math.floor(random() * 4);
        await insertAsRuntime(
          accountId,
          Array.from({ length: count }, () => randomRow(random)),
        );
      } else if (action < 0.65) {
        // Paid-for credit and its Stripe refund through the application path.
        const amount = 1 + Math.floor(random() * 10) * M;
        await applyCreditLedgerEntry(client.db, {
          accountId,
          type: "credit_topup",
          amountMicros: amount,
          idempotencyKey: crypto.randomUUID(),
        });
        await applyCreditLedgerEntry(client.db, {
          accountId,
          type: "credit_refund",
          amountMicros: -Math.floor(amount / 2),
          idempotencyKey: crypto.randomUUID(),
        });
      } else if (action < 0.7) {
        // A replayed idempotency key inserts nothing.
        const key = crypto.randomUUID();
        for (let replay = 0; replay < 2; replay += 1) {
          await applyCreditLedgerEntry(client.db, {
            accountId,
            type: "model_usage_debit",
            amountMicros: -1_234,
            idempotencyKey: key,
          });
        }
      } else if (action < 0.75) {
        // The owner (as a SECURITY DEFINER routine does) in the tenant context.
        await owner.begin(async (tx) => {
          await tx`select set_config('opengeni.account_id', ${accountId}, true)`;
          await tx`
            insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
            values (${accountId}::uuid, 'grant', ${1 + Math.floor(random() * M)}, 'api', ${crypto.randomUUID()})`;
        });
      } else if (action < 0.85) {
        // Runtime updates of amount, origin and type on a few rows.
        await withRlsContext(client.db, { accountId }, async (tx) => {
          await tx.execute(sql`
            update credit_ledger_entries set amount_micros = amount_micros * -2 + 7,
              usage_origin = case when usage_origin = 'api' then 'app' else 'api' end,
              type = case when type = 'byok_platform_fee' then 'model_usage_debit' else 'byok_platform_fee' end
            where id in (select id from credit_ledger_entries where account_id = ${accountId}::uuid
              and type not in ('grant', 'plan_credit_grant')
              order by random() limit 3)`);
        });
      } else if (action < 0.9) {
        // A metadata-only update changes no total.
        await withRlsContext(client.db, { accountId }, async (tx) => {
          await tx.execute(sql`
            update credit_ledger_entries set metadata = metadata || '{"touched": true}'::jsonb
            where account_id = ${accountId}::uuid and type not in ('grant', 'plan_credit_grant')`);
        });
      } else if (action < 0.92) {
        // One statement for several accounts (only a role without row
        // security can): accounts are applied in order.
        const several = [pick(), pick(), pick()];
        const rows = several.map((id) => ({ ...randomRow(random), account: id }));
        await owned.admin`
          insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
          select row.account, row.type, row.amount, row.origin, gen_random_uuid()::text
          from jsonb_to_recordset(${owned.admin.json(rows)}::jsonb)
            as row(account uuid, type text, amount bigint, origin text)
          where row.type <> 'video_generation_refund'`;
      } else if (action < 0.96) {
        // Runtime deletes of a few rows.
        await withRlsContext(client.db, { accountId }, async (tx) => {
          await tx.execute(sql`
            delete from credit_ledger_entries where id in (select id from credit_ledger_entries
              where account_id = ${accountId}::uuid order by random() limit 2)`);
        });
      } else {
        // A row moved between accounts (only a role without row security can).
        const other = pick();
        await owned.admin`
          update credit_ledger_entries set account_id = ${other}::uuid
          where id in (select id from credit_ledger_entries where account_id = ${accountId}::uuid
            and type not in ('grant', 'plan_credit_grant')
            and not exists (select 1 from credit_debit_allocations allocation
              where allocation.debit_entry_id = credit_ledger_entries.id
                or allocation.grant_entry_id = credit_ledger_entries.id)
            and not exists (select 1 from plan_credit_periods period
              where period.grant_entry_id = credit_ledger_entries.id
                or period.expiry_entry_id = credit_ledger_entries.id)
            limit 1)`;
      }
      expect({ step, mismatches: await mismatches(accounts) }).toEqual({ step, mismatches: [] });
    }

    // The application's balance is the recount (these accounts have no plan).
    for (const accountId of accounts) {
      const [recount] = await owned.admin<{ balance: string }[]>`
        select coalesce(sum(amount_micros), 0)::text as balance from credit_ledger_entries
        where account_id = ${accountId}::uuid`;
      expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(
        Number(recount!.balance),
      );
    }
  } finally {
    await owner.end();
  }
});

test("deleting a workspace or an account keeps the totals exact", async () => {
  if (!owned || !client) return;
  const accountId = await newAccount("totals-deleted");
  const [workspace] = await owned.admin<{ id: string }[]>`
    insert into workspaces (account_id, name, slug)
    values (${accountId}::uuid, 'totals', ${`totals-${crypto.randomUUID()}`}) returning id`;
  await owned.admin`
    insert into credit_ledger_entries (account_id, workspace_id, type, amount_micros, usage_origin, idempotency_key)
    values (${accountId}::uuid, ${workspace!.id}::uuid, 'credit_topup', ${5 * M}, null, ${crypto.randomUUID()}),
      (${accountId}::uuid, null, 'model_usage_debit', ${-2 * M}, 'api', ${crypto.randomUUID()})`;
  // The workspace's ledger rows lose their workspace (ON DELETE SET NULL).
  await owned.admin`delete from workspaces where id = ${workspace!.id}::uuid`;
  expect(await mismatches([accountId])).toEqual([]);
  const [kept] = await owned.admin<{ balance: string; api: string }[]>`
    select balance_micros::text as balance, api_spent_micros::text as api
    from credit_ledger_account_totals where account_id = ${accountId}::uuid`;
  expect(kept).toEqual({ balance: String(3 * M), api: String(2 * M) });
  // Deleting the account cascades its ledger and its totals.
  await owned.admin`delete from managed_accounts where id = ${accountId}::uuid`;
  const [left] = await owned.admin<{ n: number }[]>`
    select count(*)::int as n from credit_ledger_account_totals where account_id = ${accountId}::uuid`;
  expect(left!.n).toBe(0);
});

test("concurrent writers to the same accounts leave exact totals", async () => {
  if (!owned || !client) return;
  const random = prng(42);
  const accounts = [await newAccount("totals-hot-a"), await newAccount("totals-hot-b")];
  const writers = Array.from({ length: 8 }, (_, writer) =>
    (async () => {
      for (let round = 0; round < 15; round += 1) {
        const accountId = accounts[(writer + round) % accounts.length]!;
        if ((writer + round) % 3 === 0) {
          // The application path, under the account's advisory lock.
          await applyCreditLedgerEntry(client!.db, {
            accountId,
            type: round % 2 ? "credit_topup" : "model_usage_debit",
            amountMicros: round % 2 ? 3 * M : -M,
            idempotencyKey: crypto.randomUUID(),
          });
        } else {
          // Raw writers without the advisory lock: two statements per transaction.
          await withRlsContext(client!.db, { accountId }, async (tx) => {
            for (let statement = 0; statement < 2; statement += 1) {
              const rows = [randomRow(random), randomRow(random)];
              await tx.execute(sql`
                insert into credit_ledger_entries (account_id, type, amount_micros, usage_origin, idempotency_key)
                select ${accountId}::uuid, row.type, row.amount, row.origin, gen_random_uuid()::text
                from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as row(type text, amount bigint, origin text)`);
            }
          });
        }
      }
    })(),
  );
  await Promise.all(writers);
  expect(await mismatches(accounts)).toEqual([]);
  const [count] = await owned.admin<{ n: number }[]>`
    select count(*)::int as n from credit_ledger_entries where account_id = any(${accounts}::uuid[])`;
  // 8 writers x 15 rounds: a third through the application, the rest 4 rows each.
  expect(count!.n).toBe(40 + 80 * 4);
});

test("the runtime role reads its own totals but cannot write them", async () => {
  if (!owned || !client) return;
  const accountId = seeded[0]!.accountId;
  const before = (await getBillingBalance(client.db, accountId)).balanceMicros;
  const write = (statement: ReturnType<typeof sql>) =>
    failure(
      withRlsContext(client!.db, { accountId }, async (tx) => {
        await tx.execute(statement);
      }),
    );
  // Outside a trigger the insert policy rejects the row.
  expect(
    await write(sql`insert into credit_ledger_account_totals (account_id, balance_micros, ready)
      values (${accountId}::uuid, 1e15, true)
      on conflict (account_id) do update set balance_micros = 1e15`),
  ).toMatch(/row-level security/);
  // An update matches no row, a delete is not granted.
  expect(
    await write(sql`update credit_ledger_account_totals set balance_micros = 1e15
      where account_id = ${accountId}::uuid`),
  ).toBe("no error");
  expect(
    await write(
      sql`delete from credit_ledger_account_totals where account_id = ${accountId}::uuid`,
    ),
  ).toMatch(/permission denied/);
  const visible = await withRlsContext(client.db, { accountId }, async (tx) =>
    tx.execute(sql`select account_id from credit_ledger_account_totals`),
  );
  expect((visible as unknown as { account_id: string }[]).map((row) => row.account_id)).toEqual([
    accountId,
  ]);
  expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(before);
  expect(await mismatches([accountId])).toEqual([]);
});

test("a row that is not ready is recounted by balance reads and skipped by the drift check", async () => {
  if (!owned || !client) return;
  const accountId = bigAccountId;
  const [recount] = await owned.admin<{ balance: string }[]>`
    select sum(amount_micros)::text as balance from credit_ledger_entries
    where account_id = ${accountId}::uuid`;
  // As during the rollout: the row holds only the changes since the triggers.
  await owned.admin`
    update credit_ledger_account_totals set ready = false, balance_micros = 7, api_spent_micros = 7
    where account_id = ${accountId}::uuid`;
  try {
    expect((await getBillingBalance(client.db, accountId)).balanceMicros).toBe(
      Number(recount!.balance),
    );
    // The drift check samples ready rows only.
    expect(await checkCreditLedgerAccountTotals(client.db, [accountId])).toEqual({
      checked: 0,
      mismatchedAccountIds: [],
    });
  } finally {
    await owned.admin`
      update credit_ledger_account_totals set ready = true,
        balance_micros = ${recount!.balance}::numeric,
        api_spent_micros = (select coalesce(sum(-amount_micros) filter (where usage_origin = 'api'
          and type <> 'byok_platform_fee'), 0) from credit_ledger_entries where account_id = ${accountId}::uuid)
      where account_id = ${accountId}::uuid`;
  }
  expect(await mismatches([accountId])).toEqual([]);
});

test("the drift check finds a row that differs from its ledger", async () => {
  if (!owned || !client) return;
  const ids = seeded.map((entry) => entry.accountId);
  const clean = await checkCreditLedgerAccountTotals(client.db, ids);
  expect(clean).toEqual({ checked: ids.length, mismatchedAccountIds: [] });
  const accountId = seeded[1]!.accountId;
  await owned.admin`
    update credit_ledger_account_totals set balance_micros = balance_micros + 1
    where account_id = ${accountId}::uuid`;
  try {
    expect(await checkCreditLedgerAccountTotals(client.db, ids)).toEqual({
      checked: ids.length,
      mismatchedAccountIds: [accountId],
    });
  } finally {
    await owned.admin`
      update credit_ledger_account_totals set balance_micros = balance_micros - 1
      where account_id = ${accountId}::uuid`;
  }
});

// Last: it empties the whole ledger.
test("a TRUNCATE of the ledger clears the totals, and later writes start exact rows", async () => {
  if (!owned || !client) return;
  await owned.admin`truncate credit_ledger_entries cascade`;
  const [left] = await owned.admin<{ n: number }[]>`
    select count(*)::int as n from credit_ledger_account_totals`;
  expect(left!.n).toBe(0);
  const accountId = seeded[2]!.accountId;
  await insertAsRuntime(accountId, [
    { type: "credit_topup", amount: 4 * M, origin: null },
    { type: "model_usage_debit", amount: -M, origin: "api" },
  ]);
  expect(await mismatches(seeded.map((entry) => entry.accountId))).toEqual([]);
  const [row] = await owned.admin<{ balance: string; api: string; ready: boolean }[]>`
    select balance_micros::text as balance, api_spent_micros::text as api, ready
    from credit_ledger_account_totals where account_id = ${accountId}::uuid`;
  expect(row).toEqual({ balance: String(3 * M), api: String(M), ready: true });
  expect((await getBillingBalance(client.db, seeded[3]!.accountId)).balanceMicros).toBe(0);
});
