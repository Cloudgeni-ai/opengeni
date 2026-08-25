// Phase D membership and personal-workspace backfill driver (organization-tenancy slice 3).
//
// Provisions the organization-membership anchor and deterministic personal
// workspace for humans who held workspace access before migration 0219 and
// never re-authenticated afterwards, through the exact existing lifecycle seam.
// Idempotent, resumable, and safe to run repeatedly and concurrently. Usage:
//
//   bun run db:backfill-organization-memberships --organization-id <uuid> --dry-run
//   bun run db:backfill-organization-memberships --organization-id <uuid> \
//     --limit 25 --run-key <unique-key>
//
// `--limit` bounds ONE pass; the command walks the whole organization by
// chaining bounded passes on a keyset cursor until the ordered subject stream
// is exhausted, so a run genuinely converges instead of re-reading the first
// `--limit` subjects. `--max-passes` (default 1000) is a safety stop: a run
// that hits it reports `drained: false` plus the `lastCursor` that resumes it.
//
// Every candidate this command cannot resolve from deterministic evidence is
// reported unresolved with a reason code and left completely untouched.
// Supplying `--run-key` on a non-dry walk additionally settles one durable
// migration-0300 receipt. A partial/resumed, contended, or failed walk records
// a failed receipt; use a fresh run key for the final complete-from-start walk
// whose receipt can satisfy activation evidence.
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, drainOrganizationMembershipBackfill, type DbClient } from "@opengeni/db";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const organizationId = argument("--organization-id");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new Error("--organization-id <uuid> is required");
  }
  const rawLimit = argument("--limit") ?? "25";
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  const rawMaxPasses = argument("--max-passes") ?? "1000";
  const maxPasses = Number(rawMaxPasses);
  if (!Number.isInteger(maxPasses) || maxPasses < 1) {
    throw new Error("--max-passes must be a positive integer");
  }
  const afterSubjectId = argument("--after-subject-id");
  const runKey = argument("--run-key");
  if (runKey !== null && (runKey.trim().length === 0 || runKey.length > 200)) {
    throw new Error("--run-key must be 1..200 non-blank characters");
  }
  const dryRun = process.argv.includes("--dry-run");
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    const report = await drainOrganizationMembershipBackfill(client.db, {
      organizationId,
      limit,
      dryRun,
      maxPasses,
      runKey,
      ...(afterSubjectId ? { afterSubjectId } : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.counts.failed > 0 || report.receiptStatus === "failed") process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
