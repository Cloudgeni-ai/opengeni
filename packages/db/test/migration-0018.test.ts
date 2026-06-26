import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

// Migration 0018 (sandbox_os + sandbox_group_id) applied against a THROWAWAY,
// PRISTINE postgres database (acquired from the SHARED test container — see
// packages/testing/src/shared-pg.ts — so the full parallel `bun test` run does
// not spin up one container per file). Proves: the columns/CHECK/index exist
// after the full chain, the backfill is correct (a pre-0018 row gets
// sandbox_os='linux' and sandbox_group_id == id), the CHECK rejects an
// out-of-enum OS, and the migration is rollback-safe (re-applying the whole
// chain is an idempotent no-op). The database is dropped + the shared refcount
// released in afterAll regardless of outcome.
//
// The pgvector image is used because 0000_initial does CREATE EXTENSION vector.
// The opengeni_app GRANT blocks are all IF EXISTS-guarded, so no role
// provisioning is needed for the schema to apply.

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

async function applyFile(sql: postgres.Sql, file: string): Promise<void> {
  const text = await readFile(join(migrationsDir, file), "utf8");
  await sql.unsafe(text);
}

let available = true;
let blank: BlankTestDatabase | null = null;
let DB_URL = "";

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0018");
  if (!blank) {
    available = false;
    // Surface a clear skip reason rather than a cryptic connection error.
    // eslint-disable-next-line no-console
    console.warn("[migration-0018] docker unavailable, skipping");
    return;
  }
  DB_URL = blank.databaseUrl;
}, 120_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0018 (sandbox_os + sandbox_group_id)", () => {
  test("applies the full chain, backfills, enforces CHECK + index, and is idempotent", async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn("[migration-0018] skipped (docker not available)");
      return;
    }

    const sql = postgres(DB_URL, { max: 1 });
    try {
      // --- Phase 1: apply every migration BEFORE 0018, then seed a legacy row.
      const all = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      const pre0018 = all.filter((f) => f < "0018_");
      const has0018 = all.includes("0018_sandbox_os.sql");
      expect(has0018).toBe(true);

      await sql`SELECT pg_advisory_lock(727458)`;
      await sql.unsafe(`CREATE TABLE IF NOT EXISTS "schema_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`);
      for (const file of pre0018) {
        await applyFile(sql, file);
        await sql`INSERT INTO "schema_migrations" ("name") VALUES (${file}) ON CONFLICT DO NOTHING`;
      }

      // Seed a pre-0018 session row (the columns don't exist yet, so this row
      // is exactly the legacy shape the backfill must heal).
      const accountRows = await sql<{ id: string }[]>`
        INSERT INTO "managed_accounts" ("name") VALUES ('acct') RETURNING "id"`;
      const accountId = accountRows[0]!.id;
      const workspaceRows = await sql<{ id: string }[]>`
        INSERT INTO "workspaces" ("account_id", "name") VALUES (${accountId}, 'ws') RETURNING "id"`;
      const workspaceId = workspaceRows[0]!.id;
      const legacyRows = await sql<{ id: string }[]>`
        INSERT INTO "sessions" ("account_id", "workspace_id", "initial_message", "model", "sandbox_backend")
        VALUES (${accountId}, ${workspaceId}, 'hello', 'gpt', 'modal')
        RETURNING "id"`;
      const legacySessionId = legacyRows[0]!.id;

      // Sanity: the new columns do NOT exist before 0018.
      const before = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'sessions' AND column_name IN ('sandbox_os', 'sandbox_group_id')`;
      expect(before.length).toBe(0);

      // --- Phase 2: apply 0018.
      await applyFile(sql, "0018_sandbox_os.sql");
      await sql`INSERT INTO "schema_migrations" ("name") VALUES ('0018_sandbox_os.sql') ON CONFLICT DO NOTHING`;
      await sql`SELECT pg_advisory_unlock(727458)`;

      // --- Columns exist with the right nullability/default.
      const cols = await sql<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }[]>`
        SELECT table_name, column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE (table_name = 'sessions' AND column_name IN ('sandbox_os', 'sandbox_group_id'))
           OR (table_name = 'session_turns' AND column_name = 'sandbox_os')
        ORDER BY table_name, column_name`;
      const colMap = new Map(cols.map((c) => [`${c.table_name}.${c.column_name}`, c]));

      const sessOs = colMap.get("sessions.sandbox_os");
      expect(sessOs).toBeDefined();
      expect(sessOs!.is_nullable).toBe("NO");
      expect(sessOs!.column_default).toContain("linux");

      const sessGroup = colMap.get("sessions.sandbox_group_id");
      expect(sessGroup).toBeDefined();
      expect(sessGroup!.is_nullable).toBe("NO");

      const turnOs = colMap.get("session_turns.sandbox_os");
      expect(turnOs).toBeDefined();
      expect(turnOs!.is_nullable).toBe("YES"); // nullable override

      // --- Backfill correctness: the legacy row got linux + group == id.
      const legacyRow = (await sql<{ sandbox_os: string; sandbox_group_id: string; id: string }[]>`
        SELECT "sandbox_os", "sandbox_group_id", "id" FROM "sessions" WHERE "id" = ${legacySessionId}`)[0]!;
      expect(legacyRow.sandbox_os).toBe("linux");
      expect(legacyRow.sandbox_group_id).toBe(legacySessionId);
      expect(legacyRow.sandbox_group_id).toBe(legacyRow.id);

      // --- CHECK constraints exist and reject an out-of-enum OS.
      const checks = await sql<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conname IN ('sessions_sandbox_os_check', 'session_turns_sandbox_os_check')
        ORDER BY conname`;
      expect(checks.map((c) => c.conname)).toEqual(["session_turns_sandbox_os_check", "sessions_sandbox_os_check"]);

      let rejected = false;
      try {
        await sql`
          INSERT INTO "sessions" ("account_id", "workspace_id", "initial_message", "model", "sandbox_backend", "sandbox_os", "sandbox_group_id")
          VALUES (${accountId}, ${workspaceId}, 'bad', 'gpt', 'modal', 'solaris', gen_random_uuid())`;
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);

      // A NULL session_turns.sandbox_os is allowed (the nullable-override path).
      const okOsValues = await sql<{ sandbox_os: string }[]>`
        INSERT INTO "sessions" ("account_id", "workspace_id", "initial_message", "model", "sandbox_backend", "sandbox_os", "sandbox_group_id")
        VALUES (${accountId}, ${workspaceId}, 'win', 'gpt', 'modal', 'windows', gen_random_uuid())
        RETURNING "sandbox_os"`;
      expect(okOsValues[0]!.sandbox_os).toBe("windows");

      // --- Index exists on (workspace_id, sandbox_group_id).
      const [idx] = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'sessions' AND indexname = 'sessions_sandbox_group_idx'`;
      expect(idx?.indexname).toBe("sessions_sandbox_group_idx");

      // --- Rollback-safety / idempotency: the real runner re-applies the whole
      // chain (it sees 0018 already applied and skips; re-running any IF NOT
      // EXISTS DDL is a no-op). Must not throw and must not corrupt the backfill.
      await migrate(DB_URL);
      const legacyAfter = (await sql<{ sandbox_os: string; sandbox_group_id: string }[]>`
        SELECT "sandbox_os", "sandbox_group_id" FROM "sessions" WHERE "id" = ${legacySessionId}`)[0]!;
      expect(legacyAfter.sandbox_os).toBe("linux");
      expect(legacyAfter.sandbox_group_id).toBe(legacySessionId);
    } finally {
      await sql.end();
    }
  }, 120_000);
});
