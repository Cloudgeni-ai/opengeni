import { afterAll, beforeAll, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import { sql } from "drizzle-orm";

import { createDb } from "../src/database";

let shared: SharedTestDatabase;
let pool: ReturnType<typeof createDb>;

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("hot-session-tables-analyze-cadence");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  pool = createDb(shared.appUrl, { max: 1 });
}, 180_000);

afterAll(async () => {
  await pool?.close();
  await shared?.release();
}, 60_000);

test("hot per-session tables refresh statistics after a fixed number of row changes", async () => {
  const rows = (await pool.db.execute(sql`
    SELECT c.relname AS "table", c.reloptions AS options
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('sessions', 'session_event_cursors')
    ORDER BY c.relname
  `)) as unknown as Array<{ table: string; options: string[] | null }>;

  expect(rows.map((row) => row.table)).toEqual(["session_event_cursors", "sessions"]);
  for (const row of rows) {
    expect(row.options).toEqual(
      expect.arrayContaining([
        "autovacuum_analyze_scale_factor=0",
        "autovacuum_analyze_threshold=50000",
      ]),
    );
    // Vacuum cadence keeps its defaults.
    expect(row.options?.some((option) => option.startsWith("autovacuum_vacuum_"))).toBe(false);
  }
});
