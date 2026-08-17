#!/usr/bin/env bun
/**
 * Fail closed when a migration on this head reuses an ordinal that the base
 * branch already assigned to a different migration, or when the local ledger
 * itself carries duplicate ordinals. Prints the exact renumber command.
 *
 *   bun scripts/check-migration-ordinals.ts [--base <ref>]
 *
 * The base defaults to `origin/main` (fetched when missing) because a
 * collision is a property of what protected main holds *now*, not of the
 * pull-request event base. A red result here is a real conflict signal, so the
 * candidate must be renumbered (a source revision), never merely rerun.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MIGRATIONS_DIR,
  findOrdinalCollisions,
  listMigrationFiles,
  nextFreeOrdinal,
  parseLsTree,
} from "./migration-ordinals";

async function git(root: string, ...command: string[]) {
  const child = Bun.spawn(["git", ...command], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function main(): Promise<void> {
  const root = process.cwd();
  if (!existsSync(join(root, MIGRATIONS_DIR))) {
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  }
  const baseIndex = process.argv.indexOf("--base");
  let base =
    baseIndex >= 0
      ? process.argv[baseIndex + 1]
      : (process.env.OPENGENI_MIGRATION_BASE_REF ?? "origin/main");
  if (!base) throw new Error("--base expects a git ref");

  let tree = await git(root, "ls-tree", "--name-only", base, "--", `${MIGRATIONS_DIR}/`);
  if (tree.code !== 0 && base === "origin/main") {
    // Shallow or main-less checkouts: fetch protected main once, read-only.
    const fetched = await git(root, "fetch", "--no-tags", "--quiet", "origin", "main");
    if (fetched.code === 0) {
      base = "FETCH_HEAD";
      tree = await git(root, "ls-tree", "--name-only", base, "--", `${MIGRATIONS_DIR}/`);
    }
  }
  if (tree.code !== 0) {
    throw new Error(`cannot read ${MIGRATIONS_DIR} at ${base}: ${tree.stderr.trim()}`);
  }
  const baseLedger = parseLsTree(tree.stdout);
  const headLedger = listMigrationFiles(root);
  const { collisions, duplicates } = findOrdinalCollisions(headLedger, baseLedger);
  if (collisions.length === 0 && duplicates.length === 0) {
    console.log(
      `[migration-ordinals] ok: ${headLedger.length} migrations, base ${base} highest ${baseLedger.at(-1)?.ordinal ?? "none"}`,
    );
    return;
  }
  const next = nextFreeOrdinal(headLedger, baseLedger);
  for (const collision of collisions) {
    console.error(
      `[migration-ordinals] ordinal ${collision.ordinal} of ${collision.headFile} is already used on ${base} by ${collision.baseFile}`,
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
