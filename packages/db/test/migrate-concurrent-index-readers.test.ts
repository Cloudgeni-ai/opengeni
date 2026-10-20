import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { executeMigrationFile } from "../src/migrate";

let blank: BlankTestDatabase;
beforeAll(async () => {
  const acquired = await acquireBlankTestDatabase("concurrent-index-readers");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  blank = acquired;
}, 180_000);
afterAll(async () => await blank?.release(), 60_000);

const header = "-- deployment-mode: rolling\n-- opengeni:concurrent-index lock-timeout=100ms\n";

describe("concurrent index snapshot waits", () => {
  test("waits past the historical timeout for a reader of another table", async () => {
    const runner = postgres(blank.databaseUrl, { max: 1 });
    const reader = postgres(blank.databaseUrl, { max: 1 });
    const observer = postgres(blank.databaseUrl, { max: 1 });
    const snapshotReady = Promise.withResolvers<void>();
    const releaseSnapshot = Promise.withResolvers<void>();
    let reading: Promise<unknown> | undefined;
    let building: Promise<unknown> | undefined;
    try {
      await runner.unsafe(`CREATE TABLE snapshot_source (id integer);
        CREATE TABLE index_target (id integer);
        INSERT INTO index_target SELECT generate_series(1, 1000);`);
      await runner`set lock_timeout = '250ms'`;
      const [backend] = await runner`select pg_backend_pid() as pid`;
      reading = reader.begin("isolation level repeatable read", async (tx) => {
        await tx`select * from snapshot_source`;
        snapshotReady.resolve();
        await releaseSnapshot.promise;
      });
      await snapshotReady.promise;
      let completed = false;
      building = executeMigrationFile(
        runner,
        "reader_probe.sql",
        header +
          "CREATE INDEX CONCURRENTLY IF NOT EXISTS reader_probe ON index_target (id) WHERE id > 0;",
      ).then(
        () => {
          completed = true;
        },
        (error: unknown) => {
          completed = true;
          throw error;
        },
      );
      // Attach rejection handling while observing the in-flight build.
      void building.catch(() => undefined);
      let waiting = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (completed) break;
        const [progress] = await observer`
          select phase from pg_stat_progress_create_index where pid = ${backend!.pid}`;
        if (progress?.phase === "waiting for old snapshots") {
          waiting = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      await Bun.sleep(350);
      expect(completed).toBe(false);
      releaseSnapshot.resolve();
      await reading;
      await building;
      const [index] = await runner`
        select indisvalid, indisready from pg_index where indexrelid = 'reader_probe'::regclass`;
      expect(index).toMatchObject({ indisvalid: true, indisready: true });
      const [setting] = await runner`select current_setting('lock_timeout') as value`;
      expect(setting?.value).toBe("250ms");
    } finally {
      releaseSnapshot.resolve();
      await reading?.catch(() => undefined);
      await building?.catch(() => undefined);
      await Promise.all([runner.end(), reader.end(), observer.end()]);
    }
  }, 180_000);

  test("restores settings after failure and rebuilds an invalid index on retry", async () => {
    const runner = postgres(blank.databaseUrl, { max: 1 });
    try {
      await runner.unsafe(
        "CREATE TABLE duplicate_target (id integer); INSERT INTO duplicate_target VALUES (1), (1);",
      );
      await runner`set lock_timeout = '250ms'`;
      const statement =
        header +
        "CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS duplicate_probe ON duplicate_target (id);";
      await expect(
        executeMigrationFile(runner, "duplicate_probe.sql", statement),
      ).rejects.toMatchObject({ code: "23505" });
      const [failed] = await runner`
        select indisvalid from pg_index where indexrelid = 'duplicate_probe'::regclass`;
      expect(failed?.indisvalid).toBe(false);
      const [setting] = await runner`select current_setting('lock_timeout') as value`;
      expect(setting?.value).toBe("250ms");
      await runner`delete from duplicate_target where ctid in (select ctid from duplicate_target limit 1)`;
      await executeMigrationFile(runner, "duplicate_probe.sql", statement);
      const [rebuilt] = await runner`
        select indisvalid from pg_index where indexrelid = 'duplicate_probe'::regclass`;
      expect(rebuilt?.indisvalid).toBe(true);
      await executeMigrationFile(runner, "duplicate_probe.sql", statement);
    } finally {
      await runner.end();
    }
  }, 180_000);
});
