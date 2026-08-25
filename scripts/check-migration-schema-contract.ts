#!/usr/bin/env bun
/**
 * Fail closed when a migration this head adds is not registered as a forward
 * addition in the release-schema contract test.
 *
 *   bun scripts/check-migration-schema-contract.ts [--base <ref>]
 *
 * An unregistered migration is framed by the governed checkpoint input, so the
 * pinned aggregate SHA-256 stops matching. Before this guard existed that
 * surfaced only after merge, as protected main going red: the author had instead
 * pinned a fresh ladder hash computed on their own branch, which was green there
 * and already stale once another migration merged first.
 *
 * The base defaults to `origin/main` and is fetched when missing, matching
 * `check-migration-ordinals.ts`. It is deliberately ONE ref, the branch this head
 * targets: a migration that exists only on `origin/production` genuinely is a new
 * addition to `main` when it is forward-ported, so treating any protected branch
 * as carrying it would be a silent hole.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  ContractParseError,
  MIGRATIONS_DIR,
  RELEASE_CONTRACT_TEST,
  type BaseLedger,
  listLedger,
  parseContractRegistration,
  parseLedgerPaths,
  readContractSource,
  declaredIdentifiers,
  registrationFixLines,
  unregisteredMigrations,
} from "./migration-schema-contract";

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
): Promise<BaseLedger | null> {
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
  return { ref, files: parseLedgerPaths(tree.stdout) };
}

async function main(): Promise<void> {
  const root = process.cwd();
  if (!existsSync(join(root, MIGRATIONS_DIR))) {
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  }
  if (!existsSync(join(root, RELEASE_CONTRACT_TEST))) {
    throw new Error(`run from the repository root (missing ${RELEASE_CONTRACT_TEST})`);
  }
  const baseIndex = process.argv.indexOf("--base");
  const primary =
    baseIndex >= 0
      ? process.argv[baseIndex + 1]
      : (process.env.OPENGENI_MIGRATION_BASE_REF ?? "origin/main");
  if (!primary) throw new Error("--base expects a git ref");

  const base: BaseLedger | null = await loadLedger(root, primary, true);
  if (!base) throw new Error(`cannot read ${MIGRATIONS_DIR} at ${primary}`);

  const source = readContractSource(root);
  const registration = parseContractRegistration(source);
  const head = listLedger(root);
  const violations = unregisteredMigrations(head, base, registration);
  if (violations.length === 0) {
    console.log(
      `[migration-schema-contract] ok: ${head.length} migrations, base ${base.ref}, ${registration.forward.length} forward additions`,
    );
    return;
  }

  const plural = violations.length === 1 ? "migration is" : "migrations are";
  console.error(
    `[migration-schema-contract] ${violations.length} new ${plural} not fully registered in ${RELEASE_CONTRACT_TEST} (base ${base.ref}):`,
  );
  for (const violation of violations) {
    console.error(`  - ${violation.file}  (missing: ${violation.missing.join(", ")})`);
  }
  console.error("");
  for (const line of registrationFixLines(violations, declaredIdentifiers(source))) {
    console.error(line);
  }
  process.exit(1);
}

await main().catch((error) => {
  if (error instanceof ContractParseError) {
    console.error(`[migration-schema-contract] ${error.message}`);
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
