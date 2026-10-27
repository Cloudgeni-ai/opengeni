import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing/shared-pg";
import postgres from "postgres";
import { migrationDeploymentMode, planMigrations } from "../src/migrate";
import { BASELINE_MIGRATIONS, SQUASHED_MIGRATIONS } from "../src/migration-baseline";

let blank: BlankTestDatabase;
let shipped: string[];
beforeAll(async () => {
  const acquired = await acquireBlankTestDatabase("migrate-plan");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  blank = acquired;
  shipped = (await readdir(join(import.meta.dir, "../drizzle")))
    .filter((file) => file.endsWith(".sql"))
    .sort();
}, 180_000);
afterAll(async () => await blank?.release(), 60_000);

async function recordApplied(schema: string, names: readonly string[]) {
  const sql = postgres(blank.databaseUrl, { max: 1 });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await sql.unsafe(`DROP TABLE IF EXISTS "${schema}"."schema_migrations"`);
    await sql.unsafe(`CREATE TABLE "${schema}"."schema_migrations" (name text PRIMARY KEY)`);
    await sql`INSERT INTO ${sql(schema)}.schema_migrations ${sql(names.map((name) => ({ name })))}`;
  } finally {
    await sql.end();
  }
}

describe("migration plan", () => {
  test("classifies the first-line directive", () => {
    expect(migrationDeploymentMode("-- deployment-mode: rolling\nSELECT 1;")).toBe("rolling");
    expect(migrationDeploymentMode("-- deployment-mode: maintenance\r\nSELECT 1;")).toBe(
      "maintenance",
    );
    expect(migrationDeploymentMode("SELECT 1;")).toBe("unclassified");
  });

  test("a database with no migration table needs every shipped migration", async () => {
    const plan = await planMigrations(blank.databaseUrl, "plan_empty");
    expect(plan.pending.map((migration) => migration.name)).toEqual(shipped);
    expect(plan.pending.every((migration) => migration.deploymentMode === "rolling")).toBe(true);
    expect(plan.requiresDrain).toBe(false);
  });

  test("only rolling migrations pending means no drain", async () => {
    // The newest migration with no release-phase directive (a concurrent index,
    // for example, runs after the release instead).
    let pendingName: string | undefined;
    for (const name of [...shipped].reverse()) {
      const sql = await readFile(join(import.meta.dir, "../drizzle", name), "utf8");
      if (!/^-- opengeni:/m.test(sql)) {
        pendingName = name;
        break;
      }
    }
    const pending = pendingName!;
    await recordApplied(
      "plan_rolling",
      shipped.filter((name) => name !== pending),
    );
    const plan = await planMigrations(blank.databaseUrl, "plan_rolling");
    expect(plan).toEqual({
      phaseProtocol: 1,
      phases: { pre: [], maintenance: [pending], post: [] },
      pending: [{ name: pending, deploymentMode: "rolling" }],
      requiresDrain: false,
    });
  });

  test("a database that applied every squashed migration adopts the baseline", async () => {
    await recordApplied("plan_adopt", SQUASHED_MIGRATIONS);
    const plan = await planMigrations(blank.databaseUrl, "plan_adopt");
    expect(plan.pending.map((migration) => migration.name)).toEqual(
      shipped.filter((name) => !BASELINE_MIGRATIONS.includes(name)),
    );
  });

  test("a database that applied part of the squashed migrations is refused", async () => {
    await recordApplied("plan_partial", SQUASHED_MIGRATIONS.slice(0, -1));
    await expect(planMigrations(blank.databaseUrl, "plan_partial")).rejects.toThrow(
      "applied only part of migrations 0000-0977",
    );
  });

  test("an up-to-date database has nothing pending", async () => {
    await recordApplied("plan_current", shipped);
    expect(await planMigrations(blank.databaseUrl, "plan_current")).toEqual({
      phaseProtocol: 1,
      phases: { pre: [], maintenance: [], post: [] },
      pending: [],
      requiresDrain: false,
    });
  });
});
