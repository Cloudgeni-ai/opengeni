import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { executeMigrationFile } from "../src/migrate";

let blank: BlankTestDatabase;
const legacyPermissions = ["workspace:read", "sessions:read"];
const backfillFile = "0999_member_permissions_backfill.sql";
const backfill = `-- deployment-mode: rolling
-- opengeni:batched-backfill batch-size=500 lock-timeout=1s statement-timeout=10s
WITH candidates AS MATERIALIZED (
  SELECT membership.id
  FROM workspace_memberships membership
  WHERE membership.permissions = '${JSON.stringify(legacyPermissions)}'::jsonb
  ORDER BY membership.id
  LIMIT 500
  FOR UPDATE OF membership
), backfilled AS (
  UPDATE workspace_memberships membership
  SET permissions = '${JSON.stringify([...legacyPermissions, "connections:write"])}'::jsonb,
      updated_at = pg_catalog.clock_timestamp()
  FROM candidates
  WHERE membership.id = candidates.id
  RETURNING membership.id
)
SELECT id FROM backfilled;
`;
const indexMigrations: Record<string, string> = {
  "0997_realtime_history_reference_index.sql": `-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS session_realtime_entries_history_item_idx
ON session_realtime_entries (history_item_id)
WHERE history_item_id IS NOT NULL;
`,
  "0998_unsettled_admissions_session_index.sql": `-- deployment-mode: rolling
-- opengeni:concurrent-index lock-timeout=5s
CREATE INDEX CONCURRENTLY IF NOT EXISTS sandbox_workspace_mutation_admissions_unsettled_session_idx
ON sandbox_workspace_mutation_admissions (workspace_id, session_id)
WHERE settled_at IS NULL;
`,
};

beforeAll(async () => {
  const acquired = await acquireBlankTestDatabase("backfill-timeouts");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  blank = acquired;
}, 180_000);
afterAll(async () => await blank?.release(), 60_000);

async function settings(sql: postgres.Sql) {
  const [row] = await sql`select current_setting('statement_timeout') as statement,
    current_setting('lock_timeout') as lock, pg_backend_pid() as pid`;
  return row!;
}

async function fixture(schema: string) {
  const runner = postgres(blank.databaseUrl, {
    max: 1,
    connection: { statement_timeout: 1500, lock_timeout: 250 },
  });
  await runner.unsafe(`create schema ${schema}; set search_path = ${schema}, public;
    create table workspace_memberships (
      id integer primary key, role text, subject_id text, permissions jsonb, updated_at timestamptz
    );`);
  await runner`insert into workspace_memberships values (1, 'member', 'fixture',
    ${runner.json(legacyPermissions)}::jsonb, now())`;
  const [seed] = await runner`select permissions from workspace_memberships where id = 1`;
  expect(seed!.permissions).toEqual(legacyPermissions);
  return runner;
}

test("a batched backfill restores inherited timeout values after successful batches and empty completion", async () => {
  const runner = await fixture("backfill_success");
  try {
    await runner.unsafe(`create table batch_settings(statement_timeout text, lock_timeout text);
      create function capture_batch() returns trigger language plpgsql as $$
        begin insert into batch_settings values
          (current_setting('statement_timeout'), current_setting('lock_timeout')); return new; end $$;
      create trigger capture_batch before update on workspace_memberships
        for each row execute function capture_batch();`);
    const before = await settings(runner);
    await executeMigrationFile(runner, backfillFile, backfill);
    expect(await settings(runner)).toEqual(before);
    const [row] = await runner`select permissions from workspace_memberships where id = 1`;
    expect(row!.permissions).toContain("connections:write");
    const captured = await runner`select * from batch_settings`;
    expect([...captured]).toEqual([{ statement_timeout: "10s", lock_timeout: "1s" }]);
    await executeMigrationFile(runner, backfillFile, backfill);
    expect(await settings(runner)).toEqual(before);
  } finally {
    await runner.end();
  }
});

