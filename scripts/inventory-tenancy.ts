// Read-only organization tenancy inventory: counts of every legacy-attribution
// population the tenancy backfill/parity program gates on. Content-free
// integers only. Usage:
//   bun run db:inventory-tenancy --organization-id <uuid>
import { dbSearchPath, getSettings } from "@opengeni/config";
import { createDb, inventoryOrganizationTenancy, type DbClient } from "@opengeni/db";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const organizationId = argument("--organization-id");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new Error("--organization-id <uuid> is required");
  }
  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    const inventory = await inventoryOrganizationTenancy(client.db, { organizationId });
    console.log(JSON.stringify(inventory, null, 2));
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
