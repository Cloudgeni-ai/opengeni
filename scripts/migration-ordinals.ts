/**
 * Shared helpers for the migration ordinal tooling.
 *
 * Migrations under `packages/db/drizzle` are linearly ordered by a four-digit
 * ordinal prefix (`0271_scheduled_connection_authority.sql`) and the release
 * schema contract pins per-migration and cumulative chain hashes. Two branches
 * that each take the next free ordinal therefore collide the moment the first
 * one merges; the loser must move to the next free ordinal and re-fence every
 * literal that named the old one. These helpers make that mechanical:
 *
 * - `planRenumber` computes the exact file renames and text substitutions;
 * - `findOrdinalCollisions` reports head migrations whose ordinal is already
 *   taken on the base by a different migration (the CI guard);
 * - the release contract hash pins are refreshed by re-running the contract
 *   test and substituting only exact SHA-256 mismatches (`renumber-migration.ts`).
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

export const MIGRATIONS_DIR = "packages/db/drizzle";
export const MIGRATION_TESTS_DIR = "packages/db/test";
export const RELEASE_CONTRACT_TEST = "scripts/release-schema-contract.test.ts";

const MIGRATION_FILE = /^(\d{4})_([A-Za-z0-9_]+)\.sql$/;

export type MigrationName = {
  /** `0271` */
  ordinal: string;
  /** `scheduled_connection_authority` */
  slug: string;
  /** `0271_scheduled_connection_authority` */
  basename: string;
  /** `0271_scheduled_connection_authority.sql` */
  file: string;
};

export function parseMigrationFile(file: string): MigrationName | null {
  const match = MIGRATION_FILE.exec(basename(file));
  if (!match) return null;
  const [, ordinal, slug] = match;
  return { ordinal: ordinal!, slug: slug!, basename: `${ordinal}_${slug}`, file: match[0] };
}

export function formatOrdinal(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 9999) {
    throw new Error(`migration ordinal out of range: ${value}`);
  }
  return String(value).padStart(4, "0");
}

export function listMigrationFiles(root: string): MigrationName[] {
  return readdirSync(join(root, MIGRATIONS_DIR))
    .map(parseMigrationFile)
    .filter((entry): entry is MigrationName => entry !== null)
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
}

/** Parses `git ls-tree --name-only <ref> -- packages/db/drizzle/` output. */
export function parseLsTree(output: string): MigrationName[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseMigrationFile)
    .filter((entry): entry is MigrationName => entry !== null)
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
}

export function nextFreeOrdinal(...ledgers: readonly (readonly MigrationName[])[]): string {
  let highest = -1;
  for (const ledger of ledgers) {
    for (const migration of ledger) highest = Math.max(highest, Number(migration.ordinal));
  }
  return formatOrdinal(highest + 1);
}

/**
 * Resolves a CLI selector (`0271`, `0271_slug`, `0271_slug.sql`, or a path)
 * to exactly one local migration.
 */
export function resolveMigration(local: readonly MigrationName[], selector: string): MigrationName {
  const trimmed = basename(selector.trim());
  const candidates = local.filter(
    (migration) =>
      migration.ordinal === trimmed || migration.basename === trimmed || migration.file === trimmed,
  );
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length === 0) {
    throw new Error(`no migration matches "${selector}" under ${MIGRATIONS_DIR}`);
  }
  throw new Error(
    `"${selector}" is ambiguous: ${candidates.map((migration) => migration.file).join(", ")}`,
  );
}

export type OrdinalCollision = {
  headFile: string;
  baseFile: string;
  ordinal: string;
};

/**
 * Head migrations that are absent from the base ledger but reuse an ordinal the
 * base already assigned to a different migration. Identical files (same name on
 * both sides) are not collisions. The historical ledger already contains
 * duplicate ordinals (the migrator orders by full file name), so only
 * duplicates among the migrations this head adds are reported.
 */
export function findOrdinalCollisions(
  head: readonly MigrationName[],
  base: readonly MigrationName[],
): { collisions: OrdinalCollision[]; duplicates: string[][] } {
  const baseByOrdinal = new Map<string, MigrationName>();
  const baseFiles = new Set(base.map((migration) => migration.file));
  for (const migration of base) baseByOrdinal.set(migration.ordinal, migration);
  const collisions: OrdinalCollision[] = [];
  for (const migration of head) {
    if (baseFiles.has(migration.file)) continue;
    const taken = baseByOrdinal.get(migration.ordinal);
    if (taken && taken.file !== migration.file) {
      collisions.push({
        headFile: migration.file,
        baseFile: taken.file,
        ordinal: migration.ordinal,
      });
    }
  }
  const byOrdinal = new Map<string, string[]>();
  for (const migration of head) {
    if (baseFiles.has(migration.file)) continue;
    const bucket = byOrdinal.get(migration.ordinal) ?? [];
    bucket.push(migration.file);
    byOrdinal.set(migration.ordinal, bucket);
  }
  const duplicates = [...byOrdinal.values()].filter((files) => files.length > 1);
  return { collisions, duplicates };
}

