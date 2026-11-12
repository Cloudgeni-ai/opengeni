import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-migration runtime table posture for `runtime-posture.test.ts`.
 *
 * A migration that adds runtime tables describes them in its own file,
 * `runtime-posture-migrations/<slug>.ts`, named after the migration's slug
 * (its SQL file name without the ordinal and `.sql`). The frozen
 * privilege-class test adds every entry's counts to its expected class sizes,
 * so parallel migration PRs add separate files instead of appending to the
 * same lines of one test.
 *
 * The entry names its migration by basename (`1351_turn_timing_profiles`), so
 * `bun run migration:renumber` and the merge batcher rewrite it with the rest of
 * the PR when the ordinal moves; the file name has no ordinal and stays.
 */

/** How many new tables fall into each runtime privilege class. */
export interface RuntimePostureTableCounts {
  /** SELECT, INSERT, UPDATE and DELETE. */
  fullDml?: number;
  /** SELECT only. */
  readOnly?: number;
  /** SELECT and UPDATE. */
  readUpdate?: number;
  /** SELECT and INSERT. */
  readInsert?: number;
  /** SELECT, INSERT and UPDATE. */
  readInsertUpdate?: number;
  /** No direct runtime DML; reached only through owner routines. */
  protectedNoDml?: number;
}

export interface RuntimePostureMigration {
  /** The migration's SQL file name without `.sql`, like `1351_turn_timing_profiles`. */
  migration: string;
  /** New FORCE-RLS tables, by runtime privilege class. */
  forceRls?: RuntimePostureTableCounts;
  /** New tables without RLS, by runtime privilege class. */
  nonRls?: RuntimePostureTableCounts;
}

/** The class lists the privilege-class test sizes. */
export type RuntimePostureTableClass =
  | "forceRls"
  | "nonRls"
  | keyof RuntimePostureTableCounts
  /** Every class with runtime DML: all but `protectedNoDml`. */
  | "dml";

const PRIVILEGE_CLASSES = [
  "fullDml",
  "readOnly",
  "readUpdate",
  "readInsert",
  "readInsertUpdate",
  "protectedNoDml",
] as const satisfies readonly (keyof RuntimePostureTableCounts)[];

const ENTRY_DIRECTORY = join(import.meta.dir, "runtime-posture-migrations");
const MIGRATIONS_DIRECTORY = join(import.meta.dir, "../drizzle");

function sum(counts: RuntimePostureTableCounts | undefined, classes: readonly string[]): number {
  return classes.reduce(
    (total, name) => total + (counts?.[name as keyof RuntimePostureTableCounts] ?? 0),
    0,
  );
}

function validate(
  file: string,
  entry: RuntimePostureMigration | undefined,
): RuntimePostureMigration {
  const where = `runtime-posture-migrations/${file}`;
  if (!entry || typeof entry.migration !== "string")
    throw new Error(`${where} must default-export a RuntimePostureMigration`);
  const match = /^\d+_([a-z0-9_]+)$/u.exec(entry.migration);
  if (!match || `${match[1]}.ts` !== file)
    throw new Error(`${where} must be named after ${entry.migration}'s slug, as <slug>.ts`);
  if (!existsSync(join(MIGRATIONS_DIRECTORY, `${entry.migration}.sql`)))
    throw new Error(`${where} names ${entry.migration}, which has no SQL file`);
  for (const counts of [entry.forceRls, entry.nonRls])
    for (const [name, count] of Object.entries(counts ?? {}))
      if (
        !(PRIVILEGE_CLASSES as readonly string[]).includes(name) ||
        !Number.isInteger(count) ||
        count < 1
      )
        throw new Error(`${where} has an invalid table count ${name}: ${String(count)}`);
  if (sum(entry.forceRls, PRIVILEGE_CLASSES) + sum(entry.nonRls, PRIVILEGE_CLASSES) === 0)
    throw new Error(`${where} adds no tables`);
  return entry;
}

/** Every entry, in file-name order. */
export const RUNTIME_POSTURE_MIGRATIONS: readonly RuntimePostureMigration[] = await Promise.all(
  readdirSync(ENTRY_DIRECTORY)
    .sort()
    .map(async (file) => {
      if (!file.endsWith(".ts"))
        throw new Error(`runtime-posture-migrations/${file} is not a .ts entry`);
      const module = (await import(join(ENTRY_DIRECTORY, file))) as {
        default?: RuntimePostureMigration;
      };
      return validate(file, module.default);
    }),
);

/** How many tables the entries add to one class list. */
export function migrationTableCount(name: RuntimePostureTableClass): number {
  const dmlClasses = PRIVILEGE_CLASSES.filter((entry) => entry !== "protectedNoDml");
  return RUNTIME_POSTURE_MIGRATIONS.reduce((total, entry) => {
    if (name === "forceRls") return total + sum(entry.forceRls, PRIVILEGE_CLASSES);
    if (name === "nonRls") return total + sum(entry.nonRls, PRIVILEGE_CLASSES);
    const classes = name === "dml" ? dmlClasses : [name];
    return total + sum(entry.forceRls, classes) + sum(entry.nonRls, classes);
  }, 0);
}

/** How many tables the entries add in all: each is either FORCE-RLS or not. */
export function migrationTableTotal(): number {
  return migrationTableCount("forceRls") + migrationTableCount("nonRls");
}
