/**
 * Forward-migration registrations for the release schema contract.
 *
 * A forward migration is excluded from the governed host-export checkpoint
 * input in `scripts/release-schema-contract.test.ts`, so the pinned aggregate
 * SHA-256 never has to move when one is added. Each one is registered by its
 * own file, `scripts/release-schema-forward-migrations/<NNNN_slug>.txt`,
 * containing exactly the migration file name (`<NNNN_slug>.sql`).
 *
 * One file per migration, rather than one shared inline list, is what lets
 * independent migration pull requests merge in any order: two of them add two
 * different files and never edit the same lines. The set is read and sorted
 * here, so neither file order nor directory listing order carries meaning.
 *
 * The contract test and the registration guard
 * (`scripts/check-migration-schema-contract.ts`) both read registrations
 * through this module, so they can never disagree about what is registered.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Repository-relative directory holding one registration file per forward migration. */
export const FORWARD_MIGRATIONS_DIR = "scripts/release-schema-forward-migrations";

/** Documentation for authors; the only entry in the directory that is not a registration. */
const README = "README.md";

const REGISTRATION_FILE = /^(\d{4}_[A-Za-z0-9_]+)\.txt$/;
const MIGRATION_FILE = /^(\d{4}_[A-Za-z0-9_]+)\.sql$/;

export class ForwardRegistrationError extends Error {}

export type ForwardRegistrationEntry = {
  name: string;
  isFile: boolean;
  /** File text; only read for regular files. */
  content?: string | undefined;
};

/** `0998_managed_auth_passkeys.sql` -> `scripts/release-schema-forward-migrations/0998_managed_auth_passkeys.txt`. */
export function forwardRegistrationPath(migrationFile: string): string {
  const match = MIGRATION_FILE.exec(migrationFile);
  if (!match) throw new ForwardRegistrationError(`not a migration file name: ${migrationFile}`);
  return `${FORWARD_MIGRATIONS_DIR}/${match[1]}.txt`;
}

/** The exact text of a registration file. */
export function forwardRegistrationContent(migrationFile: string): string {
  if (!MIGRATION_FILE.test(migrationFile)) {
    throw new ForwardRegistrationError(`not a migration file name: ${migrationFile}`);
  }
  return `${migrationFile}\n`;
}

/**
 * Validates directory entries and returns the registered migration file names,
 * sorted and unique. Fails closed on anything that is not a well-formed
 * registration, so a stray or mistyped file cannot silently register nothing.
 */
export function parseForwardRegistrations(entries: readonly ForwardRegistrationEntry[]): string[] {
  const registered = new Set<string>();
  for (const entry of entries) {
    if (entry.name === README && entry.isFile) continue;
    const match = REGISTRATION_FILE.exec(entry.name);
    if (!entry.isFile || !match) {
      throw new ForwardRegistrationError(
        `${FORWARD_MIGRATIONS_DIR}/${entry.name}: expected only <NNNN_slug>.txt registration files (and ${README})`,
      );
    }
    const migration = `${match[1]}.sql`;
    if ((entry.content ?? "").trim() !== migration) {
      throw new ForwardRegistrationError(
        `${FORWARD_MIGRATIONS_DIR}/${entry.name} must contain exactly ${migration}`,
      );
    }
    registered.add(migration);
  }
  return [...registered].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** Every registered forward migration, sorted by file name. */
export function readForwardMigrationRegistrations(root = join(import.meta.dir, "..")): string[] {
  const directory = join(root, FORWARD_MIGRATIONS_DIR);
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    throw new ForwardRegistrationError(
      `cannot read ${FORWARD_MIGRATIONS_DIR}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseForwardRegistrations(
    entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      content: entry.isFile() ? readFileSync(join(directory, entry.name), "utf8") : undefined,
    })),
  );
}
