#!/usr/bin/env bun
import { join } from "node:path";
import {
  MIGRATIONS_DIR,
  ONLINE_SAFETY_FROM_ORDINAL,
  analyzeMigrationOnlineSafetyDirectory,
} from "./migration-online-safety";

// Audit is read-only and intentionally uses the older deployment-mode range.
const audit = process.argv.includes("--audit-existing");
const from = audit ? 786 : ONLINE_SAFETY_FROM_ORDINAL;
const findings = analyzeMigrationOnlineSafetyDirectory(join(process.cwd(), MIGRATIONS_DIR), from);
for (const finding of findings) {
  console.error(
    `${MIGRATIONS_DIR}/${finding.file}:${finding.statement} [${finding.rule}] ${finding.detail}`,
  );
}
console.log(
  `Migration online-safety ${audit ? "audit" : "guard"}: ${findings.length} findings from ordinal ${String(from).padStart(4, "0")}.`,
);
if (findings.length && !audit) process.exitCode = 1;
