#!/usr/bin/env bun
/**
 * Rolling migrations must keep the previous release working.
 *
 *   bun scripts/check-migration-previous-release.ts [--base <ref>]
 *
 * Judges every migration this head adds (against the merge base with
 * `origin/main`, fetched when missing) by the runtime posture the releases
 * that may still be serving during the rollout declare: the pinned production
 * baseline's `packages/db/src/runtime-posture.ts`, the merge base's (the newest
 * binary that may already be deployed) and every posture revision on main
 * between them, because staging and canaries can run any main commit. A
 * rolling migration may not revoke, drop or rename what any of them declares
 * it needs. See scripts/migration-previous-release.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDE_PATH } from "./migration-deployment-mode";
import {
  type PreviousReleaseContract,
  type PreviousReleaseFinding,
  REMOVAL_GOVERNED_FROM_ORDINAL,
  analyzeMigrationPreviousRelease,
  migrationDroppedTables,
  previousReleaseContract,
} from "./migration-previous-release";
import { loadRuntimePostureBaseline, readRuntimePostureBaseline } from "./runtime-posture-baseline";

const MIGRATIONS_DIR = "packages/db/drizzle";
const LEGACY_ROUTINES = "packages/db/src/runtime-posture-legacy-routines.json";
/** The files a release's runtime posture is read from. */
const POSTURE_SOURCES = [
  "packages/db/src/runtime-posture.ts",
  LEGACY_ROUTINES,
  "packages/db/src/role-relationships.ts",
];
const UNSHALLOW_HINT = "run `git fetch --unshallow origin` (the guard needs main's history)";

