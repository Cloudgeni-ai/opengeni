import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
}

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0068");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0068] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
}, 180_000);

describe("migration 0068 (workflow wake runtime grant)", () => {
  test("restores opengeni_app execution after migration 0063 replaces the claim function", async () => {
    if (!available || !blank) return;
    const admin = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      const pre0068 = files.filter((file) => file < "0068_");
      await admin.unsafe(
        "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
      );
      for (const file of pre0068) {
        await applyFile(admin, file);
        await admin`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [before] = await admin<{ allowed: boolean }[]>`
        select has_function_privilege(
          'opengeni_app',
          'opengeni_private.claim_session_workflow_wakes(integer)',
          'EXECUTE'
        ) as allowed`;
      expect(before?.allowed).toBe(false);

      await applyFile(admin, "0068_session_workflow_wake_grant.sql");
      await applyFile(admin, "0068_session_workflow_wake_grant.sql");

      const [after] = await admin<{ allowed: boolean }[]>`
        select has_function_privilege(
          'opengeni_app',
          'opengeni_private.claim_session_workflow_wakes(integer)',
          'EXECUTE'
        ) as allowed`;
      expect(after?.allowed).toBe(true);

      await admin`set role opengeni_app`;
      const claims = await admin`
        select * from opengeni_private.claim_session_workflow_wakes(1)`;
      expect(claims).toHaveLength(0);
      await admin`reset role`;
    } finally {
      await admin`reset role`.catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  }, 300_000);
});
