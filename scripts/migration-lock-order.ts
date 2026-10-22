/**
 * Static analysis for lock-order inversions between a migration and the
 * application.
 *
 * Application transactions take advisory fences first (every workspace-scoped
 * transaction holds the `session-tenancy:<workspace>` fence, and writers take
 * it exclusively) and only then lock table rows. A migration runs in one
 * transaction, and `ALTER TABLE` (including `NO FORCE ROW LEVEL SECURITY`),
 * `LOCK TABLE`, a plain `CREATE INDEX` or `CREATE TRIGGER` hold their table lock
 * until commit. A migration that takes such a table lock and then waits for an
 * advisory lock inverts that order: under load PostgreSQL detects the cycle
 * and aborts the application transactions caught in it during the rollout.
 *
 * A table lock held until commit already excludes every concurrent reader or
 * writer of that table, so an advisory fence taken after it is redundant for
 * that table. Either take every advisory fence before the first table lock, or
 * rely on the table locks and take no fence. When a fence-checking trigger
 * fires on the migration's own write, disable that trigger inside the window
 * the table lock already makes exclusive. A non-blocking `pg_try_advisory_*`
 * call never waits, so it cannot close a cycle and is not flagged.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStatements, stripComments, stripRoutineBodies } from "./migration-rls-backfills";

export { MIGRATIONS_DIR } from "./migration-rls-backfills";

/**
 * Migrations that shipped with an advisory fence after a table lock. Their
 * bytes are frozen by the release schema-contract hash ladder and they have
 * already run, so they are recorded here instead of rewritten.
 *
 * DO NOT add to this list. Take advisory fences before the first table lock,
 * or drop a fence the held table locks already make redundant.
 */
export const GRANDFATHERED_LOCK_ORDER_MIGRATIONS: readonly string[] = [
  "0478_sender_owned_connections.sql",
  "0673_delete_stranded_completed_turn_tool_receipts.sql",
  "0720_scheduled_task_audience.sql",
];

export type LockOrderFinding = {
  file: string;
  /** 1-based statement ordinal of the first table lock. */
  tableLockStatement: number;
  tableLock: string;
  /** 1-based statement ordinal of the later advisory lock. */
  advisoryStatement: number;
};

const TABLE_LOCK_STATEMENT =
  /^(?:ALTER\s+TABLE|LOCK\s+(?:TABLE\s+)?|TRUNCATE|DROP\s+TABLE|DROP\s+TRIGGER|CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER|CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY)|DROP\s+INDEX\s+(?!CONCURRENTLY)|REINDEX|CLUSTER|VACUUM\s+FULL|REFRESH\s+MATERIALIZED\s+VIEW\s+(?!CONCURRENTLY))/i;
const DO_BLOCK = /^DO\b/i;
const DYNAMIC_TABLE_LOCK = /\b(?:ALTER\s+TABLE|LOCK\s+TABLE)\b/i;
// Blocking acquisitions only: `pg_try_advisory_*` has no word boundary here.
const ADVISORY_LOCK = /\bpg_advisory_(?:xact_)?lock(?:_shared)?\s*\(/i;

/** Blank single-quoted literals: SQL text inside a string is not executed here. */
function stripStringLiterals(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''");
}

function executableText(statement: string): string {
  return stripStringLiterals(stripComments(stripRoutineBodies(statement))).trim();
}

/** The table-lock kind a statement takes at migration time, or null. */
export function tableLockOf(statement: string): string | null {
  const text = executableText(statement);
  const direct = TABLE_LOCK_STATEMENT.exec(text);
  if (direct) return direct[0].replace(/\s+/g, " ").trim().toUpperCase();
  if (DO_BLOCK.test(text)) {
    const nested = DYNAMIC_TABLE_LOCK.exec(text);
    if (nested) return nested[0].replace(/\s+/g, " ").toUpperCase();
  }
  return null;
}

/** True when a statement acquires an advisory lock at migration time. */
export function takesAdvisoryLock(statement: string): boolean {
  return ADVISORY_LOCK.test(executableText(statement));
}

export function analyzeMigrationSql(file: string, sql: string): LockOrderFinding | null {
  const statements = splitStatements(sql);
  let firstTableLock: { ordinal: number; kind: string } | null = null;
  for (const [index, statement] of statements.entries()) {
    if (firstTableLock && takesAdvisoryLock(statement)) {
      return {
        file,
        tableLockStatement: firstTableLock.ordinal,
        tableLock: firstTableLock.kind,
        advisoryStatement: index + 1,
      };
    }
    if (!firstTableLock) {
      const kind = tableLockOf(statement);
      if (kind) firstTableLock = { ordinal: index + 1, kind };
    }
  }
  return null;
}

export function analyzeMigrationLockOrder(migrationsDir: string): LockOrderFinding[] {
  const findings: LockOrderFinding[] = [];
  for (const file of readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const finding = analyzeMigrationSql(file, readFileSync(join(migrationsDir, file), "utf8"));
    if (finding) findings.push(finding);
  }
  return findings;
}

export function unreviewedLockOrderFindings(
  findings: readonly LockOrderFinding[],
): LockOrderFinding[] {
  return findings.filter((finding) => !GRANDFATHERED_LOCK_ORDER_MIGRATIONS.includes(finding.file));
}

export function staleLockOrderAllowlistEntries(migrationsDir: string): string[] {
  const files = new Set(readdirSync(migrationsDir));
  return GRANDFATHERED_LOCK_ORDER_MIGRATIONS.filter((file) => !files.has(file));
}
