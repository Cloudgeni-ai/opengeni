import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeDatabasePostureOptions } from "../src/runtime-posture";

const migrationsDirectory = join(import.meta.dir, "../drizzle");
const createTablePattern =
  /\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?((?:"[^"]+"|[a-z_][a-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_][a-z0-9_$]*))?)/gi;
const createPrivateFunctionPattern =
  /\bcreate\s+(?:or\s+replace\s+)?function\s+"?opengeni_private"?\s*\.\s*("[^"]+"|[a-z_][a-z0-9_$]*)\s*\(/gi;
// Unqualified or public-qualified: the target schema's owner-internal helpers.
const createTargetFunctionPattern =
  /\bcreate\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\s*\.\s*)?("[^"]+"|[a-z_][a-z0-9_$]*)\s*\(/gi;

function unquote(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1) : identifier.toLowerCase();
}

function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function publicTablesCreatedBy(sql: string): string[] {
  const tables: string[] = [];
  for (const match of withoutComments(sql).matchAll(createTablePattern)) {
    const parts = match[1]!.split(/\s*\.\s*/).map(unquote);
    const [schema, name] = parts.length === 2 ? parts : ["public", parts[0]!];
    if (schema === "public") tables.push(name!);
  }
  return tables;
}

function privateFunctionsCreatedBy(sql: string): string[] {
  return [...withoutComments(sql).matchAll(createPrivateFunctionPattern)].map((match) =>
    unquote(match[1]!),
  );
}

function targetFunctionsCreatedBy(sql: string): string[] {
  return [...withoutComments(sql).matchAll(createTargetFunctionPattern)]
    .map((match) => unquote(match[1]!))
    .filter((name) => name !== "opengeni_private");
}

function migrationFiles(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Objects first created by migration files that sort after `boundary` (or at it, when
 * `inclusive`). An object some earlier file already creates is never included.
 */
function createdAfter(
  boundary: string,
  inclusive: boolean,
  createdBy: (sql: string) => string[],
): string[] {
  const files = migrationFiles();
  if (!files.includes(boundary)) throw new Error(`unknown migration ${boundary}`);
  const earlier = new Set<string>();
  const later = new Set<string>();
  for (const file of files) {
    const isLater = inclusive ? file >= boundary : file > boundary;
    for (const name of createdBy(readFileSync(join(migrationsDirectory, file), "utf8"))) {
      if (isLater) {
        if (!earlier.has(name)) later.add(name);
      } else {
        earlier.add(name);
      }
    }
  }
  return [...later].sort();
}

/** Public tables first created by migration files after `boundary` (or at it, when `inclusive`). */
export function publicTablesCreatedAfter(boundary: string, inclusive: boolean): string[] {
  return createdAfter(boundary, inclusive, publicTablesCreatedBy);
}

/**
 * `opengeni_private` functions (names without arguments) first created by migration files after
 * `boundary` (or at it, when `inclusive`).
 */
export function privateRoutinesCreatedAfter(boundary: string, inclusive: boolean): string[] {
  return createdAfter(boundary, inclusive, privateFunctionsCreatedBy);
}

/**
 * Target-schema functions (names without arguments) first created by migration files after
 * `boundary` (or at it, when `inclusive`).
 */
export function targetRoutinesCreatedAfter(boundary: string, inclusive: boolean): string[] {
  return createdAfter(boundary, inclusive, targetFunctionsCreatedBy);
}

/**
 * Current runtime contract for a database migrated up to, but not including, `migration`.
 * Only contract tables and runtime definers that `migration` or a later file creates may be
 * absent; every one that exists at that point is still checked.
 */
export function postureBeforeMigration(
  migration: string,
  options: RuntimeDatabasePostureOptions = { rlsStrategy: "force" },
): RuntimeDatabasePostureOptions {
  return {
    ...options,
    tablesCreatedByLaterMigrations: publicTablesCreatedAfter(migration, true),
    routinesCreatedByLaterMigrations: privateRoutinesCreatedAfter(migration, true),
    targetRoutinesCreatedByLaterMigrations: targetRoutinesCreatedAfter(migration, true),
  };
}

/** Current runtime contract for a database migrated up to and including `migration`. */
export function postureThroughMigration(
  migration: string,
  options: RuntimeDatabasePostureOptions = { rlsStrategy: "force" },
): RuntimeDatabasePostureOptions {
  return {
    ...options,
    tablesCreatedByLaterMigrations: publicTablesCreatedAfter(migration, false),
    routinesCreatedByLaterMigrations: privateRoutinesCreatedAfter(migration, false),
    targetRoutinesCreatedByLaterMigrations: targetRoutinesCreatedAfter(migration, false),
  };
}
