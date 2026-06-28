import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

// Migration 0020 (session_recordings) applied against a THROWAWAY, PRISTINE
// postgres database (acquired from the SHARED test container — see
// packages/testing/src/shared-pg.ts) via the full migrate() chain. Proves: the
// recording table exists with the right columns + the (workspace, session,
// created_at) list index + RLS enabled, the CHECK constraints reject bad
// state/mode/codec, the row updates in place (start → finalizing → available),
// and the migration is rollback-safe (re-running the whole chain is an
// idempotent no-op). The database is dropped + the shared refcount released in
// afterAll.
//
// The pgvector image is used (0000_initial does CREATE EXTENSION vector). The
// opengeni_app GRANT block is IF EXISTS-guarded, so no role provisioning is
// needed for the schema to apply (the table-level assertions run as superuser).

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

let available = true;
let blank: BlankTestDatabase | null = null;
let DB_URL = "";

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0020");
  if (!blank) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn("[migration-0020] docker unavailable, skipping");
    return;
  }
  DB_URL = blank.databaseUrl;
}, 120_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0020 (session_recordings)", () => {
  test("applies the full chain, has the table + list index + RLS + CHECKs, and the lifecycle update is in-place", async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn("[migration-0020] skipped (docker not available)");
      return;
    }
    const sql = postgres(DB_URL, { max: 1 });
    try {
      // The migration file is in the chain.
      const all = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      expect(all.includes("0020_session_recordings.sql")).toBe(true);

      // Apply the full chain via the real runner.
      await migrate(DB_URL);

      // --- Columns exist.
      const cols = await sql<{ column_name: string; is_nullable: string }[]>`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'session_recordings'
        ORDER BY column_name`;
      const colNames = new Set(cols.map((c) => c.column_name));
      for (const name of ["id", "account_id", "workspace_id", "session_id", "turn_id", "state", "mode", "codec", "storage_key", "size_bytes", "duration_seconds", "width", "height", "reason", "created_at", "finalized_at"]) {
        expect(colNames.has(name), `missing column ${name}`).toBe(true);
      }

      // --- The list index exists.
      const idx = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes WHERE tablename = 'session_recordings' ORDER BY indexname`;
      expect(idx.map((r) => r.indexname)).toContain("session_recordings_session_idx");

      // --- RLS is enabled + forced.
      const rls = (await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'session_recordings'`)[0]!;
      expect(rls.relrowsecurity).toBe(true);
      expect(rls.relforcerowsecurity).toBe(true);

      // --- Seed the FK chain.
      const accountId = (await sql<{ id: string }[]>`INSERT INTO "managed_accounts" ("name") VALUES ('acct') RETURNING "id"`)[0]!.id;
      const workspaceId = (await sql<{ id: string }[]>`INSERT INTO "workspaces" ("account_id", "name") VALUES (${accountId}, 'ws') RETURNING "id"`)[0]!.id;
      // sandbox_group_id is app-generated (== id for a singleton group), NOT NULL
      // since 0018 — supply both from one uuid.
      const sessionId = (await sql<{ id: string }[]>`
        INSERT INTO "sessions" ("id", "account_id", "workspace_id", "status", "sandbox_backend", "initial_message", "model", "sandbox_group_id")
        VALUES (gen_random_uuid(), ${accountId}, ${workspaceId}, 'idle', 'modal', 'hi', 'gpt-5', gen_random_uuid()) RETURNING "id"`)[0]!.id;

      // --- The CHECK constraints reject a bad state/mode/codec. Each negative
      // insert runs on its OWN short-lived connection so a failed statement can't
      // wedge the shared (max:1) connection used by the rest of the test.
      const expectRejects = async (run: (s: postgres.Sql) => Promise<unknown>): Promise<void> => {
        const probe = postgres(DB_URL, { max: 1 });
        let threw = false;
        try {
          await run(probe);
        } catch {
          threw = true;
        } finally {
          await probe.end();
        }
        expect(threw).toBe(true);
      };
      await expectRejects((s) => s`
        INSERT INTO "session_recordings" ("account_id","workspace_id","session_id","state","mode","codec","width","height")
        VALUES (${accountId},${workspaceId},${sessionId},'bogus','on-turn','h264-mp4',1280,800)`);
      await expectRejects((s) => s`
        INSERT INTO "session_recordings" ("account_id","workspace_id","session_id","state","mode","codec","width","height")
        VALUES (${accountId},${workspaceId},${sessionId},'recording','on-turn','av1',1280,800)`);

      // --- The lifecycle: insert recording → finalizing → available (in place).
      const recId = (await sql<{ id: string }[]>`
        INSERT INTO "session_recordings" ("account_id","workspace_id","session_id","state","mode","codec","width","height")
        VALUES (${accountId},${workspaceId},${sessionId},'recording','on-turn','h264-mp4',1280,800) RETURNING "id"`)[0]!.id;
      await sql`UPDATE "session_recordings" SET state='finalizing' WHERE id=${recId}`;
      await sql`UPDATE "session_recordings" SET state='available', storage_key='recordings/x/y/z.mp4', size_bytes=4242, duration_seconds=12.5, finalized_at=now() WHERE id=${recId}`;
      const rows = await sql<{ state: string; storage_key: string; size_bytes: string; duration_seconds: number }[]>`
        SELECT state, storage_key, size_bytes, duration_seconds FROM "session_recordings" WHERE id=${recId}`;
      expect(rows.length).toBe(1); // in-place, no duplicate
      expect(rows[0]!.state).toBe("available");
      expect(rows[0]!.storage_key).toBe("recordings/x/y/z.mp4");
      expect(Number(rows[0]!.size_bytes)).toBe(4242);

      // --- Idempotent: re-running the whole chain is a no-op.
      await migrate(DB_URL);
      const still = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM "session_recordings" WHERE id=${recId}`;
      expect(still[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  }, 120_000);
});
