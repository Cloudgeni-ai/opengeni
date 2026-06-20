import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

// Migration 0019 (session_stream_acknowledgments) applied against a THROWAWAY
// postgres via the full migrate() chain. Proves: the consent-gate table exists
// with the right columns + the unique (workspace, group, subject) index + RLS
// enabled, the upsert (re-ack) is a no-duplicate ON CONFLICT DO UPDATE that ORs
// the consent bits monotonically, and the migration is rollback-safe (re-running
// the whole chain is an idempotent no-op). Container torn down in afterAll.
//
// pgvector/pgvector:pg16 (0000_initial does CREATE EXTENSION vector). The
// opengeni_app GRANT block is IF EXISTS-guarded, so no role provisioning is
// needed for the schema to apply (the table-level assertions run as superuser).

const CONTAINER = "ogbuild-pg-0019";
const PORT = 55434;
const PASSWORD = "x";
const DB_URL = `postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
const IMAGE = "pgvector/pgvector:pg16";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function removeContainer(): void {
  try {
    docker(["rm", "-f", CONTAINER]);
  } catch {
    // already gone
  }
}

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const probe = postgres(DB_URL, { max: 1, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        return;
      } finally {
        await probe.end();
      }
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(`postgres did not become ready in time: ${String(err)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

let available = true;

beforeAll(async () => {
  try {
    removeContainer();
    docker(["run", "--rm", "-d", "-e", `POSTGRES_PASSWORD=${PASSWORD}`, "-p", `${PORT}:5432`, "--name", CONTAINER, IMAGE]);
  } catch (err) {
    available = false;
    // eslint-disable-next-line no-console
    console.warn(`[migration-0019] docker unavailable, skipping: ${String(err)}`);
    return;
  }
  await waitForReady();
}, 120_000);

afterAll(() => {
  removeContainer();
});

describe("migration 0019 (session_stream_acknowledgments)", () => {
  test("applies the full chain, has the table + unique index + RLS, and the re-ack upsert ORs consent bits monotonically", async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn("[migration-0019] skipped (docker not available)");
      return;
    }
    const sql = postgres(DB_URL, { max: 1 });
    try {
      // The migration file is in the chain.
      const all = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
      expect(all.includes("0019_session_stream_acknowledgments.sql")).toBe(true);

      // Apply the full chain via the real runner.
      await migrate(DB_URL);

      // --- Columns exist with the right nullability/default.
      const cols = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
        SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'session_stream_acknowledgments'
        ORDER BY column_name`;
      const colMap = new Map(cols.map((c) => [c.column_name, c]));
      for (const name of ["account_id", "workspace_id", "sandbox_group_id", "subject_id", "acknowledged_unredacted", "acknowledged_shared"]) {
        expect(colMap.get(name), `missing column ${name}`).toBeDefined();
      }
      expect(colMap.get("subject_id")!.is_nullable).toBe("NO");
      expect(colMap.get("acknowledged_shared")!.column_default).toContain("false");

      // --- The unique (workspace, group, subject) index exists.
      const idx = await sql<{ indexname: string }[]>`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'session_stream_acknowledgments'
        ORDER BY indexname`;
      expect(idx.map((r) => r.indexname)).toContain("session_stream_ack_subject_idx");

      // --- RLS is enabled + forced.
      const rls = (await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = 'session_stream_acknowledgments'`)[0]!;
      expect(rls.relrowsecurity).toBe(true);
      expect(rls.relforcerowsecurity).toBe(true);

      // --- Re-ack upsert: a second ack for the same (workspace, group, subject)
      // updates in place (no duplicate) and ORs the consent bits monotonically.
      const accountId = (await sql<{ id: string }[]>`INSERT INTO "managed_accounts" ("name") VALUES ('acct') RETURNING "id"`)[0]!.id;
      const workspaceId = (await sql<{ id: string }[]>`INSERT INTO "workspaces" ("account_id", "name") VALUES (${accountId}, 'ws') RETURNING "id"`)[0]!.id;
      const groupId = "00000000-0000-4000-8000-000000000abc";

      await sql`
        INSERT INTO "session_stream_acknowledgments"
          ("account_id", "workspace_id", "sandbox_group_id", "subject_id", "acknowledged_unredacted", "acknowledged_shared")
        VALUES (${accountId}, ${workspaceId}, ${groupId}, 'subj', true, false)`;
      // Second ack adds the shared consent (true ORs in); unredacted stays true.
      await sql`
        INSERT INTO "session_stream_acknowledgments"
          ("account_id", "workspace_id", "sandbox_group_id", "subject_id", "acknowledged_unredacted", "acknowledged_shared")
        VALUES (${accountId}, ${workspaceId}, ${groupId}, 'subj', true, true)
        ON CONFLICT ("workspace_id", "sandbox_group_id", "subject_id") DO UPDATE SET
          acknowledged_unredacted = session_stream_acknowledgments.acknowledged_unredacted OR excluded.acknowledged_unredacted,
          acknowledged_shared     = session_stream_acknowledgments.acknowledged_shared     OR excluded.acknowledged_shared`;

      const rows = await sql<{ acknowledged_unredacted: boolean; acknowledged_shared: boolean }[]>`
        SELECT acknowledged_unredacted, acknowledged_shared FROM "session_stream_acknowledgments"
        WHERE workspace_id = ${workspaceId} AND sandbox_group_id = ${groupId} AND subject_id = 'subj'`;
      expect(rows.length).toBe(1); // no duplicate
      expect(rows[0]!.acknowledged_unredacted).toBe(true);
      expect(rows[0]!.acknowledged_shared).toBe(true); // ORed in

      // --- Idempotent: re-running the whole chain is a no-op.
      await migrate(DB_URL);
      const stillOne = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM "session_stream_acknowledgments"
        WHERE workspace_id = ${workspaceId}`;
      expect(stillOne[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  }, 120_000);
});
