#!/usr/bin/env bun
/**
 * Fail closed when a migration backfills a FORCE-RLS table without relaxing the
 * owner-only posture first (OPE-276).
 *
 *   bun scripts/check-migration-rls-backfills.ts
 *
 * `FORCE ROW LEVEL SECURITY` binds the table owner. OpenGeni migrates as a
 * NON-superuser owner without `BYPASSRLS`, and no tenant GUC is set during a
 * migration, so a bare `UPDATE`/`DELETE`/`INSERT ... SELECT`/`DO $$` backfill
 * over such a table matches ZERO rows and still reports success. The bug is
 * invisible in CI because the test harness migrates as a superuser.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  MIGRATIONS_DIR,
  analyzeMigrationRlsBackfills,
  staleAllowlistEntries,
  unreviewedFindings,
} from "./migration-rls-backfills";

function main(): void {
  const root = process.cwd();
  const migrationsDir = join(root, MIGRATIONS_DIR);
  if (!existsSync(migrationsDir)) {
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  }

  const stale = staleAllowlistEntries(migrationsDir);
  const violations = unreviewedFindings(analyzeMigrationRlsBackfills(migrationsDir));

  if (stale.length > 0) {
    console.error(
      `GRANDFATHERED_MIGRATIONS in scripts/migration-rls-backfills.ts names ${stale.length} migration(s) that no longer exist:`,
    );
    for (const entry of stale) console.error(`  - ${entry}`);
    console.error("Renamed a migration? Update the allowlist entry to the new file name.");
  }

  if (violations.length > 0) {
    const writes = violations.filter((violation) => violation.kind === "write").length;
    const guards = violations.length - writes;
    console.error(
      `${writes} backfill statement(s) and ${guards} preflight guard(s) touch a FORCE ROW LEVEL SECURITY table with no owner-visible window.`,
    );
    console.error(
      "Under OpenGeni's production migration principal (a NON-superuser owner without BYPASSRLS)",
    );
    console.error(
      "a backfill matches ZERO rows and reports success, and an `IF EXISTS ... RAISE EXCEPTION`",
    );
    console.error("preflight sees zero rows and certifies success. Wrap the statement:\n");
    console.error('  ALTER TABLE "<table>" NO FORCE ROW LEVEL SECURITY;');
    console.error("  -- ... the backfill ...");
    console.error('  ALTER TABLE "<table>" FORCE ROW LEVEL SECURITY;\n');
    console.error(
      "`NO FORCE` relaxes only the owner - the application role stays policy-bound - and the",
    );
    console.error(
      "runner executes each file in one implicit transaction, so a failure rolls both back.",
    );
    console.error(
      "Setting `opengeni.account_id` / `opengeni.workspace_id` around the statement also works.\n",
    );
    for (const violation of violations) {
      console.error(
        `  [${violation.kind}] ${violation.file} (statement ${violation.statement}) -> ${violation.tables.join(", ")}`,
      );
      console.error(`    ${violation.snippet}`);
    }
    process.exitCode = 1;
    return;
  }

  if (stale.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `No unreviewed FORCE-RLS migration backfills (${MIGRATIONS_DIR} scanned end to end).`,
  );
}

main();