export type RenumberRename = { from: string; to: string };
export type RenumberEdit = { path: string; replacements: number; bareOrdinal: number };
export type RenumberPlan = {
  from: MigrationName;
  to: MigrationName;
  renames: RenumberRename[];
  edits: RenumberEdit[];
  contents: Map<string, string>;
  /**
   * Files that mention the old ordinal bare but reference neither the basename
   * nor a companion test, so the tool cannot tell whether the digits name this
   * migration or another one sharing them. Reported for human review; pass them
   * through `alsoBare` to rewrite.
   */
  unrewrittenBare: string[];
};

/**
 * Companion tests carry the ordinal prefix (`migration-NNNN-*.test.ts`) but
 * their slug often diverges from the SQL slug, and the ledger contains duplicate
 * ordinals (and a merged base may bring another `NNNN_*.sql` beside ours), so
 * the prefix alone is not enough. A candidate is a companion only when it
 * either references this migration's file/basename in its text or its
 * hyphenated slug equals the SQL slug, and it never references a different
 * local migration with the same ordinal.
 */
export function companionTestFiles(
  root: string,
  migration: MigrationName,
  siblingsWithSameOrdinal: readonly MigrationName[] = [],
): string[] {
  const prefix = `migration-${migration.ordinal}-`;
  const hyphenSlug = migration.slug.replace(/_/g, "-");
  const others = siblingsWithSameOrdinal.filter((sibling) => sibling.file !== migration.file);
  return readdirSync(join(root, MIGRATION_TESTS_DIR))
    .filter((file) => file.startsWith(prefix) && file.endsWith(".test.ts"))
    .filter((file) => {
      const text = readFileSync(join(root, MIGRATION_TESTS_DIR, file), "utf8");
      if (others.some((other) => text.includes(other.basename))) return false;
      return text.includes(migration.basename) || file === `${prefix}${hyphenSlug}.test.ts`;
    })
    .sort()
    .map((file) => `${MIGRATION_TESTS_DIR}/${file}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites one file's text for a renumber. Returns the new text and counts.
 *
 * - The basename (`0271_scheduled_connection_authority`) is rewritten wherever
 *   it appears; this covers `.sql` references, ledger stamps and hash pins.
 * - The hyphenated companion-test slug (`migration-0271-...`) is rewritten only
 *   for the exact companion test files, so another migration's test that merely
 *   shares the digits is untouched.
 * - A bare ordinal (`0271` not adjacent to `_`, `-`, digits, or letters) or an
 *   ordinal boundary literal (`"0271_"`) is
 *   rewritten only when `bareOrdinal` is set: the migration's own text, its
 *   companion tests, and files that already reference the basename (docs,
 *   changesets), where the digits name this migration and nothing else. Other
 *   migrations sharing the digits (`0271_company_brain...`,
 *   `migration-0271-retrieval-only-default.test.ts`) are excluded by the
 *   adjacency rule.
 */
export function rewriteText(
  text: string,
  from: MigrationName,
  to: MigrationName,
  companionTestNames: readonly string[],
  options: { bareOrdinal: boolean },
): { text: string; replacements: number; bareOrdinal: number } {
  let replacements = 0;
  let bareOrdinal = 0;
  let next = text.replace(new RegExp(`${escapeRegExp(from.basename)}(?![A-Za-z0-9_])`, "g"), () => {
    replacements += 1;
    return to.basename;
  });
  for (const companion of companionTestNames) {
    const renamed = companion.replace(`migration-${from.ordinal}-`, `migration-${to.ordinal}-`);
    // Match with or without the `.test.ts` suffix and the `migration-` prefix
    // (tests are cited by full file name, by import specifier, or by slug).
    const stem = companion.replace(/\.test\.ts$/, "");
    const renamedStem = renamed.replace(/\.test\.ts$/, "");
    next = next.replace(new RegExp(`${escapeRegExp(stem)}(?![A-Za-z0-9-])`, "g"), () => {
      replacements += 1;
      return renamedStem;
    });
  }
  if (options.bareOrdinal) {
    next = next.replace(new RegExp(`(?<![\\w-])${from.ordinal}(?![\\w-])`, "g"), () => {
      bareOrdinal += 1;
      return to.ordinal;
    });
    // An ordinal boundary literal such as `file < "0271_"` (ledger replay
    // filters) names this migration's position, not another migration's
    // basename, which always continues with a slug character.
    next = next.replace(new RegExp(`(?<![\\w-])${from.ordinal}_(?![A-Za-z0-9])`, "g"), () => {
      bareOrdinal += 1;
      return `${to.ordinal}_`;
    });
  }
  return { text: next, replacements, bareOrdinal };
}

const BINARY_OR_GENERATED =
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|otf|wasm|zip|gz|lockb|lock)$/i;

export function isRewritableTextPath(path: string): boolean {
  if (path.startsWith("node_modules/") || path.includes("/node_modules/")) return false;
  if (path.startsWith(".git/")) return false;
  if (BINARY_OR_GENERATED.test(path)) return false;
  return true;
}

/**
 * Computes the complete renumber plan against an in-memory view of the repo.
 * `files` maps repo-relative paths to their current text; callers pass every
 * tracked and untracked text file so untracked WIP is renamed too.
 */
export function planRenumber(input: {
  from: MigrationName;
  toOrdinal: string;
  files: ReadonlyMap<string, string>;
  companionTests: readonly string[];
  /** Extra paths whose bare ordinal mentions name this migration (docs, changesets). */
  alsoBare?: readonly string[];
}): RenumberPlan {
  const to: MigrationName = {
    ordinal: input.toOrdinal,
    slug: input.from.slug,
    basename: `${input.toOrdinal}_${input.from.slug}`,
    file: `${input.toOrdinal}_${input.from.slug}.sql`,
  };
  const renames: RenumberRename[] = [
    { from: `${MIGRATIONS_DIR}/${input.from.file}`, to: `${MIGRATIONS_DIR}/${to.file}` },
  ];
  const companionNames = input.companionTests.map((path) => basename(path));
  for (const path of input.companionTests) {
    const name = basename(path);
    renames.push({
      from: path,
      to: `${MIGRATION_TESTS_DIR}/${name.replace(`migration-${input.from.ordinal}-`, `migration-${to.ordinal}-`)}`,
    });
  }
  const renamedPaths = new Map(renames.map((rename) => [rename.from, rename.to]));
  const ownText = new Set(renames.map((rename) => rename.from));
  const alsoBare = new Set(input.alsoBare ?? []);
  const edits: RenumberEdit[] = [];
  const contents = new Map<string, string>();
  const unrewrittenBare: string[] = [];
  const barePattern = new RegExp(`(?<![\\w-])${input.from.ordinal}(?![\\w-])`);
  for (const [path, text] of input.files) {
    if (!isRewritableTextPath(path)) continue;
    const referencesBasename =
      text.includes(input.from.basename) ||
      companionNames.some((name) => text.includes(name.replace(/\.test\.ts$/, "")));
    const bare = ownText.has(path) || referencesBasename || alsoBare.has(path);
    const result = rewriteText(text, input.from, to, companionNames, { bareOrdinal: bare });
    if (!bare && barePattern.test(text)) unrewrittenBare.push(path);
    if (result.text === text) continue;
    const target = renamedPaths.get(path) ?? path;
    edits.push({
      path: target,
      replacements: result.replacements,
      bareOrdinal: result.bareOrdinal,
    });
    contents.set(target, result.text);
  }
  edits.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  unrewrittenBare.sort();
  return { from: input.from, to, renames, edits, contents, unrewrittenBare };
}

const SHA256 = /"([0-9a-f]{64})"/;

/**
 * Parses one `bun test` failure of the release contract into an exact hash
 * substitution. Only a `"<sha256>"` Expected/Received pair qualifies; anything
 * else means the contract broke for a real reason and must not be auto-pinned.
 */
export function parseHashMismatch(output: string): { expected: string; received: string } | null {
  // Pairs must be adjacent within one failure block so a multi-failure run can
  // never pair an Expected from one block with a Received from another.
  const pair = /Expected: *"([0-9a-f]{64})"\s*\n\s*Received: *"([0-9a-f]{64})"/.exec(output);
  if (pair) return { expected: pair[1]!, received: pair[2]! };
  const objectPair =
    /Expected: *\{[^}]*sha256: *"([0-9a-f]{64})"[^}]*\}\s*\n\s*Received: *\{[^}]*sha256: *"([0-9a-f]{64})"/.exec(
      output,
    );
  if (objectPair) return { expected: objectPair[1]!, received: objectPair[2]! };
  // `toMatchObject` prints a unified diff: `-   "sha256": "<expected>",` then
  // (possibly after other `+` lines) `+   "sha256": "<received>",`.
  const diffPair =
    /^- +"sha256": *"([0-9a-f]{64})"[^\n]*\n(?:\+[^\n]*\n)*?\+ +"sha256": *"([0-9a-f]{64})"/m.exec(
      output,
    );
  if (diffPair) return { expected: diffPair[1]!, received: diffPair[2]! };
  return null;
}

export function isSha256(value: string): boolean {
  return SHA256.test(`"${value}"`);
}
