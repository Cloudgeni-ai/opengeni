import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

import { migrate } from "../src/migrate";

const migrationName = "0054_session_pins.sql";
const snapshotMigrationName = "0055_session_list_snapshots.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let available = true;
let blank: BlankTestDatabase | null = null;
let admin: postgres.Sql;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0054-pins");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0054-session-pins] OPENGENI_REQUIRE_REAL_DB=1 but PostgreSQL is unavailable",
      );
    }
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[migration-0054-session-pins] docker unavailable, skipping");
    return;
  }
  admin = postgres(blank.databaseUrl, { max: 4 });
  await admin.unsafe(`
    CREATE TABLE schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const migrationsUrl = new URL("../drizzle/", import.meta.url);
  const prior = (await readdir(migrationsUrl))
    .filter((file) => file.endsWith(".sql") && file.localeCompare(migrationName) < 0)
    .sort();
  for (const file of prior) {
    await admin.unsafe(await readFile(new URL(file, migrationsUrl), "utf8"));
    await admin`insert into schema_migrations (name) values (${file})`;
  }
}, 180_000);

afterAll(async () => {
  await admin?.end().catch(() => undefined);
  await blank?.release();
}, 180_000);

describe("0054 session pin migration (real PostgreSQL)", () => {
  // The harness budget is a safety net, not the contract. What this test actually
  // bounds is the blocked migration's own `elapsedMs` (>= 4 s, < 15 s), asserted
  // below against the `SET lock_timeout = '5s'` inside `0054_session_pins.sql`
  // itself. That pair is untouched here and measures 5.02 s with about 20 ms of
  // client overhead, so it has roughly ten seconds of slack and remains what
  // would catch a real lock-contention regression.
  //
  // The budget additionally has to cover the retry `migrate()` to head. Its
  // result is asserted below; its DURATION is bounded by nothing, and it grows
  // with every unrelated migration that lands. When `30_000` was chosen
  // (e4d3569c, 2026-07-12) the ledger held 61 migrations and none sorted after
  // `0054`, so that phase replayed only `0054` itself and 30 s was simply twice
  // the 15 s internal bound. Today it replays 290. Measured here: ~5.02 s
  // blocked plus ~2.84 s migrating, ~7.86 s of the 30 s.
  //
  // The one observed failure (PR #1792, job 97473277348) is the proof that the
  // eroded margin, not the contract, is what broke: it reports `5 expect() calls`
  // of the six, so everything through `< 15_000` PASSED and the timeout landed
  // inside the retry `migrate()`. That runner was in CI's heavy tail, roughly 9x
  // slower at migration replay than this machine; CI is not systematically slower
  // (this file runs isolated, and sampled runs sit at 7.3 s to 13.1 s), but the
  // lost margin is what made one slow runner fatal.
  //
  // Raising the net to match this file's own `beforeAll`/`afterAll` restores the
  // runway without weakening an assertion. It costs a longer wall-clock failure
  // if the blocked phase ever hangs outright, which is why the internal bounds
  // stay: a regression pushing `lock_timeout` past 15 s fails on that assertion
  // with a real message rather than as a bare timeout.
  test("bounds production lock contention and cleanly retries", async () => {
    if (!available || !blank) return;
    const blocker = postgres(blank.databaseUrl, { max: 1 });
    await blocker.unsafe("begin; lock table sessions in access exclusive mode");
    const startedAt = performance.now();
    let migrationError: unknown;
    try {
      await migrate(blank.databaseUrl);
    } catch (error) {
      migrationError = error;
    } finally {
      await blocker.unsafe("rollback");
      await blocker.end();
    }
    const elapsedMs = performance.now() - startedAt;
    expect(migrationError).toBeDefined();
    expect((migrationError as { code?: unknown }).code).toBe("55P03");
    expect(elapsedMs).toBeGreaterThanOrEqual(4_000);
    expect(elapsedMs).toBeLessThan(15_000);
    const [failedRecord] = await admin<{ count: number }[]>`
      select count(*)::int as count from schema_migrations
      where name = ${migrationName}`;
    expect(failedRecord?.count).toBe(0);

    await migrate(blank.databaseUrl);
    const [state] = await admin<
      {
        applied: boolean;
        snapshotApplied: boolean;
        indexValid: boolean;
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        snapshotRowSecurity: boolean;
        snapshotForceRowSecurity: boolean;
      }[]
    >`
      select
        (select count(*) = 1 from schema_migrations
          where name = ${migrationName}) as applied,
        (select count(*) = 1 from schema_migrations
          where name = ${snapshotMigrationName}) as "snapshotApplied",
        coalesce((
          select i.indisvalid
          from pg_index i
          join pg_class c on c.oid = i.indexrelid
          where c.relname = 'sessions_workspace_id_idx'
        ), false) as "indexValid",
        c.relrowsecurity as "rowSecurity",
        c.relforcerowsecurity as "forceRowSecurity",
        snapshot.relrowsecurity as "snapshotRowSecurity",
        snapshot.relforcerowsecurity as "snapshotForceRowSecurity"
      from pg_class c
      cross join pg_class snapshot
      where c.oid = 'session_pins'::regclass
        and snapshot.oid = 'session_list_snapshots'::regclass`;
    expect(state).toEqual({
      applied: true,
      snapshotApplied: true,
      indexValid: true,
      rowSecurity: true,
      forceRowSecurity: true,
      snapshotRowSecurity: true,
      snapshotForceRowSecurity: true,
    });
  }, 180_000);
});
