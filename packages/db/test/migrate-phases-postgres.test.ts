import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrate, planMigrations, type MigrationPhaseResult } from "../src/migrate";
import type { MigrationPhase } from "../src/migration-phases";

// Real immutable migration files, with just their prerequisites in each schema.
const PRE = "0072_sessions_workspace_created_id_idx.sql";
const MAINTENANCE = "0456_social_connection_versions.sql";
const MIDDLE = "0506_background_command_text.sql";
const POST = "0812_session_events_usage_source_key_index.sql";
const pending = [PRE, MAINTENANCE, MIDDLE, POST];
let blank: BlankTestDatabase;
let shipped: string[];

beforeAll(async () => {
  const acquired = await acquireBlankTestDatabase("migrate-phases");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  blank = acquired;
  shipped = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql"))
    .sort();
}, 180_000);
afterAll(async () => await blank?.release(), 60_000);

async function fixture(schema: string) {
  const sql = postgres(blank.databaseUrl, { max: 1 });
  await sql.unsafe(`CREATE SCHEMA "${schema}"; SET search_path = "${schema}";
    CREATE TABLE schema_migrations (name text PRIMARY KEY);
    CREATE TABLE sessions (id int, workspace_id int, created_at timestamptz);
    CREATE TABLE social_connections (id int);
    CREATE TABLE session_background_commands (id int);
    CREATE TABLE session_events (id int, workspace_id int, turn_id int, usage_source_key text);
    CREATE TABLE nested_agent_depth_configuration (
      singleton boolean PRIMARY KEY, max_nested_agent_depth int, policy_source text, updated_at timestamptz);
  `);
  await sql`INSERT INTO schema_migrations ${sql(shipped.filter((name) => !pending.includes(name)).map((name) => ({ name })))}`;
  return sql;
}

async function run(
  schema: string,
  phase?: MigrationPhase,
  depth = 3,
): Promise<MigrationPhaseResult> {
  let result: MigrationPhaseResult | undefined;
  await migrate(blank.databaseUrl, schema, {
    ...(phase === undefined ? {} : { phase }),
    maxNestedAgentDepth: depth,
    onPhaseComplete: (value) => {
      result = value;
    },
  });
  expect(result?.schemaVersion).toBe("opengeni/migration-phase/v1");
  return result!;
}

