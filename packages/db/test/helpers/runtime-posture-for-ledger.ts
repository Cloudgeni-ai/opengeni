import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type postgres from "postgres";
import type { Database } from "../../src/database";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  RuntimeDatabasePostureError,
  type RuntimeDatabasePostureOptions,
} from "../../src/runtime-posture";

const migrationsDirectory = join(import.meta.dir, "../../drizzle");
const createTable =
  /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const missingTables = /^(.* are missing: )(.+)$/;

/**
 * Assert the runtime posture of a test database migrated only part of the
 * way through the ledger (a test of one migration stops just before it).
 *
 * The current runtime contract grows with every table a later migration
 * creates, and those tables are absent from such a database by design. Only
 * they are exempt: every other violation, including a missing table any
 * applied migration created, still fails.
 */
export async function assertRuntimeDatabasePostureForLedger(
  db: Database,
  admin: postgres.Sql,
  options: RuntimeDatabasePostureOptions,
): Promise<void> {
  const applied = new Set(
    (await admin<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name),
  );
  const notYetCreated = new Set<string>();
  for (const name of readdirSync(migrationsDirectory)) {
    if (!name.endsWith(".sql") || applied.has(name)) continue;
    // Comments may mention tables a migration never creates.
    const statements = readFileSync(join(migrationsDirectory, name), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ");
    for (const match of statements.matchAll(createTable)) {
      notYetCreated.add(match[1]!.toLowerCase());
    }
  }
  const violations = evaluateRuntimeDatabasePosture(
    await inspectRuntimeDatabasePosture(db, options),
    options,
  ).flatMap((violation) => {
    const missing = missingTables.exec(violation);
    if (!missing) return [violation];
    const remaining = missing[2]!.split(", ").filter((table) => !notYetCreated.has(table));
    return remaining.length > 0 ? [`${missing[1]}${remaining.join(", ")}`] : [];
  });
  if (violations.length > 0) throw new RuntimeDatabasePostureError(violations);
}
