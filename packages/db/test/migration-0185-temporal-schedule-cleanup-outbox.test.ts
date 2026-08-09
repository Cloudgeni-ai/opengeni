import { describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase } from "@opengeni/testing";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0185_temporal_schedule_cleanup_outbox.sql",
);

describe("migration 0185 Temporal schedule cleanup outbox", () => {
  test("is rolling, durable across workspace deletion, and exact-claim fenced", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: rolling");
    expect(migration).toContain('CREATE TABLE "temporal_schedule_cleanup_outbox"');
    expect(migration).toContain("FOR UPDATE SKIP LOCKED");
    expect(migration).toContain("SECURITY DEFINER");
    expect(migration).not.toMatch(/ACCESS\s+EXCLUSIVE/i);

    const blank = await acquireBlankTestDatabase("migration-0185");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await migrate(blank.databaseUrl);
      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0185-account') returning id`;
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${account!.id}, 'migration-0185-workspace') returning id`;
      const cleanupId = crypto.randomUUID();
      const scheduleId = `migration-0185-${crypto.randomUUID()}`;
      await sql`
        insert into temporal_schedule_cleanup_outbox (
          id, account_id, workspace_id, temporal_schedule_id
        ) values (${cleanupId}, ${account!.id}, ${workspace!.id}, ${scheduleId})`;
      await sql`delete from workspaces where id = ${workspace!.id}`;

      const claimId = crypto.randomUUID();
      const claims = await sql<
        Array<{ id: string; temporal_schedule_id: string; attempt_count: number }>
      >`
        select id, temporal_schedule_id, attempt_count
        from opengeni_private.claim_temporal_schedule_cleanups(${claimId}, 1, 15)`;
      expect([...claims]).toEqual([
        { id: cleanupId, temporal_schedule_id: scheduleId, attempt_count: 1 },
      ]);
      const [stale] = await sql<{ settled: boolean }[]>`
        select opengeni_private.settle_temporal_schedule_cleanup(
          ${cleanupId}, ${crypto.randomUUID()}, null
        ) as settled`;
      expect(stale?.settled).toBe(false);
      const [settled] = await sql<{ settled: boolean }[]>`
        select opengeni_private.settle_temporal_schedule_cleanup(
          ${cleanupId}, ${claimId}, null
        ) as settled`;
      expect(settled?.settled).toBe(true);
      const [remaining] = await sql<{ count: number }[]>`
        select count(*)::int as count
        from temporal_schedule_cleanup_outbox where id = ${cleanupId}`;
      expect(remaining?.count).toBe(0);
    } finally {
      await sql.end();
      await blank.release();
    }
  }, 180_000);
});
