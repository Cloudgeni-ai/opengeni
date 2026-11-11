import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import { sql } from "drizzle-orm";

import { createDb, rawRows, type Database } from "../src/database";

// Every PostgreSQL backend keeps its catalog cache and prepared plans until the
// connection closes, so the pool must close idle connections and recycle busy
// ones. These run against a real server with second-scale timers. A lifetime
// of N seconds is drawn from 0.75N-N, and starts when the TCP connection opens.

let shared: SharedTestDatabase;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("pool-recycling");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

async function backendPid(db: Database): Promise<number> {
  const [row] = await rawRows<{ pid: number }>(db, sql`select pg_backend_pid() as pid`);
  return row!.pid;
}

async function backendAlive(pid: number): Promise<boolean> {
  const rows = await shared.admin`select 1 from pg_stat_activity where pid = ${pid}`;
  return rows.length > 0;
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await backendAlive(pid))) return true;
    await Bun.sleep(50);
  }
  return !(await backendAlive(pid));
}

/** This file's own `... + 1 as value` statements prepared on the current backend. */
async function preparedOnBackend(db: Database): Promise<number> {
  // No parameters, so this runs over the simple protocol and is not itself prepared.
  const [row] = await rawRows<{ count: number }>(
    db,
    sql`select count(*)::int as count from pg_prepared_statements
      where statement like '%::int + 1 as value%'`,
  );
  return row!.count;
}

describe("pool connection recycling", () => {
  test("an idle connection closes its backend after the idle timeout", async () => {
    const pool = createDb(shared.appUrl, { max: 1, idleTimeoutSeconds: 1, maxLifetimeSeconds: 0 });
    try {
      const first = await backendPid(pool.db);
      expect(await backendAlive(first)).toBe(true);
      expect(await waitUntilGone(first, 5_000)).toBe(true);
      // The pool reopens on demand.
      const second = await backendPid(pool.db);
      expect(second).not.toBe(first);
    } finally {
      await pool.close();
    }
  }, 30_000);

  test("a connection that never idles is still recycled, without failing a query", async () => {
    const pool = createDb(shared.appUrl, { max: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 1 });
    try {
      const pids = new Set<number>();
      // The lifetime is at most 1 s; the deadline only guards a stalled server.
      const deadline = Date.now() + 20_000;
      let queries = 0;
      while (pids.size < 2 && Date.now() < deadline) {
        const [row] = await rawRows<{ pid: number; value: number }>(
          pool.db,
          sql`select pg_backend_pid() as pid, ${queries}::int as value`,
        );
        expect(row!.value).toBe(queries);
        pids.add(row!.pid);
        queries += 1;
      }
      expect(pids.size).toBe(2);
      const [retired] = [...pids];
      expect(await waitUntilGone(retired!, 5_000)).toBe(true);
    } finally {
      await pool.close();
    }
  }, 60_000);

  test("a query that outlives the connection's lifetime still completes", async () => {
    const pool = createDb(shared.appUrl, { max: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 2 });
    try {
      const [row] = await rawRows<{ pid: number; value: number }>(
        pool.db,
        sql`select pg_backend_pid() as pid, ${7}::int as value from pg_sleep(${2.2})`,
      );
      expect(row!.value).toBe(7);
      expect(await waitUntilGone(row!.pid, 5_000)).toBe(true);
      expect(await backendPid(pool.db)).not.toBe(row!.pid);
    } finally {
      await pool.close();
    }
  }, 30_000);

  test("recycling waits for an open transaction and starts with no prepared statements", async () => {
    const pool = createDb(shared.appUrl, { max: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 2 });
    try {
      const inside = await pool.db.transaction(async (tx) => {
        const before = await backendPid(tx);
        const [warm] = await rawRows<{ value: number }>(tx, sql`select ${41}::int + 1 as value`);
        const prepared = await preparedOnBackend(tx);
        // Outlive the connection's whole lifetime inside the transaction.
        await rawRows(tx, sql`select pg_sleep(${2.2})`);
        const after = await backendPid(tx);
        const [row] = await rawRows<{ value: number }>(tx, sql`select ${1}::int + 1 as value`);
        return { before, after, prepared, warm: warm!.value, value: row!.value };
      });
      expect(inside.warm).toBe(42);
      expect(inside.prepared).toBeGreaterThan(0);
      expect(inside.after).toBe(inside.before);
      expect(inside.value).toBe(2);

      // The expired backend ends once the transaction commits; the replacement
      // starts with an empty statement cache.
      expect(await waitUntilGone(inside.before, 5_000)).toBe(true);
      expect(await backendPid(pool.db)).not.toBe(inside.before);
      expect(await preparedOnBackend(pool.db)).toBe(0);
    } finally {
      await pool.close();
    }
  }, 30_000);
});