for (const failure of ["error", "cancel"] as const) {
  test(`a batched backfill restores inherited settings after ${failure} and rolls back its batch`, async () => {
    const runner = await fixture(`backfill_${failure}`);
    const observer = postgres(blank.databaseUrl, { max: 1 });
    let running: Promise<unknown> | undefined;
    try {
      await runner.unsafe(`create function reject_batch() returns trigger language plpgsql as $$
        begin ${failure === "error" ? "raise exception 'controlled batch failure' using errcode='P0001';" : "perform pg_sleep(10);"}
        return new; end $$;
        create trigger reject_batch before update on workspace_memberships
        for each row execute function reject_batch();`);
      const before = await settings(runner);
      running = executeMigrationFile(runner, backfillFile, backfill);
      void running.catch(() => undefined);
      if (failure === "cancel") {
        let sleeping = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const [state] =
            await observer`select wait_event from pg_stat_activity where pid = ${before.pid}`;
          if (state?.wait_event === "PgSleep") {
            sleeping = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(sleeping).toBe(true);
        const [cancelled] = await observer`select pg_cancel_backend(${before.pid}) as cancelled`;
        expect(cancelled?.cancelled).toBe(true);
      }
      await expect(running).rejects.toMatchObject({
        code: failure === "error" ? "P0001" : "57014",
      });
      expect(await settings(runner)).toEqual(before);
      const [row] = await runner`select permissions from workspace_memberships where id = 1`;
      expect(row!.permissions).toEqual(legacyPermissions);
    } finally {
      await running?.catch(() => undefined);
      await Promise.all([runner.end(), observer.end()]);
    }
  }, 30_000);
}

for (const [file, source] of Object.entries(indexMigrations)) {
  test(`${file} after a backfill retains the inherited deadline through snapshot cancellation and retry`, async () => {
    const schema = `after_${file.slice(0, 4)}`;
    const runner = await fixture(schema);
    const reader = postgres(blank.databaseUrl, { max: 1 });
    const observer = postgres(blank.databaseUrl, { max: 1 });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let reading: Promise<unknown> | undefined;
    let building: Promise<unknown> | undefined;
    const indexName = source.match(/IF NOT EXISTS (\w+)/)![1]!;
    try {
      await runner.unsafe(`create table snapshot_source(id integer);
        create table session_realtime_entries(history_item_id integer);
        insert into session_realtime_entries select generate_series(1, 1000);
        create table sandbox_workspace_mutation_admissions(workspace_id integer, session_id integer, settled_at timestamptz);
        insert into sandbox_workspace_mutation_admissions select 1, g, null from generate_series(1, 1000) g;
        create table index_settings(statement_timeout text, lock_timeout text);
        create function capture_settings() returns event_trigger language plpgsql as $$
          begin insert into ${schema}.index_settings values
            (current_setting('statement_timeout'), current_setting('lock_timeout')); end $$;
        create event trigger capture_${schema} on ddl_command_start when tag in ('CREATE INDEX')
          execute function ${schema}.capture_settings();`);
      const before = await settings(runner);
      await executeMigrationFile(runner, backfillFile, backfill);
      // This assertion fails on the original runner before any potentially unbounded index build.
      expect(await settings(runner)).toEqual(before);
      reading = reader.begin("isolation level repeatable read", async (tx) => {
        await tx.unsafe(`select * from ${schema}.snapshot_source`);
        ready.resolve();
        await release.promise;
      });
      void reading.catch(() => undefined);
      await ready.promise;
      const start = Date.now();
      let complete = false;
      building = executeMigrationFile(runner, file, source).finally(() => {
        complete = true;
      });
      void building.catch(() => undefined);
      let waiting = false;
      while (Date.now() - start < 5_000) {
        if (complete) break;
        const [progress] =
          await observer`select phase from pg_stat_progress_create_index where pid = ${before.pid}`;
        if (progress?.phase === "waiting for old snapshots") {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await expect(building).rejects.toMatchObject({ code: "57014" });
      expect(Date.now() - start).toBeGreaterThanOrEqual(1_000);
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(await settings(runner)).toEqual(before);
      const [invalid] =
        await runner`select indisvalid from pg_index where indexrelid = ${`${schema}.${indexName}`}::regclass`;
      expect(invalid?.indisvalid).toBe(false);
      release.resolve();
      await reading;
      await executeMigrationFile(runner, file, source);
      const [valid] =
        await runner`select indisvalid, indisready from pg_index where indexrelid = ${`${schema}.${indexName}`}::regclass`;
      expect(valid).toMatchObject({ indisvalid: true, indisready: true });
      const captured = await runner`select * from index_settings`;
      expect(captured.length).toBeGreaterThan(0);
      expect(
        captured.every(
          (row) => row.statement_timeout === before.statement && row.lock_timeout === "0",
        ),
      ).toBe(true);
      expect(await settings(runner)).toEqual(before);
      await executeMigrationFile(runner, file, source);
      expect(await settings(runner)).toEqual(before);
    } finally {
      release.resolve();
      await reading?.catch(() => undefined);
      await building?.catch(() => undefined);
      await runner.unsafe(`drop event trigger if exists capture_${schema}`);
      await Promise.all([runner.end(), reader.end(), observer.end()]);
    }
  }, 30_000);
}
