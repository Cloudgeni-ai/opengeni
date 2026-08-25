import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { acquireBlankTestDatabase, acquireSharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate } from "../src/migrate";

const migrationPath = new URL(
  "../drizzle/0257_goal_revision_decisions_and_root_constraints.sql",
  import.meta.url,
);
let shared: Awaited<ReturnType<typeof acquireSharedTestDatabase>>;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("migration-0257-goal-revision-authority");
}, 180_000);

afterAll(async () => {
  await shared?.release();
}, 60_000);

describe("0257 governed goal revision authority migration", () => {
  test("declares and documents the drained one-way protocol cutover", async () => {
    const source = await readFile(migrationPath, "utf8");
    expect(source.startsWith("-- deployment-mode: maintenance\n")).toBe(true);
    expect(source).toContain("opengeni.migration_application_roles");
    expect(source.match(/all configured OpenGeni application database sessions/g)).toHaveLength(2);
    expect(source).not.toContain("usename = 'opengeni_app'");
    expect(source).toContain('LOCK TABLE "session_goals" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain('LOCK TABLE "session_goal_revisions" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain('LOCK TABLE "session_turns" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain("never restart a pre-0257");
    expect(source).not.toContain('public."session_goals"');
  });

  test("requires explicit application roles for a fresh dedicated schema", async () => {
    const blank = await acquireBlankTestDatabase("migration-0257-dedicated-role-input");
    if (!blank) return;
    try {
      await expect(migrate(blank.databaseUrl, "goal_revision_scoped")).rejects.toThrow(
        "Migration 0257 requires the exact application database roles",
      );
    } finally {
      await blank.release();
    }
  }, 180_000);

  test("rejects an explicitly configured custom live role and succeeds only after drain", async () => {
    const blank = await acquireBlankTestDatabase("migration-0257-live-writer-guard");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    const role = `goal_runtime_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let liveRuntime: postgres.Sql | null = null;
    try {
      await sql.unsafe(`CREATE ROLE "${role}" LOGIN PASSWORD 'goal-runtime-password'`);
      const runtimeUrl = new URL(blank.databaseUrl);
      runtimeUrl.username = role;
      runtimeUrl.password = "goal-runtime-password";
      liveRuntime = postgres(runtimeUrl.toString(), { max: 1 });
      let guardError: unknown;
      try {
        await liveRuntime`select 1`;
        await migrate(blank.databaseUrl, undefined, {
          applicationDatabaseRoles: [role],
        });
      } catch (error) {
        guardError = error;
      }
      expect((guardError as { code?: string } | undefined)?.code).toBe("55000");

      const [rolledBack] = await sql<{ goalColumn: boolean; revisionColumn: boolean }[]>`
        select
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_goals'
              and column_name = 'root_constraints'
          ) as "goalColumn",
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_goal_revisions'
              and column_name = 'rollback_of_revision_id'
          ) as "revisionColumn"`;
      expect(rolledBack).toEqual({ goalColumn: false, revisionColumn: false });

      const [migrationReceipt] = await sql<{ applied: boolean }[]>`
        select exists (
          select 1 from schema_migrations
          where name = '0257_goal_revision_decisions_and_root_constraints.sql'
        ) as applied`;
      expect(migrationReceipt?.applied).toBe(false);

      await liveRuntime.end();
      liveRuntime = null;
      await migrate(blank.databaseUrl, undefined, {
        applicationDatabaseRoles: [role],
      });
      const [applied] = await sql<{ goalColumn: boolean; revisionColumn: boolean }[]>`
        select
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_goals'
              and column_name = 'root_constraints'
          ) as "goalColumn",
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_goal_revisions'
              and column_name = 'rollback_of_revision_id'
          ) as "revisionColumn"`;
      expect(applied).toEqual({ goalColumn: true, revisionColumn: true });
    } finally {
      await liveRuntime?.end();
      await sql.unsafe(`DROP ROLE IF EXISTS "${role}"`);
      await sql.end();
      await blank.release();
    }
  }, 240_000);

  test("shared schema exposes the new columns through the non-owner runtime connection", async () => {
    if (!shared) return;
    const app = postgres(shared.appUrl, { max: 1 });
    try {
      const [row] = await app<{ goalColumn: boolean; revisionColumn: boolean }[]>`
        select
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_goals'
              and column_name = 'root_constraints'
          ) as "goalColumn",
          exists (
            select 1 from information_schema.columns
            where table_schema = current_schema()
              and table_name = 'session_goal_revisions'
              and column_name = 'rollback_of_revision_id'
          ) as "revisionColumn"`;
      expect(row).toEqual({ goalColumn: true, revisionColumn: true });
    } finally {
      await app.end();
    }
  });
});
