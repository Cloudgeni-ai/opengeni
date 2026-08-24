import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, type Database } from "./database";

export type ConnectionAuthorityClassificationReport = {
  schemaVersion: 1;
  organizationId: string;
  runKey: string | null;
  rewroteConnectionRows: false;
  receiptId?: string;
  connections: {
    total: number;
    workspaceOwned: number;
    userOwned: number;
    deterministicRepairPending: number;
    unresolved: number;
  };
};

export type ConnectionAuthorityBackfillReport = {
  schemaVersion: 1;
  organizationId: string;
  dryRun: boolean;
  limit: number;
  candidates: number;
  upgraded: number;
  moreLikely: boolean;
};

/**
 * Full-population connection authority classification. Supplying a fresh run
 * key writes one immutable migration-0300 receipt and exact unresolved rows.
 */
export async function classifyOrganizationConnectionAuthority(
  db: Database,
  input: { organizationId: string; runKey?: string | null },
): Promise<ConnectionAuthorityClassificationReport> {
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      const [row] = await rawRows<{ report: ConnectionAuthorityClassificationReport }>(
        scopedDb,
        sql`select classify_organization_connection_authority(
          ${input.organizationId}::uuid, ${input.runKey ?? null}::text
        ) as report`,
      );
      if (!row) throw new Error("Connection authority classification returned no report");
      return row.report;
    },
  );
}

/**
 * One bounded, resumable legacy_user -> user upgrade batch. Dry-run is the
 * default; candidates are claimed with SKIP LOCKED when applying.
 */
export async function backfillOrganizationConnectionAuthority(
  db: Database,
  input: { organizationId: string; limit?: number; dryRun?: boolean },
): Promise<ConnectionAuthorityBackfillReport> {
  const limit = input.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("Connection authority backfill limit must be an integer from 1 to 5000");
  }
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      const [row] = await rawRows<{ report: ConnectionAuthorityBackfillReport }>(
        scopedDb,
        sql`select backfill_organization_connection_authority(
          ${input.organizationId}::uuid,
          ${limit}::integer,
          ${input.dryRun ?? true}::boolean
        ) as report`,
      );
      if (!row) throw new Error("Connection authority backfill returned no report");
      return row.report;
    },
  );
}
