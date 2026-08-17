#!/usr/bin/env bun
/**
 * Move one migration to a new ordinal and re-fence everything that named it.
 *
 *   bun scripts/renumber-migration.ts <ordinal|basename> --next [--base origin/main]
 *   bun scripts/renumber-migration.ts <ordinal|basename> --to 0273
 *   bun scripts/renumber-migration.ts 0271 --next --dry-run
 *
 * The typical case: your branch added `NNNN_x.sql`, main merged another
 * `NNNN_y.sql` first. `--next` picks the first ordinal free on both the local
 * ledger and the base ref, renames the SQL and its `migration-NNNN-*.test.ts`
 * companions, rewrites every reference (tracked and untracked text files),
 * re-pins the release schema contract hashes, and formats touched files.
 * Nothing is committed; review `git status`/`git diff` and commit yourself.
 *
 * Migration content is never modified except for its own bare ordinal mentions
 * (drain messages, comments); the release contract's per-migration and chain
 * hash pins are re-pinned from the resulting bytes.
 */
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MIGRATIONS_DIR,
  RELEASE_CONTRACT_TEST,
  companionTestFiles,
  formatOrdinal,
  isRewritableTextPath,
  listMigrationFiles,
  nextFreeOrdinal,
  parseHashMismatch,
  parseLsTree,
  planRenumber,
  resolveMigration,
} from "./migration-ordinals";

