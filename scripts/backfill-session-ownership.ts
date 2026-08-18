// OPE-204 phase D session ownership classification and backfill (migration
// 0294). Usage:
//
//   # classify only - never writes a session row
//   bun run db:backfill-session-ownership --organization-id <uuid> --classify
//   bun run db:backfill-session-ownership --organization-id <uuid> --classify \
//     --run-key <key>
//
//   # report what the backfill WOULD attribute (the default; no write)
//   bun run db:backfill-session-ownership --organization-id <uuid>
//
//   # actually attribute, in bounded resumable batches
//   bun run db:backfill-session-ownership --organization-id <uuid> --apply \
//     --limit 500 --max-batches 200 --run-key <key>
//
// The backfill repairs ONLY the two deterministic populations described in
// migration 0294: a session in exactly one active organization membership's
// personal workspace whose creator subject is that same membership, and the
// parent-inheritance closure migration 0225's own trigger would have produced.
// Everything else is recorded unresolved by `--classify`, never guessed.
//
// Batches are idempotent and claimed with `FOR UPDATE ... SKIP LOCKED`, so this
// command is safe to re-run, safe to interrupt, and safe to run concurrently.
// Check `ledgerAvailable` in the output: `false` means the tenancy backfill
// ledger migration is not present on this target and nothing was recorded.
import { dbSearchPath, getSettings } from "@opengeni/config";
import {
  backfillOrganizationSessionOwnership,
  classifyOrganizationSessionOwnership,
  createDb,
  type DbClient,
} from "@opengeni/db";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
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
  const runKey = argument("--run-key");
  if (runKey !== null && runKey.trim().length === 0) {
    throw new Error("--run-key must not be blank");
  }
  // `--apply` is the only way to write. `--dry-run` is accepted so the flag can
  // be stated explicitly, but its absence never implies a write.
  const apply = flag("--apply");
  if (apply && flag("--dry-run")) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  const limit = positiveInteger("--limit", 500);
  const maxBatches = positiveInteger("--max-batches", 200);

  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    if (flag("--classify")) {
      const report = await classifyOrganizationSessionOwnership(client.db, {
        organizationId,
        runKey,
      });
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const batches: Array<Record<string, unknown>> = [];
    let attributed = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const result = await backfillOrganizationSessionOwnership(client.db, {
        organizationId,
        limit,
        dryRun: !apply,
        // Each batch needs its own receipt: the ledger refuses to re-open a
        // settled one, and a per-batch key keeps the evidence exact.
        runKey: runKey === null ? null : `${runKey}:batch-${batch + 1}`,
      });
      batches.push(result);
      attributed += Number(result.attributed ?? 0);
      if (result.moreLikely !== true) break;
    }
    console.log(
      JSON.stringify(
        {
          organizationId,
          applied: apply,
          limit,
          maxBatches,
          batchCount: batches.length,
          attributed,
          // True when the loop stopped on its own bound rather than because the
          // repairable population was drained. Re-run to continue.
          reachedMaxBatches: batches.length === maxBatches && batches.at(-1)?.moreLikely === true,
          batches,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
