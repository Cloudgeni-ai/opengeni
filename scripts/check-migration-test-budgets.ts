#!/usr/bin/env bun
/**
 * Fail closed when a test that replays the migration ledger has no explicit
 * timeout above the CI shard default.
 *
 *   bun scripts/check-migration-test-budgets.ts
 *
 * See scripts/migration-test-budgets.ts for why the budget is the protection:
 * shard packing is by source-file byte size, so these tests can be clustered and
 * slowed several-fold by any unrelated file addition.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { discoverTestFiles } from "./ci/workspace";

import {
  type BudgetViolation,
  budgetFixLines,
  budgetViolationsForFile,
} from "./migration-test-budgets";

function main(): void {
  const root = process.cwd();
  if (!existsSync(join(root, "packages"))) {
    throw new Error("run from the repository root (missing packages/)");
  }
  // Exactly the unit tier, resolved through the same helper CI shards with, so
  // the guard judges the files the unit shard runs under `--timeout=30000` and
  // never a `deploy/**` test it does not execute. (A bare local `bun run test`
  // discovers those too, at the same cap; none of them replays the ledger.)
  const files = discoverTestFiles(root).unit;
  const violations: BudgetViolation[] = [];
  let scanned = 0;
  for (const file of files) {
    const found = budgetViolationsForFile(join(root, file));
    if (found.length > 0) violations.push(...found.map((entry) => ({ ...entry, file })));
    scanned += 1;
  }
  if (violations.length === 0) {
    console.log(
      `[migration-test-budgets] ok: ${scanned} test files scanned, every ledger-replaying test carries an explicit budget`,
    );
    return;
  }
  const plural = violations.length === 1 ? "test replays" : "tests replay";
  console.error(
    `[migration-test-budgets] ${violations.length} ${plural} the migration ledger without a budget above the CI shard default:`,
  );
  for (const violation of violations) {
    const declared = violation.timeout === null ? "none" : `${violation.timeout} ms`;
    console.error(
      `  - ${violation.file}:${violation.line}  (${violation.kind}, budget: ${declared})`,
    );
  }
  console.error("");
  for (const line of budgetFixLines()) console.error(line);
  process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
