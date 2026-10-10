import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireBlankTestDatabase, type BlankTestDatabase } from "@opengeni/testing";
import postgres from "postgres";
import { migrationDeploymentMode, planMigrations } from "../src/migrate";

const ROLLING = "0712_subscription_core_provider_keyed_reach.sql";
const MAINTENANCE = "0691_subscription_core_codex_disconnect.sql";

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

async function recordApplied(schema: string, except: string[]) {
  const sql = postgres(blank.databaseUrl, { max: 1 });
  try {
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await sql.unsafe(`DROP TABLE IF EXISTS "${schema}"."schema_migrations"`);
    await sql.unsafe(`CREATE TABLE "${schema}"."schema_migrations" (name text PRIMARY KEY)`);
    const names = shipped.filter((name) => !except.includes(name));
    await sql`INSERT INTO ${sql(schema)}.schema_migrations ${sql(names.map((name) => ({ name })))}`;
  } finally {
    await sql.end();
  }
}

describe("migration plan", () => {
  test("classifies the first-line directive", () => {
    expect(migrationDeploymentMode("0700_x.sql", "-- deployment-mode: rolling\nSELECT 1;")).toBe(
      "rolling",
    );
    expect(
      migrationDeploymentMode("0700_x.sql", "-- deployment-mode: maintenance\r\nSELECT 1;"),
    ).toBe("maintenance");
    expect(migrationDeploymentMode("0012_x.sql", "SELECT 1;")).toBe("historical");
    expect(migrationDeploymentMode("0700_x.sql", "SELECT 1;")).toBe("unclassified");
  });

  test("a database with no migration table needs every shipped migration and a drain", async () => {
    const plan = await planMigrations(blank.databaseUrl, "plan_empty");
    expect(plan.pending.map((migration) => migration.name)).toEqual(shipped);
    expect(plan.requiresDrain).toBe(true);
  });

  test("only rolling migrations pending means no drain", async () => {
    await recordApplied("plan_rolling", [ROLLING]);
    const plan = await planMigrations(blank.databaseUrl, "plan_rolling");
    expect(plan).toEqual({
      pending: [{ name: ROLLING, deploymentMode: "rolling" }],
      requiresDrain: false,
    });
  });

  test("a pending maintenance migration requires a drain", async () => {
    await recordApplied("plan_maintenance", [MAINTENANCE, ROLLING]);
    const plan = await planMigrations(blank.databaseUrl, "plan_maintenance");
    expect(plan).toEqual({
      pending: [
        { name: MAINTENANCE, deploymentMode: "maintenance" },
        { name: ROLLING, deploymentMode: "rolling" },
      ],
      requiresDrain: true,
    });
  });

  test("an up-to-date database has nothing pending", async () => {
    await recordApplied("plan_current", []);
    expect(await planMigrations(blank.databaseUrl, "plan_current")).toEqual({
      pending: [],
      requiresDrain: false,
    });
  });
});
