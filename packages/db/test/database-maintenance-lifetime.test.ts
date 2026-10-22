import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { createDb, rawRows, withDatabaseMaintenanceLifetime, type DbClient } from "../src/database";

let fixture: SharedTestDatabase;
let client: DbClient;
beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("database-maintenance-lifetime");
  if (!acquired) throw new Error("Restricted PostgreSQL fixture required");
  fixture = acquired;
  client = createDb(fixture.appUrl, { max: 1 });
  await fixture.admin`create table maintenance_lifetime_probe (id text primary key)`;
  await fixture.admin`grant select,insert on maintenance_lifetime_probe to opengeni_app`;
}, 180_000);
afterAll(async () => {
  await client?.close();
  await fixture?.release();
}, 60_000);

test("cancels the executing statement, joins rollback and safely reuses the pool", async () => {
  const abort = new AbortController();
  const stopped = new Error("caller stopped");
  let pid = 0;
  const work = withDatabaseMaintenanceLifetime(
    client.db,
    { signal: abort.signal, deadlineAtMs: Date.now() + 5000 },
    async (tx) => {
      await tx.execute(sql`insert into maintenance_lifetime_probe values ('rollback')`);
      pid = (await rawRows<{ pid: number }>(tx, sql`select pg_backend_pid() pid`))[0]!.pid;
      await tx.execute(sql`select pg_sleep(3)`);
    },
  );
  // Observe rejection immediately; abort is issued only after the server is
  // executing this exact statement, not just after a client-side timer.
  const outcome = work.then(
    () => null,
    (error) => error,
  );
  let executing = false;
  for (let i = 0; i < 100; i++) {
    const [row] =
      await fixture.admin`select count(*)::int n from pg_stat_activity where pid=${pid} and state='active' and query like '%pg_sleep%'`;
    if (row?.n) {
      executing = true;
      break;
    }
    await Bun.sleep(5);
  }
  expect(pid).toBeGreaterThan(0);
  expect(executing).toBe(true);
  const start = performance.now();
  abort.abort(stopped);
  expect(await outcome).toBeTruthy();
  expect(performance.now() - start).toBeLessThan(1500);
  expect(await fixture.admin`select * from maintenance_lifetime_probe`).toHaveLength(0);
  expect(
    (
      await fixture.admin`select count(*)::int n from pg_stat_activity where pid=${pid} and state='active' and query like '%pg_sleep%'`
    )[0]!.n,
  ).toBe(0);
  for (let i = 0; i < 10; i++) await client.db.execute(sql`select pg_sleep(0.002)`);
  expect(
    (
      await rawRows<{ timeout: string; check: string }>(
        client.db,
        sql`select current_setting('statement_timeout') timeout,current_setting('client_connection_check_interval') as check`,
      )
    )[0],
  ).toEqual({ timeout: "0", check: "0" });
}, 10_000);

test("retains a shorter configured statement timeout", async () => {
  const url = new URL(fixture.appUrl);
  url.searchParams.set("statement_timeout", "100ms");
  const configured = createDb(url.toString(), { max: 1 });
  try {
    const start = performance.now();
    await expect(
      withDatabaseMaintenanceLifetime(
        configured.db,
        { signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000 },
        async (tx) => {
          expect(
            (
              await rawRows<{ value: string }>(
                tx,
                sql`select current_setting('statement_timeout') value`,
              )
            )[0]!.value,
          ).toBe("100ms");
          await tx.execute(sql`select pg_sleep(3)`);
        },
      ),
    ).rejects.toThrow();
    expect(performance.now() - start).toBeLessThan(1500);
  } finally {
    await configured.close();
  }
}, 10_000);

test("the existing run deadline is enforced by PostgreSQL even without a live abort timer", async () => {
  const start = performance.now();
  await expect(
    withDatabaseMaintenanceLifetime(
      client.db,
      { signal: new AbortController().signal, deadlineAtMs: Date.now() + 100 },
      async (tx) => {
        await tx.execute(sql`select pg_sleep(3)`);
      },
    ),
  ).rejects.toThrow();
  expect(performance.now() - start).toBeLessThan(1500);
}, 10_000);

test("an already stopped caller issues no callback work", async () => {
  const abort = new AbortController();
  abort.abort(new Error("already stopped"));
  let called = false;
  await expect(
    withDatabaseMaintenanceLifetime(client.db, { signal: abort.signal }, async () => {
      called = true;
    }),
  ).rejects.toThrow("already stopped");
  expect(called).toBe(false);
});

const require = createRequire(import.meta.url);
for (const [name, driver] of [
  ["esm", postgres],
  [
    "cjs",
    require(
      join(dirname(require.resolve("postgres")), "..", "cjs/src/index.js"),
    ) as typeof postgres,
  ],
] as const) {
  test(`${name} cancellation is joinable, idempotent and safe after query settlement`, async () => {
    const connection = driver(fixture.appUrl, { max: 1 });
    try {
      const finished = connection`select 1`;
      await finished;
      await finished.cancel();
      const running = connection`select pg_sleep(3)`.execute();
      const result = running.then(
        () => null,
        (error) => error,
      );
      await Bun.sleep(30);
      const first = running.cancel();
      expect(running.cancel()).toBe(first);
      await first;
      expect(await result).toMatchObject({ code: "57014" });
      await running.cancel();
      expect((await connection`select 1 as value`)[0]?.value).toBe(1);
    } finally {
      await connection.end();
    }
  }, 10_000);
}

test("abrupt caller death drops the active backend and rolls its page back", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/maintenance-lifetime-child.ts", import.meta.url).pathname,
    ],
    {
      env: { ...process.env, OPENGENI_MAINTENANCE_TEST_URL: fixture.appUrl },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  let pid = 0;
  try {
    for (let i = 0; i < 200; i++) {
      const [row] = await fixture.admin`select pid from pg_stat_activity
        where datname=current_database() and state='active'
          and query like '%pg_sleep(3)%maintenance_child_disconnect%'
          and pid<>pg_backend_pid()`;
      if (row) {
        pid = row.pid;
        break;
      }
      await Bun.sleep(10);
    }
    expect(pid).toBeGreaterThan(0);
    child.kill("SIGKILL");
    await child.exited;
    const start = performance.now();
    let gone = false;
    for (let i = 0; i < 150; i++) {
      const [row] =
        await fixture.admin`select count(*)::int n from pg_stat_activity where pid=${pid}`;
      if (row?.n === 0) {
        gone = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(gone).toBe(true);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(await fixture.admin`select * from maintenance_lifetime_probe`).toHaveLength(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10_000);
