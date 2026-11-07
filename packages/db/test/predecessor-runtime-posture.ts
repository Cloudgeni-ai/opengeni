import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeDatabasePostureOptions } from "../src/runtime-posture";

const migrationsDirectory = join(import.meta.dir, "../drizzle");
const createTablePattern =
  /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)/gi;

function unquote(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1) : identifier.toLowerCase();
}

function publicTablesCreatedBy(sql: string): string[] {
  const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  const tables: string[] = [];
  for (const match of withoutComments.matchAll(createTablePattern)) {
    const parts = match[1]!.split(/\s*\.\s*/).map(unquote);
    const [schema, name] = parts.length === 2 ? parts : ["public", parts[0]!];
    if (schema === "public") tables.push(name!);
  }
  return tables;
}

function migrationFiles(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Public tables first created by migration files that sort after `boundary` (or at it, when
 * `inclusive`). A table some earlier file already creates is never included.
 */
export function publicTablesCreatedAfter(boundary: string, inclusive: boolean): string[] {
  const files = migrationFiles();
  if (!files.includes(boundary)) throw new Error(`unknown migration ${boundary}`);
  const earlier = new Set<string>();
  const later = new Set<string>();
  for (const file of files) {
    const isLater = inclusive ? file >= boundary : file > boundary;
    for (const table of publicTablesCreatedBy(
      readFileSync(join(migrationsDirectory, file), "utf8"),
    )) {
      if (isLater) {
        if (!earlier.has(table)) later.add(table);
      } else {
        earlier.add(table);
      }
    }
  }
  return [...later].sort();
}

/**
 * Current runtime contract for a database migrated up to, but not including, `migration`.
 * Only contract tables that `migration` or a later file creates may be absent; every table that
 * exists at that point is still checked.
 */
export function postureBeforeMigration(
  migration: string,
  options: RuntimeDatabasePostureOptions = { rlsStrategy: "force" },
): RuntimeDatabasePostureOptions {
  return { ...options, tablesCreatedByLaterMigrations: publicTablesCreatedAfter(migration, true) };
}

/** Current runtime contract for a database migrated up to and including `migration`. */
export function postureThroughMigration(
  migration: string,
  options: RuntimeDatabasePostureOptions = { rlsStrategy: "force" },
): RuntimeDatabasePostureOptions {
  return { ...options, tablesCreatedByLaterMigrations: publicTablesCreatedAfter(migration, false) };
}
