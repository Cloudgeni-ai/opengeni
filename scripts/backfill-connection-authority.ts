// Organization-tenancy phase-D connection convergence (migration 0340).
//
//   # report the next bounded deterministic batch (default, no writes)
//   bun run db:backfill-connection-authority --organization-id <uuid>
//
//   # converge all deterministic rows, then write one full-population receipt
//   bun run db:backfill-connection-authority --organization-id <uuid> --apply \
//     --limit 500 --max-batches 200 --run-key <fresh-key>
//
// Ownership is proven only by connections.subject_id plus one exact active
// same-organization membership. Origin workspace/current access are never
// authority. A run key is accepted only on a complete apply walk; partial
// walks must resume with no receipt and classify with a fresh key at the end.
import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  backfillOrganizationConnectionAuthority,
  classifyOrganizationConnectionAuthority,
  createDb,
  type DbClient,
} from "@opengeni/db";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const organizationId = argument("--organization-id");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new Error("--organization-id <uuid> is required");
  }
  const apply = process.argv.includes("--apply");
  if (apply && process.argv.includes("--dry-run")) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  const limit = positiveInteger("--limit", 500);
  if (limit > 5000) throw new Error("--limit must not exceed 5000");
  const maxBatches = positiveInteger("--max-batches", 200);
  const runKey = argument("--run-key");
  if (runKey !== null && (runKey.trim().length === 0 || runKey.length > 200)) {
    throw new Error("--run-key must be 1..200 non-blank characters");
  }
  if (!apply && runKey !== null) {
    throw new Error("--run-key requires --apply so a partial dry run cannot look settled");
  }

  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    const batches = [];
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const report = await backfillOrganizationConnectionAuthority(client.db, {
        organizationId,
        limit,
        dryRun: !apply,
      });
      batches.push(report);
      if (!apply || !report.moreLikely) break;
    }
    const incomplete = apply && batches.at(-1)?.moreLikely === true;
    if (incomplete && runKey !== null) {
      throw new Error(
        "Connection authority backfill hit --max-batches; resume without a run key, then classify with a fresh key",
      );
    }
    const classification =
      apply && !incomplete
        ? await classifyOrganizationConnectionAuthority(client.db, {
            organizationId,
            runKey,
          })
        : null;
    console.log(
      JSON.stringify(
        { organizationId, applied: apply, limit, maxBatches, incomplete, batches, classification },
        null,
        2,
      ),
    );
    if (classification && classification.connections.unresolved > 0) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