async function git(root: string, ...command: string[]) {
  const child = Bun.spawn(["git", ...command], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function resolveBase(root: string): Promise<string> {
  const baseIndex = process.argv.indexOf("--base");
  let base =
    baseIndex >= 0
      ? process.argv[baseIndex + 1]
      : (process.env.OPENGENI_MIGRATION_BASE_REF ?? "origin/main");
  if (!base) throw new Error("--base expects a git ref");
  if ((await git(root, "rev-parse", "--verify", "--quiet", `${base}^{commit}`)).code !== 0) {
    if (base !== "origin/main") throw new Error(`unknown base ref ${base}`);
    const fetched = await git(root, "fetch", "--no-tags", "--quiet", "origin", "main");
    if (fetched.code !== 0) throw new Error(`cannot fetch origin/main: ${fetched.stderr.trim()}`);
    base = "FETCH_HEAD";
  }
  const mergeBase = await git(root, "merge-base", base, "HEAD");
  if (mergeBase.code !== 0)
    throw new Error(
      `no merge base between ${base} and HEAD; in a shallow clone, ${UNSHALLOW_HINT}: ${mergeBase.stderr.trim()}`,
    );
  return mergeBase.stdout.trim();
}

/** Migrations present in the working tree that the merge base does not have. */
async function addedMigrations(root: string, base: string): Promise<string[]> {
  const listed = await git(root, "ls-tree", "--name-only", `${base}:${MIGRATIONS_DIR}`);
  if (listed.code !== 0)
    throw new Error(`cannot list ${MIGRATIONS_DIR} at ${base}: ${listed.stderr.trim()}`);
  const shipped = new Set(listed.stdout.split("\n").filter(Boolean));
  const tracked = await git(
    root,
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    MIGRATIONS_DIR,
  );
  if (tracked.code !== 0)
    throw new Error(`cannot list ${MIGRATIONS_DIR}: ${tracked.stderr.trim()}`);
  return [
    ...new Set(
      tracked.stdout
        .split("\n")
        .map((path) => path.slice(MIGRATIONS_DIR.length + 1))
        .filter((file) => /^\d{4}_[^/]*\.sql$/.test(file) && !shipped.has(file)),
    ),
  ]
    .filter((file) => existsSync(join(root, MIGRATIONS_DIR, file)))
    .sort();
}

async function ensureCommit(root: string, sha: string): Promise<void> {
  if ((await git(root, "cat-file", "-e", `${sha}^{commit}`)).code === 0) return;
  const fetched = await git(root, "fetch", "--no-tags", "--quiet", "--depth=1", "origin", sha);
  if (fetched.code !== 0)
    throw new Error(`cannot fetch previous-release source ${sha}: ${fetched.stderr.trim()}`);
}

/**
 * Every release that may serve while the added migrations run: the pin, the
 * merge base, and each commit between them that changed the posture sources
 * (any of them can be deployed to staging or a canary).
 */
async function servingReleases(root: string, base: string, pin: string) {
  await ensureCommit(root, pin);
  const sources = new Map([[pin, `the pinned production baseline ${pin.slice(0, 12)}`]]);
  if (!sources.has(base)) sources.set(base, `the main merge base ${base.slice(0, 12)}`);
  const fork = await git(root, "merge-base", pin, base);
  if (fork.code !== 0)
    throw new Error(
      `cannot relate the pinned baseline ${pin.slice(0, 12)} to ${base.slice(0, 12)}; ${UNSHALLOW_HINT}`,
    );
  if ((await git(root, "rev-parse", "--is-shallow-repository")).stdout.trim() === "true")
    throw new Error(
      `the checkout is shallow, so posture revisions may be missing; ${UNSHALLOW_HINT}`,
    );
  const log = await git(
    root,
    "log",
    "--format=%H",
    `${fork.stdout.trim()}..${base}`,
    "--",
    ...POSTURE_SOURCES,
  );
  if (log.code !== 0) throw new Error(`cannot list posture revisions: ${log.stderr.trim()}`);
  for (const sha of log.stdout.split("\n").filter(Boolean).reverse())
    if (!sources.has(sha)) sources.set(sha, `main ${sha.slice(0, 12)}`);
  return sources;
}

async function contractAt(
  root: string,
  sha: string,
  label: string,
): Promise<PreviousReleaseContract> {
  await ensureCommit(root, sha);
  const { module, cleanup } = await loadRuntimePostureBaseline(root, sha);
  try {
    const legacy = await git(root, "show", `${sha}:${LEGACY_ROUTINES}`);
    const source = await git(root, "show", `${sha}:${POSTURE_SOURCES[0]}`);
    if (source.code !== 0)
      throw new Error(`cannot read ${POSTURE_SOURCES[0]} at ${sha}: ${source.stderr.trim()}`);
    return previousReleaseContract(
      label,
      module as unknown as Record<string, unknown>,
      legacy.code === 0 ? JSON.parse(legacy.stdout) : null,
      source.stdout,
    );
  } finally {
    await cleanup();
  }
}

async function main(): Promise<void> {
  const root = process.cwd();
  if (!existsSync(join(root, MIGRATIONS_DIR)))
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  const base = await resolveBase(root);
  const added = await addedMigrations(root, base);
  if (added.length === 0) {
    console.log(`[migration-previous-release] ok: no migration added since ${base.slice(0, 12)}`);
    return;
  }
  const pin = (await readRuntimePostureBaseline(root)).sourceCommit;
  const sources = await servingReleases(root, base, pin);
  const contracts: PreviousReleaseContract[] = [];
  for (const [sha, label] of sources) contracts.push(await contractAt(root, sha, label));
  // The added migrations apply in order before the rollout, so a table an
  // earlier one drops is already gone when a later one runs.
  const findings: PreviousReleaseFinding[] = [];
  const dropped = new Set<string>();
  for (const file of added) {
    const sql = readFileSync(join(root, MIGRATIONS_DIR, file), "utf8");
    findings.push(
      ...analyzeMigrationPreviousRelease(
        file,
        sql,
        contracts,
        REMOVAL_GOVERNED_FROM_ORDINAL,
        new Set(dropped),
      ),
    );
    for (const table of migrationDroppedTables(sql)) dropped.add(table);
  }
  if (findings.length === 0) {
    console.log(
      `[migration-previous-release] ok: ${added.length} added migration(s) keep ${sources.size} release(s) ready (the pinned baseline ${pin.slice(0, 12)}, the merge base ${base.slice(0, 12)} and the posture revisions between them)`,
    );
    return;
  }
  console.error(
    `[migration-previous-release] ${findings.length} migration(s) would break a release that is still serving while they run:`,
  );
  for (const finding of findings)
    console.error(`  - ${MIGRATIONS_DIR}/${finding.file} (${finding.kind}): ${finding.detail}`);
  console.error(
    [
      "",
      "Rolling migrations run before the rollout, while the previous release serves. Remove what",
      "it needs only in the contract phase: release N stops needing it (for a definer, move it to",
      "DEFERRED_RUNTIME_PRIVATE_ROUTINES so readiness accepts it with or without EXECUTE), and a",
      "later migration revokes, drops or renames it once no release from the pinned production",
      "baseline to main still needs it.",
      `From ${String(REMOVAL_GOVERNED_FROM_ORDINAL).padStart(4, "0")}, other removals of existing objects need \`-- contract-step:\`.`,
      "",
      `Guide: ${GUIDE_PATH}`,
    ].join("\n"),
  );
  process.exit(1);
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
