import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";

import { createDb, rawRows } from "../src/database";
import { anyOf } from "../src/sql-arrays";

const probe = pgTable("sql_array_probe", {
  id: uuid("id").primaryKey(),
  label: text("label").notNull(),
});

let shared: SharedTestDatabase;
let pool: ReturnType<typeof createDb>;
const rows = Array.from({ length: 8 }, (_, index) => ({
  id: crypto.randomUUID(),
  label: `label, "${index}" {x}`,
}));

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("sql-arrays");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  // One connection, so the session-local prepared-statement catalog below
  // belongs to the connection that ran every read.
  pool = createDb(shared.appUrl, { max: 1 });
  await shared.admin`create table sql_array_probe (id uuid primary key, label text not null)`;
  await shared.admin`grant select on sql_array_probe to opengeni_app`;
  for (const row of rows) {
    await shared.admin`insert into sql_array_probe values (${row.id}, ${row.label})`;
  }
}, 180_000);

afterAll(async () => {
  await pool?.close();
  await shared?.release();
}, 60_000);

async function statementsFor(column: string): Promise<number> {
  const [row] = await rawRows<{ count: number }>(
    pool.db,
    sql`select count(*)::int as count from pg_prepared_statements
      where statement like ${`%"sql_array_probe"."${column}" = any(%`}`,
  );
  return row!.count;
}

test("anyOf binds a list of any length as one array parameter of one statement", async () => {
  for (const length of [0, 1, 3, 8, 2]) {
    const ids = rows.slice(0, length).map((row) => row.id);
    const found = await pool.db.select({ id: probe.id }).from(probe).where(anyOf(probe.id, ids));
    expect(found.map((row) => row.id).sort()).toEqual([...ids].sort());
  }
  expect(await statementsFor("id")).toBe(1);
});

test("anyOf matches text values containing array literal punctuation exactly", async () => {
  for (const length of [1, 4, 8]) {
    const labels = rows.slice(0, length).map((row) => row.label);
    const found = await pool.db
      .select({ label: probe.label })
      .from(probe)
      .where(anyOf(probe.label, labels));
    expect(found.map((row) => row.label).sort()).toEqual([...labels].sort());
  }
  expect(await statementsFor("label")).toBe(1);
});

test("anyOf binds one value as a scalar whose generic plan is reused", async () => {
  const id = rows[0]!.id;
  for (let run = 0; run < 8; run++) {
    const found = await pool.db
      .select({ id: probe.id })
      .from(probe)
      .where(anyOf(probe.id, [id]));
    expect(found).toEqual([{ id }]);
  }
  const [scalar] = await rawRows<{ generic: number; custom: number }>(
    pool.db,
    sql`select generic_plans::int as generic, custom_plans::int as custom
      from pg_prepared_statements
      where statement like ${'%"sql_array_probe"."id" = $1::uuid%'}`,
  );
  // Five custom plans, then the cached generic plan for every later run
  // (the first test already ran this statement once).
  expect(scalar!.custom).toBe(5);
  expect(scalar!.generic).toBeGreaterThanOrEqual(3);
  // The one-value list did not add an array statement.
  expect(await statementsFor("id")).toBe(1);
});

test("anyOf refuses column types it does not cast", () => {
  const other = pgTable("sql_array_other", { count: text("count").array() });
  expect(() => anyOf(other.count, ["1"])).toThrow();
});
