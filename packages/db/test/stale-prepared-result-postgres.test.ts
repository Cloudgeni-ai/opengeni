import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";

import { createDb, isStalePreparedResultError, rawRows, type Database } from "../src/database";

// A rolling migration that adds a column to a table changes the row type a
// `select *` (or `returning *`, `table.*`) statement returns. Pods that are
// still running have that statement prepared, and Postgres refuses to reuse
// it: SQLSTATE 0A000 "cached plan must not change result type". Outside a
// transaction postgres.js re-prepares and repeats the statement on its own;
// inside one the transaction is already aborted. The pool repeats such a
// transaction instead of failing the request (6.25.0 rollout: about 25 500s
// while migration 1477 added sandbox_leases.viewer_idle_drained_at).

let shared: SharedTestDatabase;
let pool: ReturnType<typeof createDb>;

async function addColumn(name: string) {
  await shared.admin.unsafe(`alter table stale_result_probe add column ${name} text`);
}

function readAll(db: Database) {
  return rawRows<Record<string, unknown>>(
    db,
    sql`select * from stale_result_probe where id > ${0}`,
  );
}

function readOne(db: Database) {
  return rawRows<Record<string, unknown>>(
    db,
    sql`select probe.* from stale_result_probe probe where probe.id = ${1}`,
  );
}

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("stale-prepared-result");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  await shared.admin`drop table if exists stale_result_probe`;
  await shared.admin`create table stale_result_probe (id int primary key, label text not null)`;
  await shared.admin`insert into stale_result_probe values (1, 'one'), (2, 'two')`;
  await shared.admin`grant select, update on stale_result_probe to opengeni_app`;
  // Two connections so a repeated transaction can land on another connection
  // that still holds its own stale statements.
  pool = createDb(shared.appUrl, { max: 2, preparedStatements: true });
}, 180_000);

afterAll(async () => {
  await pool?.close();
  if (shared) await shared.admin`drop table if exists stale_result_probe`;
  await shared?.release();
}, 60_000);

async function warmEveryConnection() {
  // Hold both connections at once so each prepares both statements.
  await Promise.all(
    [0, 1].map(() =>
      pool.db.transaction(async (tx) => {
        await readAll(tx);
        await readOne(tx);
        await rawRows(tx, sql`select pg_sleep(0.05)`);
      }),
    ),
  );
  const [prepared] = await rawRows<{ count: number }>(
    pool.db,
    sql`select count(*)::int as count from pg_prepared_statements
      where statement like '%from stale_result_probe%'`,
  );
  expect(prepared!.count).toBeGreaterThan(0);
}