describe("database-backed cumulative migration phases", () => {
  test("pre, maintenance and post recompute from committed receipts and re-run safely", async () => {
    const schema = "phase_sequence";
    const sql = await fixture(schema);
    try {
      expect((await planMigrations(blank.databaseUrl, schema)).phases).toEqual({
        pre: [PRE],
        maintenance: [MAINTENANCE, MIDDLE],
        post: [POST],
      });
      expect(await run(schema, "pre")).toMatchObject({
        phase: "pre",
        applied: [PRE],
        remaining: [MAINTENANCE, MIDDLE, POST],
      });
      expect(await run(schema, "pre", 7)).toMatchObject({
        applied: [],
        remaining: [MAINTENANCE, MIDDLE, POST],
      });
      expect(
        (await sql`SELECT max_nested_agent_depth FROM nested_agent_depth_configuration`)[0]
          ?.max_nested_agent_depth,
      ).toBe(7);
      expect(
        await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = ${schema}
        AND table_name = 'session_background_commands' AND column_name = 'command_text'`,
      ).toHaveLength(0);
      expect(await run(schema, "maintenance")).toMatchObject({
        applied: [MAINTENANCE, MIDDLE],
        remaining: [POST],
      });
      expect(
        await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = ${schema}
        AND table_name = 'session_background_commands' AND column_name = 'command_text'`,
      ).toHaveLength(1);
      expect(
        (await sql`SELECT to_regclass('session_events_usage_source_key_idx') AS index`)[0]?.index,
      ).toBeNull();
      expect((await planMigrations(blank.databaseUrl, schema)).phases).toEqual({
        pre: [],
        maintenance: [],
        post: [POST],
      });
      expect(await run(schema, "maintenance")).toMatchObject({ applied: [], remaining: [POST] });
      expect(await run(schema, "post")).toMatchObject({ applied: [POST], remaining: [] });
      expect(
        (await sql`SELECT to_regclass('session_events_usage_source_key_idx') AS index`)[0]?.index,
      ).not.toBeNull();
      expect(await run(schema, "post")).toMatchObject({ applied: [], remaining: [] });
      expect((await planMigrations(blank.databaseUrl, schema)).pending).toEqual([]);
    } finally {
      await sql.end();
    }
  }, 60_000);

  test("maintenance alone catches up pre; default and explicit post apply everything", async () => {
    for (const phase of ["maintenance", "post", undefined] as const) {
      const schema = `phase_direct_${phase ?? "default"}`;
      const sql = await fixture(schema);
      try {
        expect(await run(schema, phase)).toMatchObject({
          phase: phase ?? "post",
          applied: phase === "maintenance" ? [PRE, MAINTENANCE, MIDDLE] : pending,
          remaining: phase === "maintenance" ? [POST] : [],
        });
      } finally {
        await sql.end();
      }
    }
  }, 60_000);

  test("failure preserves earlier receipts, and a retry only applies the remaining prefix", async () => {
    const schema = "phase_retry";
    const sql = await fixture(schema);
    try {
      await sql`DROP TABLE social_connections`;
      await expect(run(schema, "maintenance")).rejects.toMatchObject({ code: "42P01" });
      expect(
        (await planMigrations(blank.databaseUrl, schema)).pending.map(({ name }) => name),
      ).toEqual([MAINTENANCE, MIDDLE, POST]);
      await sql`CREATE TABLE social_connections (id int)`;
      expect(await run(schema, "maintenance")).toMatchObject({
        applied: [MAINTENANCE, MIDDLE],
        remaining: [POST],
      });
    } finally {
      await sql.end();
    }
  }, 60_000);

  test("CLI keeps the success line and emits exactly one phase result; flag overrides env", async () => {
    const schema = "phase_cli";
    const sql = await fixture(schema);
    try {
      for (const expected of [
        { phase: "pre", applied: [PRE], remaining: [MAINTENANCE, MIDDLE, POST] },
        { phase: "maintenance", applied: [MAINTENANCE, MIDDLE], remaining: [POST] },
        { phase: "post", applied: [POST], remaining: [] },
        { phase: "post", applied: [], remaining: [] },
      ]) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            join(import.meta.dir, "../src/migrate.ts"),
            ...(expected.applied.length ? [`--phase=${expected.phase}`] : []),
          ],
          {
            env: {
              ...process.env,
              OPENGENI_MIGRATIONS_DATABASE_URL: blank.databaseUrl,
              OPENGENI_DB_SCHEMA: schema,
              OPENGENI_MIGRATION_PHASE: expected.applied.length ? "invalid" : "post",
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
        expect(
          stdout.split("\n").filter((line) => line === "Applied Drizzle SQL migrations."),
        ).toHaveLength(1);
        const reports = stdout
          .split("\n")
          .filter((line) => line.startsWith('{"schemaVersion":"opengeni/migration-phase/v1"'));
        expect(reports).toHaveLength(1);
        expect(JSON.parse(reports[0]!)).toEqual({
          schemaVersion: "opengeni/migration-phase/v1",
          ...expected,
        });
      }
    } finally {
      await sql.end();
    }
  }, 60_000);

  test("concurrent invocations partition only after acquiring the advisory lock", async () => {
    const schema = "phase_concurrent";
    const sql = await fixture(schema);
    try {
      // Exercise ordinary DDL under the existing lock. A concurrent-index
      // build can wait on the snapshot of a second advisory-lock waiter;
      // changing that pre-existing locking contract is outside phase selection.
      await sql`INSERT INTO schema_migrations (name) VALUES (${PRE})`;
      const results = await Promise.all([run(schema, "maintenance"), run(schema, "maintenance")]);
      expect(results.flatMap(({ applied }) => applied)).toEqual([MAINTENANCE, MIDDLE]);
      expect(results.map(({ applied }) => applied.length).sort()).toEqual([0, 2]);
      for (const result of results) expect(result.remaining).toEqual([POST]);
    } finally {
      await sql.end();
    }
  }, 60_000);

  test("an all-rolling release has no maintenance span", async () => {
    const schema = "phase_rolling";
    const sql = await fixture(schema);
    try {
      await sql`INSERT INTO schema_migrations (name) VALUES (${MAINTENANCE})`;
      expect((await planMigrations(blank.databaseUrl, schema)).phases).toEqual({
        pre: [PRE, MIDDLE],
        maintenance: [],
        post: [POST],
      });
      expect(await run(schema, "pre")).toMatchObject({ applied: [PRE, MIDDLE], remaining: [POST] });
      expect(await run(schema, "maintenance")).toMatchObject({ applied: [], remaining: [POST] });
    } finally {
      await sql.end();
    }
  }, 60_000);
});
