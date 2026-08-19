#!/usr/bin/env bun
/**
 * Fail closed when a migration on this head reuses an ordinal that a protected
 * base already assigned to a different migration, or when the local ledger
 * itself carries duplicate ordinals. Prints the exact renumber command.
 *
 *   bun scripts/check-migration-ordinals.ts [--base <ref>]
 *
 * The primary base defaults to `origin/main` (fetched when missing) because a
 * collision is a property of what protected main holds *now*, not of the
 * pull-request event base. When `origin/production` exists it is also checked,
 * so a hotfix into production cannot take an ordinal that main already assigned
 * to a different file (and the reverse). A red result here is a real conflict
 * signal, so the candidate must be renumbered (a source revision), never merely
 * rerun.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MIGRATIONS_DIR,
  findOrdinalCollisions,
  listMigrationFiles,
  nextFreeOrdinal,
  parseLsTree,
  type MigrationName,
} from "./migration-ordinals";

async function git(root: string, ...command: string[]) {
  const child = Bun.spawn(["git", ...command], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function loadLedger(
  root: string,
  ref: string,
  required: boolean,
): Promise<{ ref: string; files: MigrationName[] } | null> {
  let tree = await git(root, "ls-tree", "--name-only", ref, "--", `${MIGRATIONS_DIR}/`);
  if (tree.code !== 0 && (ref === "origin/main" || ref === "origin/production")) {
    const branch = ref === "origin/main" ? "main" : "production";
    const fetched = await git(root, "fetch", "--no-tags", "--quiet", "origin", branch);
    if (fetched.code === 0) {
      tree = await git(root, "ls-tree", "--name-only", "FETCH_HEAD", "--", `${MIGRATIONS_DIR}/`);
    }
  }
  if (tree.code !== 0) {
    if (!required) return null;
    throw new Error(`cannot read ${MIGRATIONS_DIR} at ${ref}: ${tree.stderr.trim()}`);
  }
  return { ref, files: parseLsTree(tree.stdout) };
}

async function main(): Promise<void> {
  const root = process.cwd();
  if (!existsSync(join(root, MIGRATIONS_DIR))) {
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  }
  const baseIndex = process.argv.indexOf("--base");
  const primary =
    baseIndex >= 0
      ? process.argv[baseIndex + 1]
      : (process.env.OPENGENI_MIGRATION_BASE_REF ?? "origin/main");
  if (!primary) throw new Error("--base expects a git ref");

  const ledgers: Array<{ ref: string; files: MigrationName[] }> = [];
  const loadedPrimary = await loadLedger(root, primary, true);
  if (!loadedPrimary) throw new Error(`cannot read ${MIGRATIONS_DIR} at ${primary}`);
  ledgers.push(loadedPrimary);
  if (primary !== "origin/main") {
    const main = await loadLedger(root, "origin/main", false);
    if (main) ledgers.push(main);
  }
  if (primary !== "origin/production") {
    const production = await loadLedger(root, "origin/production", false);
    if (production) ledgers.push(production);
  }

  const headLedger = listMigrationFiles(root);
  const collisions: Array<{ ref: string; ordinal: string; headFile: string; baseFile: string }> =
    [];
  const duplicates: string[][] = [];
  for (const ledger of ledgers) {
    const found = findOrdinalCollisions(headLedger, ledger.files);
    for (const collision of found.collisions) {
      collisions.push({ ref: ledger.ref, ...collision });
    }
    if (duplicates.length === 0) duplicates.push(...found.duplicates);
  }
  if (collisions.length === 0 && duplicates.length === 0) {
    const highest = nextFreeOrdinal(headLedger, ...ledgers.map((ledger) => ledger.files));
    console.log(
      `[migration-ordinals] ok: ${headLedger.length} migrations, bases ${ledgers.map((ledger) => ledger.ref).join(",")} next ${highest}`,
    );
    return;
  }
  const next = nextFreeOrdinal(headLedger, ...ledgers.map((ledger) => ledger.files));
  for (const collision of collisions) {
    console.error(
      `[migration-ordinals] ordinal ${collision.ordinal} of ${collision.headFile} is already used on ${collision.ref} by ${collision.baseFile}`,
    );
    console.error(
      `  fix: bun scripts/renumber-migration.ts ${collision.headFile.replace(/\.sql$/, "")} --next   (next free ordinal: ${next})`,
    );
  }
  for (const files of duplicates) {
    console.error(
      `[migration-ordinals] duplicate ordinal in ${MIGRATIONS_DIR}: ${files.join(", ")}`,
    );
  }
  process.exit(1);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
