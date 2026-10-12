#!/usr/bin/env bun
/**
 * Fail closed when a migration waits for an advisory lock after taking a table
 * lock it holds until commit.
 *
 *   bun scripts/check-migration-lock-order.ts
 *
 * Application transactions take advisory fences before row locks. A migration
 * that inverts that order deadlocks with them under load, and PostgreSQL then
 * aborts the application transactions caught in the cycle during the rollout.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MIGRATIONS_DIR,
  analyzeMigrationLockOrder,
  staleLockOrderAllowlistEntries,
  unreviewedLockOrderFindings,
} from "./migration-lock-order";

function main(): void {
  const migrationsDir = join(process.cwd(), MIGRATIONS_DIR);
  if (!existsSync(migrationsDir)) {
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  }
  const stale = staleLockOrderAllowlistEntries(migrationsDir);
  const violations = unreviewedLockOrderFindings(analyzeMigrationLockOrder(migrationsDir));
  if (stale.length > 0) {
    console.error(
      `GRANDFATHERED_LOCK_ORDER_MIGRATIONS in scripts/migration-lock-order.ts names ${stale.length} migration(s) that no longer exist:`,
    );
    for (const entry of stale) console.error(`  - ${entry}`);
  }
  if (violations.length > 0) {
    console.error(
      `${violations.length} migration(s) wait for an advisory lock after taking a table lock held until commit:`,
    );
    for (const finding of violations) {
      console.error(
        `  - ${finding.file}: statement ${finding.advisoryStatement} takes an advisory lock after ${finding.tableLock} in statement ${finding.tableLockStatement}`,
      );
    }
    console.error(
      "\nApplication transactions take advisory fences before row locks, so this order deadlocks with them under load.",
    );
    console.error(
      "Take every advisory fence before the first table lock, or rely on the table locks and take no fence:",
    );
    console.error(
      "a lock such as ALTER TABLE ... NO FORCE ROW LEVEL SECURITY already excludes every other reader and writer until commit.",
    );
    console.error(
      "If a fence-checking trigger fires on the migration's own write, disable it inside that window.",
    );
  }
  if (stale.length > 0 || violations.length > 0) process.exit(1);
  console.log("Migration lock order guard passed.");
}

main();
