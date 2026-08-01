import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migration = "0142_sandbox_archive_capture_gate.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");
const requireRealDatabase = process.env.OPENGENI_REQUIRE_REAL_DB === "1";

let blank: BlankTestDatabase | null = null;
let available = true;

beforeAll(async () => {
  blank = await acquireBlankTestDatabase("migration-0142");
  if (!blank) {
    if (requireRealDatabase) {
      throw new Error(
        "[migration-0142] OPENGENI_REQUIRE_REAL_DB=1 but the real PostgreSQL harness is unavailable",
      );
    }
    available = false;
  }
}, 180_000);

afterAll(async () => {
  await blank?.release();
});

describe("migration 0142 (durable sandbox archive-capture admission gate)", () => {
  test("requires maintenance and makes a capture generation immovable until exact release", async () => {
    if (!available || !blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1 });
    try {
      await sql.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migration) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const [account] = await sql<{ id: string }[]>`
        insert into managed_accounts (name) values ('migration-0142-account') returning id`;
      const accountId = account?.id;
      if (!accountId) throw new Error("Migration fixture account was not created");
      const [workspace] = await sql<{ id: string }[]>`
        insert into workspaces (account_id, name)
        values (${accountId}, 'migration-0142-workspace') returning id`;
      const workspaceId = workspace?.id;
      if (!workspaceId) throw new Error("Migration fixture workspace was not created");
      await sql`
        insert into workspace_inference_controls (workspace_id, account_id)
        values (${workspaceId}, ${accountId})`;
      const leaseId = crypto.randomUUID();
      await sql`
        insert into sandbox_leases (
          id, account_id, workspace_id, sandbox_group_id, liveness, refcount,
          turn_holders, viewer_holders, instance_id, backend, lease_epoch,
          workspace_generation, expires_at
        ) values (
          ${leaseId}, ${accountId}, ${workspaceId}, ${crypto.randomUUID()},
          'warm', 0, 0, 0, 'sb-migration-0142', 'modal', 4, 0,
          now() + interval '1 hour'
        )`;

      const migrationSql = await readFile(join(migrationsDir, migration), "utf8");
      expect(migrationSql.split(/\r?\n/, 1)[0]).toBe("-- deployment-mode: maintenance");
      expect(migrationSql.match(/opengeni_app sessions to be stopped/g)).toHaveLength(2);
      expect(migrationSql).toContain("LOCK TABLE sandbox_leases IN ACCESS EXCLUSIVE MODE");

      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      const liveApp = postgres(appUrl.toString(), { max: 1 });
      let liveWriterError: unknown;
      try {
        await liveApp`select 1`;
        await sql.unsafe(migrationSql);
      } catch (error) {
        liveWriterError = error;
      } finally {
        await liveApp.end();
      }
      expect((liveWriterError as { code?: string } | undefined)?.code).toBe("55000");
      const [rolledBack] = await sql<{ captureColumns: number }[]>`
        select count(*)::integer as "captureColumns"
        from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'sandbox_leases'
          and column_name like 'archive_capture_%'`;
      expect(rolledBack?.captureColumns).toBe(0);

      await sql.unsafe(migrationSql);
      const [shape] = await sql<
        Array<{ captureColumns: number; constraintPresent: boolean; indexPresent: boolean }>
      >`
        select
          (
            select count(*)::integer
            from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'sandbox_leases'
              and column_name like 'archive_capture_%'
          ) as "captureColumns",
          exists (
            select 1 from pg_constraint
            where conname = 'sandbox_leases_archive_capture_check'
          ) as "constraintPresent",
          to_regclass('sandbox_leases_archive_capture_deadline_idx') is not null
            as "indexPresent"`;
      expect(shape).toEqual({
        captureColumns: 4,
        constraintPresent: true,
        indexPresent: true,
      });

      const captureId = crypto.randomUUID();
      await sql`
        update sandbox_leases set
          archive_capture_id = ${captureId},
          archive_capture_generation = workspace_generation,
          archive_capture_started_at = now(),
          archive_capture_deadline_at = now() + interval '1 minute'
        where id = ${leaseId}`;

      let generationAdvanceError: unknown;
      try {
        await sql`
          update sandbox_leases
          set workspace_generation = workspace_generation + 1
          where id = ${leaseId}`;
      } catch (error) {
        generationAdvanceError = error;
      }
      expect((generationAdvanceError as { code?: string } | undefined)?.code).toBe("23514");

      let partialClaimError: unknown;
      try {
        await sql`
          update sandbox_leases
          set archive_capture_generation = null
          where id = ${leaseId}`;
      } catch (error) {
        partialClaimError = error;
      }
      expect((partialClaimError as { code?: string } | undefined)?.code).toBe("23514");

      await sql`
        update sandbox_leases set
          archive_capture_id = null,
          archive_capture_generation = null,
          archive_capture_started_at = null,
          archive_capture_deadline_at = null
        where id = ${leaseId}`;
      await sql`
        update sandbox_leases
        set workspace_generation = workspace_generation + 1
        where id = ${leaseId}`;
      const [released] = await sql<
        Array<{ workspaceGeneration: number; captureId: string | null }>
      >`
        select workspace_generation as "workspaceGeneration",
          archive_capture_id as "captureId"
        from sandbox_leases where id = ${leaseId}`;
      expect(released).toEqual({ workspaceGeneration: 1, captureId: null });
    } finally {
      await sql.end();
    }
  }, 180_000);
});
