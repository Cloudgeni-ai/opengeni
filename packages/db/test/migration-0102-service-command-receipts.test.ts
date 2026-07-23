import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const migration = "0102_session_command_receipt_service_actor.sql";
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

function requiredId(row: { id: string } | undefined, message: string): string {
  if (row) return row.id;
  throw new Error(message);
}

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0102-service-command-receipts");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error("[migration-0102] real PostgreSQL harness is unavailable");
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("0102 service command receipt actors (real PostgreSQL)", () => {
  test("preserves existing receipts and admits only a named service subject", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const migrationFile of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, migrationFile), "utf8"));
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0102-account') returning id`;
      const accountId = requiredId(account, "failed to create migration test account");
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountId}, 'migration-0102-workspace') returning id`;
      const workspaceId = requiredId(workspace, "failed to create migration test workspace");

      await sql`
        insert into session_command_receipts (
          account_id, workspace_id, actor_type, actor_subject_id,
          action, operation_key, canonical_request_hash
        ) values (
          ${accountId}, ${workspaceId}, 'human', 'existing-human',
          'prompt.send', 'before-migration', 'existing-hash'
        )`;

      await sql.unsafe(await readFile(join(migrationsDir, migration), "utf8"));

      await sql`
        insert into session_command_receipts (
          account_id, workspace_id, actor_type, actor_subject_id,
          action, operation_key, canonical_request_hash
        ) values (
          ${accountId}, ${workspaceId}, 'service', 'external-scheduler',
          'prompt.send', 'after-migration', 'service-hash'
        )`;
      const [counts] = await sql<Array<{ humans: number; services: number }>>`
        select
          count(*) filter (where actor_type = 'human')::int as humans,
          count(*) filter (where actor_type = 'service')::int as services
        from session_command_receipts where workspace_id = ${workspaceId}`;
      expect(counts).toEqual({ humans: 1, services: 1 });

      let missingSubjectError: unknown;
      try {
        await sql`
          insert into session_command_receipts (
            account_id, workspace_id, actor_type,
            action, operation_key, canonical_request_hash
          ) values (
            ${accountId}, ${workspaceId}, 'service',
            'prompt.send', 'invalid-service', 'invalid-hash'
          )`;
      } catch (error) {
        missingSubjectError = error;
      }
      expect(missingSubjectError).toBeInstanceOf(Error);
      expect((missingSubjectError as { code?: string }).code).toBe("23514");
    } finally {
      await sql.end();
    }
  }, 180_000);
});
