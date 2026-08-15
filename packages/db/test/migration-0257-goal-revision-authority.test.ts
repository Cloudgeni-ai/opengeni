import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireBlankTestDatabase, acquireSharedTestDatabase } from "@opengeni/testing";
import postgres from "postgres";

const migrationPath = new URL(
  "../drizzle/0257_goal_revision_decisions_and_root_constraints.sql",
  import.meta.url,
);
const migrationName = "0257_goal_revision_decisions_and_root_constraints.sql";
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../drizzle");

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
    expect(source.match(/all opengeni_app sessions to be stopped/g)).toHaveLength(2);
    expect(source).toContain('LOCK TABLE "session_goals" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain('LOCK TABLE "session_goal_revisions" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain('LOCK TABLE "session_turns" IN ACCESS EXCLUSIVE MODE');
    expect(source).toContain("never restart a pre-0257");
    expect(source).not.toContain('public."session_goals"');
  });

  test("rejects a live app role with SQLSTATE 55000 and rolls the cutover back", async () => {
    const blank = await acquireBlankTestDatabase("migration-0257-live-writer-guard");
    if (!blank) return;
    const sql = postgres(blank.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await sql.unsafe(`create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
      for (const file of files.filter((entry) => entry.localeCompare(migrationName) < 0)) {
        await sql.unsafe(await readFile(join(migrationsDir, file), "utf8"));
        await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
      }

      const source = await readFile(migrationPath, "utf8");
      const appUrl = new URL(blank.databaseUrl);
      appUrl.username = "opengeni_app";
      appUrl.password = "apppw";
      const liveApp = postgres(appUrl.toString(), { max: 1 });
      let guardError: unknown;
      try {
        await liveApp`select 1`;
        await sql.unsafe(source);
      } catch (error) {
        guardError = error;
      } finally {
        await liveApp.end();
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

      await sql.unsafe(source);
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
