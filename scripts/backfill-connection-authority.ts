// Organization-tenancy phase-D connection convergence (migration 0340).
//
//   # report the next bounded deterministic batch (default, no writes)
//   bun run db:backfill-connection-authority --organization-id <uuid>
//
//   # converge all deterministic rows, then write one full-population receipt
//   bun run db:backfill-connection-authority --organization-id <uuid> --apply \
//     --limit 500 --max-batches 200 --run-key <fresh-key>
//
//   # satisfy only independently proven membership prerequisites first
//   bun run db:backfill-connection-authority --organization-id <uuid> --apply \
//     --remediate-memberships --membership-run-key <fresh-membership-key> \
//     --run-key <fresh-connection-key>
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
  drainOrganizationMembershipBackfill,
  inspectOrganizationConnectionAuthorityConvergence,
  type ConnectionAuthorityClassificationReport,
  type ConnectionAuthorityConvergenceEvidence,
  type DbClient,
  type OrganizationMembershipBackfillDrainReport,
} from "@opengeni/db";

function argument(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

function positiveInteger(argv: readonly string[], name: string, fallback: number): number {
  const raw = argument(argv, name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export type BackfillConnectionAuthorityCliOptions = {
  organizationId: string;
  apply: boolean;
  limit: number;
  maxBatches: number;
  runKey: string | null;
  remediateMemberships: boolean;
  membershipRunKey: string | null;
  evidenceLimit: number;
  afterConnectionId: string | null;
};

export function parseBackfillConnectionAuthorityArguments(
  argv: readonly string[],
): BackfillConnectionAuthorityCliOptions {
  const organizationId = argument(argv, "--organization-id");
  if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
    throw new Error("--organization-id <uuid> is required");
  }
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) {
    throw new Error("--apply and --dry-run are mutually exclusive");
  }
  const limit = positiveInteger(argv, "--limit", 500);
  if (limit > 5000) throw new Error("--limit must not exceed 5000");
  const maxBatches = positiveInteger(argv, "--max-batches", 200);
  const runKey = argument(argv, "--run-key");
  const remediateMemberships = argv.includes("--remediate-memberships");
  const membershipRunKey = argument(argv, "--membership-run-key");
  const evidenceLimit = positiveInteger(argv, "--evidence-limit", 100);
  const afterConnectionId = argument(argv, "--after-connection-id");
  if (runKey !== null && (runKey.trim().length === 0 || runKey.length > 200)) {
    throw new Error("--run-key must be 1..200 non-blank characters");
  }
  if (!apply && runKey !== null) {
    throw new Error("--run-key requires --apply so a partial dry run cannot look settled");
  }
  if (remediateMemberships && !apply) {
    throw new Error("--remediate-memberships requires --apply");
  }
  if (remediateMemberships && membershipRunKey === null) {
    throw new Error("--remediate-memberships requires --membership-run-key <fresh-key>");
  }
  if (!remediateMemberships && membershipRunKey !== null) {
    throw new Error("--membership-run-key requires --remediate-memberships");
  }
  if (
    membershipRunKey !== null &&
    (membershipRunKey.trim().length === 0 || membershipRunKey.length > 200)
  ) {
    throw new Error("--membership-run-key must be 1..200 non-blank characters");
  }
  if (evidenceLimit > 100) throw new Error("--evidence-limit must not exceed 100");
  if (afterConnectionId !== null && !/^[0-9a-f-]{36}$/i.test(afterConnectionId)) {
    throw new Error("--after-connection-id must be a UUID");
  }
  return {
    organizationId,
    apply,
    limit,
    maxBatches,
    runKey,
    remediateMemberships,
    membershipRunKey,
    evidenceLimit,
    afterConnectionId,
  };
}

/**
 * Completion is always based on cursor-independent organization totals. The
 * page cursor controls display only and can never turn an empty late page into
 * a successful exit while earlier residual rows still exist.
 */
export function connectionAuthorityConvergenceFailed(input: {
  incomplete: boolean;
  evidenceAfter: ConnectionAuthorityConvergenceEvidence;
  classification: ConnectionAuthorityClassificationReport | null;
  membershipRemediation: OrganizationMembershipBackfillDrainReport | null;
}): boolean {
  const membership = input.membershipRemediation;
  return (
    input.incomplete ||
    input.evidenceAfter.remaining.total > 0 ||
    (input.classification?.connections.unresolved ?? 0) > 0 ||
    (membership !== null &&
      (!membership.drained ||
        membership.counts.unresolved > 0 ||
        membership.counts.contended > 0 ||
        membership.counts.failed > 0 ||
        membership.receiptStatus === "failed"))
  );
}

async function main(): Promise<void> {
  const options = parseBackfillConnectionAuthorityArguments(process.argv.slice(2));
  const {
    organizationId,
    apply,
    limit,
    maxBatches,
    runKey,
    remediateMemberships,
    membershipRunKey,
    evidenceLimit,
    afterConnectionId,
  } = options;

  const settings = getSettings();
  const searchPath = dbSearchPath(settings);
  const client: DbClient = createDb(settings.databaseUrl, {
    ...(searchPath ? { searchPath } : {}),
    rlsStrategy: settings.rlsStrategy,
    max: 2,
  });
  try {
    const evidenceBefore = await inspectOrganizationConnectionAuthorityConvergence(client.db, {
      organizationId,
      limit: evidenceLimit,
      ...(afterConnectionId ? { afterConnectionId } : {}),
    });
    const membershipRemediation = remediateMemberships
      ? await drainOrganizationMembershipBackfill(client.db, {
          organizationId,
          limit: Math.min(limit, 100),
          dryRun: false,
          maxPasses: maxBatches,
          runKey: membershipRunKey,
        })
      : null;
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
    const evidenceAfter = await inspectOrganizationConnectionAuthorityConvergence(client.db, {
      organizationId,
      limit: evidenceLimit,
      ...(afterConnectionId ? { afterConnectionId } : {}),
    });
    console.log(
      JSON.stringify(
        {
          organizationId,
          applied: apply,
          limit,
          maxBatches,
          incomplete,
          evidenceBefore,
          membershipRemediation,
          batches,
          classification,
          evidenceAfter,
        },
        null,
        2,
      ),
    );
    if (
      connectionAuthorityConvergenceFailed({
        incomplete,
        evidenceAfter,
        classification,
        membershipRemediation,
      })
    ) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
}

if (import.meta.main) await main();
