import { expect } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "../../src/database";
import {
  evaluateRuntimeDatabasePosture,
  inspectRuntimeDatabasePosture,
  type RuntimeDatabasePostureOptions,
} from "../../src/runtime-posture";

const migrationsDirectory = join(import.meta.dir, "../../drizzle");
const MISSING_TABLES = /^(?:runtime privilege|protected) tables are missing: (.+)$/;

/** Public tables that migrations after `migration` create. */
async function tablesCreatedAfter(migration: string): Promise<Set<string>> {
  const later = (await readdir(migrationsDirectory)).filter(
    (name) => name.endsWith(".sql") && name > migration,
  );
  const tables = new Set<string>();
  for (const name of later) {
    const sql = await readFile(join(migrationsDirectory, name), "utf8");
    for (const match of sql.matchAll(/create table (?:if not exists )?(?:public\.)?"?(\w+)"?/giu)) {
      tables.add(match[1]!.toLowerCase());
    }
  }
  return tables;
}

/**
 * `assertRuntimeDatabasePosture` for a database whose migrations stop at
 * `migration` (a contraction test's predecessor, or that migration applied).
 * The current posture contract also names the tables later migrations create,
 * which such a database lacks by design, so only those may be reported
 * missing; any other violation fails as the full check would.
 */
export async function assertPrefixRuntimeDatabasePosture(
  db: Database,
  migration: string,
  options: RuntimeDatabasePostureOptions,
): Promise<void> {
  const violations = evaluateRuntimeDatabasePosture(
    await inspectRuntimeDatabasePosture(db, options),
    options,
  );
  if (violations.length === 0) return;
  const later = await tablesCreatedAfter(migration);
  const unexplained = violations.filter((violation) => {
    const missing = MISSING_TABLES.exec(violation);
    return !missing || missing[1]!.split(", ").some((table) => !later.has(table));
  });
  expect(unexplained).toEqual([]);
}
