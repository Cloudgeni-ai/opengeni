import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createDb, type Database } from "../src/database";
import * as fullSchema from "../src/schema";

const rows = pgTable("database_query_port_probe", {
  id: text("id").primaryKey(),
  tenant: text("tenant").notNull(),
});

// These are compile-time API assertions, not runtime calls. Schema-configured
// embedded hosts remain assignable, but the port does not advertise db.query.
function assertQueryPort(db: Database) {
  // @ts-expect-error Relational queries are not part of the public port.
  void db.query;
  return db.transaction(async (tx) => {
    // @ts-expect-error Transaction callbacks expose the same explicit-table port.
    void tx.query;
    await tx.transaction(async (nested) => {
      // @ts-expect-error Savepoints do not restore the removed relational API.
      void nested.query;
    });
  });
}
test("schema-configured injected handles still satisfy the port", () => {
  const host = drizzle.mock({ schema: fullSchema });
  const port: Database = host;
  expect(port).toBe(host);
  expect(host.query.sessions).toBeDefined();
  expect(assertQueryPort).toBeFunction();
});

let fixture: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("database-query-port");
  if (!acquired) throw new Error("Restricted PostgreSQL fixture required");
  fixture = acquired;
  await fixture.admin`create table database_query_port_probe (id text primary key, tenant text not null)`;
  await fixture.admin`alter table database_query_port_probe enable row level security`;
  await fixture.admin`alter table database_query_port_probe force row level security`;
  await fixture.admin`create policy exact_tenant on database_query_port_probe
    using (tenant = nullif(current_setting('opengeni.test_tenant', true), ''))`;
  await fixture.admin`grant select, insert on database_query_port_probe to opengeni_app`;
  client = createDb(fixture.appUrl, { max: 1 });
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

test("explicit-table transactions and savepoints preserve RLS and rollback without relational registration", async () => {
  const db = client.db;
  expect(db._.schema).toBeUndefined();
  await db.transaction(async (tx) => {
    expect(tx._.schema).toBeUndefined();
    await tx.execute(sql`select set_config('opengeni.test_tenant', 'a', true)`);
    await tx.insert(rows).values({ id: "committed", tenant: "a" });
    const prepared = tx
      .select()
      .from(rows)
      .where(eq(rows.id, sql.placeholder("id")))
      .prepare("query_port_lookup");
    expect(await prepared.execute({ id: "committed" })).toEqual([{ id: "committed", tenant: "a" }]);
    await expect(
      tx.transaction(async (nested) => {
        expect(nested._.schema).toBeUndefined();
        await nested.insert(rows).values({ id: "savepoint-rollback", tenant: "a" });
        expect(await nested.select().from(rows)).toHaveLength(2);
        throw new Error("rollback savepoint");
      }),
    ).rejects.toThrow("rollback savepoint");
    expect(await tx.select().from(rows)).toEqual([{ id: "committed", tenant: "a" }]);
  });
  expect(await db.select().from(rows)).toEqual([]);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('opengeni.test_tenant', 'b', true)`);
    expect(await tx.select().from(rows)).toEqual([]);
  });
  await expect(
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('opengeni.test_tenant', 'a', true)`);
      await tx.insert(rows).values({ id: "transaction-rollback", tenant: "a" });
      expect(await tx.select().from(rows)).toHaveLength(2);
      tx.rollback();
    }),
  ).rejects.toThrow("Rollback");
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('opengeni.test_tenant', 'a', true)`);
    expect(await tx.select().from(rows)).toEqual([{ id: "committed", tenant: "a" }]);
  });
});
