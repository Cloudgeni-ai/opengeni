import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { executeMigrationFile } from "../src/migrate";

let blank: BlankTestDatabase;
beforeAll(async () => {
  const acquired = await acquireBlankTestDatabase("ordinary-migration-lock-timeout");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  blank = acquired;
}, 180_000);
afterAll(async () => await blank?.release(), 60_000);

describe("ordinary migration lock wait", () => {
  test("fails without partial DDL or receipt, releases its local setting, and retries", async () => {
    const locker = postgres(blank.databaseUrl, { max: 1 });
    const runner = postgres(blank.databaseUrl, { max: 1 });
    const file = "lock_wait_probe.sql";
    const body = `ALTER TABLE before_lock ADD COLUMN applied integer;
ALTER TABLE blocked ADD COLUMN applied integer;`;
    try {
      await runner.unsafe(`
        CREATE TABLE before_lock (id integer);
        CREATE TABLE blocked (id integer);
        CREATE TABLE schema_migrations (name text PRIMARY KEY);
      `);
      const apply = async () => {
        await executeMigrationFile(runner, file, body);
        await runner`INSERT INTO schema_migrations(name) VALUES (${file})`;
      };

      await locker.begin(async (tx) => {
        await tx`ALTER TABLE blocked ADD COLUMN held integer`;
        await expect(apply()).rejects.toMatchObject({ code: "55P03" });
        // The first ALTER and its preamble must have rolled back together.
        const [first] = await runner`
          SELECT COUNT(*)::int AS count FROM information_schema.columns
          WHERE table_name = 'before_lock' AND column_name = 'applied'
        `;
        expect(first?.count).toBe(0);
        expect(await runner`SELECT name FROM schema_migrations`).toHaveLength(0);
        const [setting] = await runner`SELECT current_setting('lock_timeout') AS value`;
        expect(setting?.value).toBe("0");
      });

      await apply();
      const columns = await runner`
        SELECT table_name FROM information_schema.columns
        WHERE table_name IN ('before_lock', 'blocked') AND column_name = 'applied'
        ORDER BY table_name
      `;
      expect(columns.map((row) => row.table_name)).toEqual(["before_lock", "blocked"]);
      expect([...(await runner`SELECT name FROM schema_migrations`)]).toEqual([{ name: file }]);
    } finally {
      await runner.end();
      await locker.end();
    }
  }, 180_000);

  test("a migration-specific SET LOCAL overrides the default within its body", async () => {
    const runner = postgres(blank.databaseUrl, { max: 1 });
    try {
      await runner`CREATE TABLE local_lock_override (value text)`;
      await executeMigrationFile(
        runner,
        "local_override_probe.sql",
        `SET LOCAL lock_timeout = '100ms';
INSERT INTO local_lock_override SELECT current_setting('lock_timeout');`,
      );
      expect([...(await runner`SELECT value FROM local_lock_override`)]).toEqual([
        { value: "100ms" },
      ]);
      const [setting] = await runner`SELECT current_setting('lock_timeout') AS value`;
      expect(setting?.value).toBe("0");
    } finally {
      await runner.end();
    }
  }, 180_000);
});
