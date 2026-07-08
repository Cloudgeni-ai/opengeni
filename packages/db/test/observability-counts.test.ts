import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createDb, listCreditBalancesByAccount, type Database, type DbClient } from "../src/index";

let available = true;
let shared: SharedTestDatabase | null = null;
let admin: postgres.Sql;
let client: DbClient;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("db-observability-counts");
  if (!shared) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[db-observability-counts] docker unavailable, skipping");
    return;
  }
  admin = shared.admin;
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } catch {
    /* noop */
  }
  await shared?.release();
});

describe("observability count helpers", () => {
  test("credit balances are readable cross-account through the SECURITY DEFINER function", async () => {
    if (!available) return;
    const [accountA] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('acct-a') returning id`;
    const [accountB] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('acct-b') returning id`;
    const [accountC] = await admin<{ id: string }[]>`
      insert into managed_accounts (name) values ('acct-c') returning id`;

    await admin`
      insert into credit_ledger_entries (account_id, type, amount_micros, idempotency_key)
      values
        (${accountA!.id}, 'grant', 1000, ${"obs:a:grant:" + crypto.randomUUID()}),
        (${accountA!.id}, 'usage', -250, ${"obs:a:usage:" + crypto.randomUUID()}),
        (${accountB!.id}, 'grant', 500, ${"obs:b:grant:" + crypto.randomUUID()}),
        (${accountB!.id}, 'usage', -750, ${"obs:b:usage:" + crypto.randomUUID()})
    `;

    const balances = await listCreditBalancesByAccount(db);
    const byAccount = new Map(
      balances.map((balance) => [balance.accountId, balance.balanceMicros]),
    );

    expect(byAccount.get(accountA!.id)).toBe(750);
    expect(byAccount.get(accountB!.id)).toBe(-250);
    expect(byAccount.has(accountC!.id)).toBe(false);
  }, 60_000);
});