describe("a column added while statements are prepared", () => {
  test("a transaction reading the table with * succeeds and sees the new column", async () => {
    await warmEveryConnection();
    await addColumn("added_in_transaction");
    let runs = 0;
    const rows = await pool.db.transaction(async (tx) => {
      runs += 1;
      const all = await readAll(tx);
      const one = await readOne(tx);
      await tx.execute(sql`update stale_result_probe set label = label where id = ${1}`);
      return { all, one };
    });
    expect(rows.all).toHaveLength(2);
    expect(rows.one[0]).toHaveProperty("added_in_transaction", null);
    expect(runs).toBeGreaterThanOrEqual(1);
    // Each connection drops all of its stale statements on its first refusal,
    // so a two-connection pool needs at most one repeat per connection.
    expect(runs).toBeLessThanOrEqual(3);
  });

  test("concurrent transactions on every connection all succeed", async () => {
    await warmEveryConnection();
    await addColumn("added_concurrently");
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        pool.db.transaction(async (tx) => {
          const all = await readAll(tx);
          const one = await readOne(tx);
          return [all.length, Object.keys(one[0] ?? {})] as const;
        }),
      ),
    );
    for (const [count, keys] of results) {
      expect(count).toBe(2);
      expect(keys).toContain("added_concurrently");
    }
  });

  test("a statement outside a transaction succeeds", async () => {
    await warmEveryConnection();
    await addColumn("added_outside_transaction");
    for (let round = 0; round < 4; round += 1) {
      const rows = await readOne(pool.db);
      expect(rows[0]).toHaveProperty("added_outside_transaction", null);
    }
  });

  test("one refusal makes a connection forget every stale statement", async () => {
    const single = createDb(shared.appUrl, { max: 1, preparedStatements: true });
    try {
      await single.db.transaction(async (tx) => {
        await readAll(tx);
        await readOne(tx);
      });
      await addColumn("added_for_single_connection");
      let runs = 0;
      const keys = await single.db.transaction(async (tx) => {
        runs += 1;
        await readAll(tx);
        const one = await readOne(tx);
        return Object.keys(one[0] ?? {});
      });
      expect(keys).toContain("added_for_single_connection");
      // The first statement's refusal drops the second stale statement too,
      // so the repeat succeeds instead of being refused again.
      expect(runs).toBe(2);
    } finally {
      await single.close();
    }
  });

  test("statements in flight together are repeated, in and outside a transaction", async () => {
    // One connection, so the statements are pipelined on it: the first
    // refusal's repeat must not take the parameter description meant for the
    // statement behind it (upstream postgres.js then waits forever), and a
    // sibling's 25P02 must not hide the refusal that aborted the transaction.
    const single = createDb(shared.appUrl, { max: 1, preparedStatements: true });
    const deadline = <T>(work: Promise<T>) =>
      Promise.race([
        work,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("statements in flight never settled")), 10_000),
        ),
      ]);
    try {
      await readAll(single.db);
      await readOne(single.db);
      await addColumn("added_while_pipelined");
      const [all, one] = await deadline(Promise.all([readAll(single.db), readOne(single.db)]));
      expect(all).toHaveLength(2);
      expect(one[0]).toHaveProperty("added_while_pipelined", null);

      await addColumn("added_while_pipelined_in_transaction");
      let runs = 0;
      const [allInTransaction, oneInTransaction] = await deadline(
        single.db.transaction(async (tx) => {
          runs += 1;
          return Promise.all([readAll(tx), readOne(tx)]);
        }),
      );
      expect(allInTransaction).toHaveLength(2);
      expect(oneInTransaction[0]).toHaveProperty("added_while_pipelined_in_transaction", null);
      expect(runs).toBe(2);
    } finally {
      await single.close();
    }
  });

  test("a refusal inside a savepoint repeats the enclosing transaction", async () => {
    await warmEveryConnection();
    await pool.db.transaction(async (tx) => {
      await tx.transaction(async (inner) => {
        await readOne(inner);
      });
    });
    await addColumn("added_under_savepoint");
    let runs = 0;
    const keys = await pool.db.transaction(async (tx) => {
      runs += 1;
      return tx.transaction(async (inner) => Object.keys((await readOne(inner))[0] ?? {}));
    });
    expect(keys).toContain("added_under_savepoint");
    // Refused at least once (the savepoint's statement was stale), and at most
    // once per connection of the two-connection pool.
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(runs).toBeLessThanOrEqual(3);
  });

  test("other failures inside a transaction are not repeated", async () => {
    let runs = 0;
    await expect(
      pool.db.transaction(async (tx) => {
        runs += 1;
        await tx.execute(sql`select 1 / ${0}::int`);
      }),
    ).rejects.toThrow();
    expect(runs).toBe(1);
  });
});

describe("isStalePreparedResultError", () => {
  const stale = Object.assign(new Error("cached plan must not change result type"), {
    code: "0A000",
    routine: "RevalidateCachedQuery",
  });
  test("recognizes the refusal directly and through a wrapping cause", () => {
    expect(isStalePreparedResultError(stale)).toBe(true);
    expect(isStalePreparedResultError(new Error("Failed query", { cause: stale }))).toBe(true);
    const noRoutine = Object.assign(new Error("cached plan must not change result type"), {
      code: "0A000",
    });
    expect(isStalePreparedResultError(noRoutine)).toBe(true);
  });
  test("ignores other feature-not-supported errors", () => {
    expect(
      isStalePreparedResultError(
        Object.assign(new Error("cannot do that"), { code: "0A000", routine: "Other" }),
      ),
    ).toBe(false);
    expect(isStalePreparedResultError(new Error("cached plan must not change result type"))).toBe(
      false,
    );
    expect(isStalePreparedResultError(null)).toBe(false);
  });
});
