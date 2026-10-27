#!/usr/bin/env bun
/**
 * Fail closed when this head edits, renames or deletes a migration its base
 * already ships.
 *
 *   bun scripts/check-migration-immutability.ts [--base <ref>]
 *
 * The migrator records each applied file by name and never runs it again, so
 * changing a shipped file's bytes silently forks fresh databases from upgraded
 * ones. A head may only add migrations. The comparison is against the merge
 * base with `origin/main` (fetched when missing), so migrations that main
 * gained after this branch forked are not reported as deletions.
 *
 * The one sanctioned deletion is the schema baseline's: a head that ships every
 * baseline part may delete exactly the files the baseline replaced.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { BASELINE_MIGRATIONS, SQUASHED_MIGRATIONS } from "../packages/db/src/migration-baseline";

export const MIGRATIONS_DIR = "packages/db/drizzle";

export type MigrationChange = { status: string; path: string };

/**
 * The shipped `.sql` migrations a `git diff --name-status --no-renames` output
 * changes, except deletions of `retired` file names.
 */
export function changedShippedMigrations(
  nameStatus: string,
  retired: ReadonlySet<string> = new Set(),
): MigrationChange[] {
  const changes: MigrationChange[] = [];
  for (const line of nameStatus.split("\n")) {
    const [status, path] = line.split("\t");
    if (!status || !path || !path.endsWith(".sql")) continue;
    if (!path.startsWith(`${MIGRATIONS_DIR}/`)) continue;
    if (status === "A") continue;
    if (status === "D" && retired.has(basename(path))) continue;
    changes.push({ status, path });
  }
  return changes;
}

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
  if ((await git(root, "rev-parse", "--verify", "--quiet", base)).code !== 0) {
    if (base !== "origin/main") throw new Error(`unknown base ref ${base}`);
    const fetched = await git(root, "fetch", "--no-tags", "--quiet", "origin", "main");
    if (fetched.code !== 0) throw new Error(`cannot fetch origin/main: ${fetched.stderr.trim()}`);
    base = "FETCH_HEAD";
  }
  const diff = await git(
    root,
    "diff",
    "--name-status",
    "--no-renames",
    `${base}...HEAD`,
    "--",
    `${MIGRATIONS_DIR}/`,
  );
  if (diff.code !== 0) throw new Error(`git diff against ${base} failed: ${diff.stderr.trim()}`);
  const shipsBaseline = BASELINE_MIGRATIONS.every((part) =>
    existsSync(join(root, MIGRATIONS_DIR, part)),
  );
  const changes = changedShippedMigrations(
    diff.stdout,
    new Set(shipsBaseline ? SQUASHED_MIGRATIONS : []),
  );
  if (changes.length === 0) {
    console.log(`[migration-immutability] ok: no shipped migration changed against ${base}`);
    return;
  }
  console.error(
    `[migration-immutability] ${changes.length} shipped migration(s) changed against ${base}; add a new migration instead:`,
  );
  for (const change of changes) console.error(`  ${change.status}  ${change.path}`);
  process.exit(1);
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