type Args = {
  selector: string;
  to: string | null;
  next: boolean;
  base: string;
  dryRun: boolean;
  refreshContract: boolean;
  also: string[];
};

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    [
      "usage: bun scripts/renumber-migration.ts <ordinal|basename> (--next | --to NNNN)",
      "         [--base <ref>] [--dry-run] [--no-refresh-release-contract]",
      "",
      "  --next        first ordinal free on both the local ledger and --base (default origin/main)",
      "  --to NNNN     explicit target ordinal (must be free on both sides)",
      "  --dry-run     print the plan without renaming or writing",
      "  --also <path> also rewrite bare ordinal mentions in this file (repeatable); use it for",
      "                docs/changesets that name the migration by number only",
      "  --no-refresh-release-contract",
      "                skip re-pinning scripts/release-schema-contract.test.ts hashes",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    selector: "",
    to: null,
    next: false,
    base: process.env.OPENGENI_MIGRATION_BASE_REF ?? "origin/main",
    dryRun: false,
    refreshContract: true,
    also: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--next") args.next = true;
    else if (value === "--dry-run") args.dryRun = true;
    else if (value === "--no-refresh-release-contract") args.refreshContract = false;
    else if (value === "--to") {
      const target = argv[++index];
      if (!target || !/^\d{1,4}$/.test(target)) usage("--to expects a four-digit ordinal");
      args.to = formatOrdinal(Number(target));
    } else if (value === "--also") {
      const path = argv[++index];
      if (!path) usage("--also expects a path");
      args.also.push(path.replace(/^\.\//, ""));
    } else if (value === "--base") {
      const base = argv[++index];
      if (!base) usage("--base expects a git ref");
      args.base = base;
    } else if (value.startsWith("--")) usage(`unknown flag ${value}`);
    else if (!args.selector) args.selector = value;
    else usage(`unexpected argument ${value}`);
  }
  if (!args.selector) usage("missing migration selector");
  if (args.next === (args.to !== null)) usage("pass exactly one of --next or --to NNNN");
  return args;
}

async function git(
  root: string,
  ...command: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", ...command], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function baseLedger(root: string, base: string) {
  const tree = await git(root, "ls-tree", "--name-only", base, "--", `${MIGRATIONS_DIR}/`);
  if (tree.code !== 0) {
    throw new Error(
      `cannot read migrations at ${base} (${tree.stderr.trim()}); fetch it or pass --base`,
    );
  }
  return parseLsTree(tree.stdout);
}

async function repoTextFiles(root: string): Promise<Map<string, string>> {
  const tracked = await git(root, "ls-files", "-z");
  const untracked = await git(root, "ls-files", "-z", "--others", "--exclude-standard");
  if (tracked.code !== 0 || untracked.code !== 0) throw new Error("git ls-files failed");
  const paths = new Set(
    [...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(
      (path) => path && isRewritableTextPath(path),
    ),
  );
  const files = new Map<string, string>();
  for (const path of paths) {
    const absolute = join(root, path);
    if (!existsSync(absolute)) continue;
    const stat = await lstat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) continue; // symlinks, submodules, directories
    const bytes = await readFile(absolute);
    if (bytes.includes(0)) continue; // binary
    files.set(path, bytes.toString("utf8"));
  }
  return files;
}

async function runContractTest(root: string): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn(["bun", "test", "--timeout", "120000", RELEASE_CONTRACT_TEST], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  return { ok: code === 0, output: `${stdout}\n${stderr}` };
}

/**
 * Re-pins the contract test by re-running it and substituting only exact
 * SHA-256 Expected/Received pairs, one per iteration, until it is green.
 */
async function refreshReleaseContract(root: string): Promise<string[]> {
  const path = join(root, RELEASE_CONTRACT_TEST);
  const applied: string[] = [];
  for (let iteration = 0; iteration < 16; iteration += 1) {
    const result = await runContractTest(root);
    if (result.ok) return applied;
    const mismatch = parseHashMismatch(result.output);
    if (!mismatch) {
      throw new Error(
        `${RELEASE_CONTRACT_TEST} fails for a reason other than a hash pin; inspect it manually:\n${result.output.slice(-4000)}`,
      );
    }
    const text = await readFile(path, "utf8");
    if (!text.includes(mismatch.expected)) {
      throw new Error(
        `${RELEASE_CONTRACT_TEST} expects ${mismatch.expected} but that literal is not in the file`,
      );
    }
    await writeFile(path, text.split(mismatch.expected).join(mismatch.received));
    applied.push(`${mismatch.expected.slice(0, 12)}… -> ${mismatch.received.slice(0, 12)}…`);
  }
  throw new Error(`${RELEASE_CONTRACT_TEST} still red after 16 hash substitutions`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = process.cwd();
  if (!existsSync(join(root, MIGRATIONS_DIR))) {
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  }
  const local = listMigrationFiles(root);
  const from = resolveMigration(local, args.selector);
  const base = await baseLedger(root, args.base);
  const toOrdinal = args.next ? nextFreeOrdinal(local, base) : args.to!;
  const takenLocally = local.find(
    (migration) => migration.ordinal === toOrdinal && migration.file !== from.file,
  );
  const takenOnBase = base.find((migration) => migration.ordinal === toOrdinal);
  if (takenLocally)
    throw new Error(`ordinal ${toOrdinal} is already used locally by ${takenLocally.file}`);
  if (takenOnBase)
    throw new Error(`ordinal ${toOrdinal} is already used on ${args.base} by ${takenOnBase.file}`);
  if (toOrdinal === from.ordinal) throw new Error(`${from.file} already has ordinal ${toOrdinal}`);

  const companions = companionTestFiles(root, from.ordinal);
  const files = await repoTextFiles(root);
  const plan = planRenumber({
    from,
    toOrdinal,
    files,
    companionTests: companions,
    alsoBare: args.also,
  });

  console.log(`renumber ${plan.from.file} -> ${plan.to.file} (base ${args.base})`);
  for (const item of plan.renames) console.log(`  rename ${item.from} -> ${item.to}`);
  for (const edit of plan.edits) {
    console.log(
      `  edit   ${edit.path} (${edit.replacements} name reference${edit.replacements === 1 ? "" : "s"}${
        edit.bareOrdinal
          ? `, ${edit.bareOrdinal} bare ordinal${edit.bareOrdinal === 1 ? "" : "s"}`
          : ""
      })`,
    );
  }
  for (const path of plan.unrewrittenBare) {
    console.log(
      `  review ${path} mentions ${plan.from.ordinal} by number only; if it means this migration, rerun with --also ${path}`,
    );
  }
  if (args.dryRun) {
    console.log("dry run: nothing written");
    return;
  }

  for (const item of plan.renames) {
    const tracked = await git(root, "ls-files", "--error-unmatch", item.from);
    await mkdir(dirname(join(root, item.to)), { recursive: true });
    if (tracked.code === 0) {
      const moved = await git(root, "mv", item.from, item.to);
      if (moved.code !== 0) throw new Error(`git mv failed: ${moved.stderr.trim()}`);
    } else {
      await rename(join(root, item.from), join(root, item.to));
    }
  }
  for (const [path, text] of plan.contents) {
    await writeFile(join(root, path), text);
  }

  const touched = [...new Set([...plan.renames.map((r) => r.to), ...plan.contents.keys()])];
  if (args.refreshContract && existsSync(join(root, RELEASE_CONTRACT_TEST))) {
    const applied = await refreshReleaseContract(root);
    for (const line of applied) console.log(`  repin  ${RELEASE_CONTRACT_TEST} ${line}`);
    if (applied.length > 0) touched.push(RELEASE_CONTRACT_TEST);
  }
  const formatTargets = touched.filter((path) => /\.(ts|tsx|js|mjs|json|md)$/.test(path));
  if (formatTargets.length > 0) {
    const format = Bun.spawn(["bunx", "oxfmt", ...formatTargets], {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
    });
    if ((await format.exited) !== 0) {
      console.warn(`warning: oxfmt failed: ${await new Response(format.stderr).text()}`);
    }
  }
  console.log(
    `done: ${plan.renames.length} rename(s), ${plan.edits.length} edited file(s); review with git status / git diff`,
  );
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
