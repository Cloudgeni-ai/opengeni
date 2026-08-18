// Phase D membership and personal-workspace backfill driver (organization-tenancy slice 3).
//
// Provisions the organization-membership anchor and deterministic personal
// workspace for humans who held workspace access before migration 0219 and
// never re-authenticated afterwards, through the exact existing lifecycle seam.
// Idempotent, resumable, and safe to run repeatedly and concurrently. Usage:
//
//   bun run db:backfill-organization-memberships --organization-id <uuid> --dry-run
//   bun run db:backfill-organization-memberships --organization-id <uuid> --limit 25
//
// Every candidate this command cannot resolve from deterministic evidence is
// reported unresolved with a reason code and left completely untouched.
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, runOrganizationMembershipBackfill, type DbClient } from "@opengeni/db";

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
  const dryRun = process.argv.includes("--dry-run");
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    const report = await runOrganizationMembershipBackfill(client.db, {
      organizationId,
      limit,
      dryRun,
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.counts.failed > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
