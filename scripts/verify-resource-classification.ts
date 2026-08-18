// OPE-204 phase D classification assertion for Variable Sets, Rigs, and
// Connected Machines. Read-only over every resource table - it proves each row
// already carries an explicit terminal authority classification and rewrites
// nothing. Usage:
//   bun run db:verify-resource-classification --organization-id <uuid>
//   bun run db:verify-resource-classification --organization-id <uuid> --run-key <key>
//
// Without --run-key the call is a pure read. With one, the same verdicts are
// recorded durably through the tenancy backfill ledger as one receipt per
// family plus one append-only unresolved row per resource that could not be
// proven. A run key may be used once; the ledger refuses to re-open a settled
// receipt. Check `ledgerAvailable` in the output: `false` means the ledger
// migration is not present on this target and nothing was recorded.
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, verifyOrganizationResourceClassification, type DbClient } from "@opengeni/db";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const organizationId = argument("--organization-id");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new Error("--organization-id <uuid> is required");
  }
  const runKey = argument("--run-key");
  if (runKey !== null && runKey.trim().length === 0) {
    throw new Error("--run-key must not be blank");
  }
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    const report = await verifyOrganizationResourceClassification(client.db, {
      organizationId,
      runKey,
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
