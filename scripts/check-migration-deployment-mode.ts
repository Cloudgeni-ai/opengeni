#!/usr/bin/env bun
/**
 * Rolling (expand/contract) is the default deployment mode for a migration.
 *
 *   bun scripts/check-migration-deployment-mode.ts
 *
 * Fails when a new migration (ordinal >= GOVERNED_FROM_ORDINAL) lacks the
 * line-1 deployment-mode header, is maintenance without a concrete
 * `-- maintenance-justification:`, or is rolling but performs contract-phase DDL
 * without `-- contract-step:`. A single maintenance migration drains the whole
 * fleet for its release; the 2026-10-15 outage came from one such batch.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_STEP_KEY,
  GOVERNED_FROM_ORDINAL,
  GUIDE_PATH,
  JUSTIFICATION_KEY,
  MIGRATIONS_DIR,
  analyzeMigrationDeploymentModes,
} from "./migration-deployment-mode";

const GUIDE_URL = `https://github.com/Cloudgeni-ai/opengeni/blob/main/${GUIDE_PATH}`;

function main(): void {
  const migrationsDir = join(process.cwd(), MIGRATIONS_DIR);
  if (!existsSync(migrationsDir)) {
    throw new Error(`run from the repository root (missing ${MIGRATIONS_DIR})`);
  }
  const findings = analyzeMigrationDeploymentModes(migrationsDir);
  if (findings.length === 0) {
    console.log(
      `Migration deployment-mode guard passed (migrations from ${String(GOVERNED_FROM_ORDINAL).padStart(4, "0")} on).`,
    );
    return;
  }
  console.error(`${findings.length} migration(s) violate the deployment-mode policy:`);
  for (const finding of findings) {
    console.error(`  - ${MIGRATIONS_DIR}/${finding.file}: ${finding.detail}`);
  }
  console.error(
    [
      "",
      "Rolling is the default. Start the file with `-- deployment-mode: rolling` and split",
      "incompatible changes into expand -> migrate/backfill -> contract steps across releases.",
      "",
      "If no expand/contract sequence works, keep `-- deployment-mode: maintenance` on line 1 and",
      "explain why in the leading comment block (below any `-- opengeni:` directive, which stays on",
      "line 2); indent continuation lines with `--   `:",
      "",
      "  -- deployment-mode: maintenance",
      `  -- ${JUSTIFICATION_KEY}: <why old and new binaries cannot share this schema,`,
      "  --   and why no expand/contract sequence avoids draining the fleet>",
      "",
      "A rolling migration that drops, renames, retypes or sets NOT NULL on an existing table must",
      "name the earlier release after which no running binary uses the old shape, or say why the",
      "previous release is unaffected:",
      "",
      "  -- deployment-mode: rolling",
      `  -- ${CONTRACT_STEP_KEY}: <migration or PR after which nothing reads/writes it>`,
      "",
      `Guide: ${GUIDE_PATH} (${GUIDE_URL})`,
    ].join("\n"),
  );
  process.exit(1);
}

main();
