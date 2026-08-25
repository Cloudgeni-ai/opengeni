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

export type ConnectionAuthorityConvergenceClassification =
  | "connection_backfill_ready"
  | "membership_backfill_eligible"
  | "membership_lifecycle_review_required"
  | "external_subject_requires_classification"
  | "missing_login_identity"
  | "organization_identity_mismatch"
  | "missing_owner_workspace_membership"
  | "conflicting_authority_rows"
  | "legacy_shape_unrecognized";

export type ConnectionAuthorityConvergenceAction =
  | "run_connection_backfill"
  | "run_membership_backfill_then_connection_backfill"
  | "review_membership_lifecycle_do_not_reactivate_automatically"
  | "classify_external_subject_then_migrate_via_authorized_connection_lifecycle"
  | "restore_login_identity_then_recheck"
  | "correct_organization_identity_through_supported_account_lifecycle_then_recheck"
  | "establish_owner_workspace_membership_through_supported_membership_lifecycle_then_recheck"
  | "repair_conflicting_connection_authority_rows_under_incident_procedure"
  | "repair_unrecognized_connection_authority_shape_under_incident_procedure";

export type ConnectionAuthorityConvergenceEvidence = {
  schemaVersion: 1;
  organizationId: string;
  limit: number;
  afterConnectionId: string | null;
  items: Array<{
    connectionId: string;
    subjectId: string | null;
    classification: ConnectionAuthorityConvergenceClassification;
    action: ConnectionAuthorityConvergenceAction;
  }>;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
  /** Full-organization totals. They are deliberately independent of the page cursor. */
  remaining: {
    total: number;
    autoRemediable: number;
    manualReview: number;
    byClassification: {
      connectionBackfillReady: number;
      membershipBackfillEligible: number;
      membershipLifecycleReviewRequired: number;
      externalSubjectRequiresClassification: number;
      missingLoginIdentity: number;
      organizationIdentityMismatch: number;
      missingOwnerWorkspaceMembership: number;
      conflictingAuthorityRows: number;
      legacyShapeUnrecognized: number;
    };
  };
};

/**
 * Read one bounded evidence page while also returning cursor-independent
 * full-organization residual totals. The database routine holds a read-only,
 * invocation-exact FORCE-RLS capability and never writes connection authority.
 */
export async function inspectOrganizationConnectionAuthorityConvergence(
  db: Database,
  input: { organizationId: string; limit?: number; afterConnectionId?: string | null },
): Promise<ConnectionAuthorityConvergenceEvidence> {
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Connection convergence evidence limit must be an integer from 1 to 100");
  }
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      const [row] = await rawRows<{ report: ConnectionAuthorityConvergenceEvidence }>(
        scopedDb,
        sql`select inspect_organization_connection_authority_convergence(
          ${input.organizationId}::uuid,
          ${limit}::integer,
          ${input.afterConnectionId ?? null}::uuid
        ) as report`,
      );
      if (!row) throw new Error("Connection convergence inspection returned no report");
      return row.report;
    },
  );
}

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
