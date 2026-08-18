/**
 * Phase D (docs/organization-tenancy.md) membership and personal-workspace
 * backfill driver.
 *
 * The population this drains is the one 0285's inventory counts as
 * `workspaceMemberSubjectsWithoutMembershipAnchor`: humans who held workspace
 * access before migration 0219 and never re-authenticated afterwards, so the
 * Better Auth managed-access hook never ran the provisioning seam for them and
 * they have no `organization_memberships` anchor at all. It also drains
 * `organizationMemberships.activeWithoutPersonalWorkspace`.
 *
 * Three rules shape everything here:
 *
 * 1. **Reuse the lifecycle seam.** Provisioning goes through
 *    `ensureManagedHumanPersonalWorkspace`, the single shared implementation
 *    over 0219's `ensure_managed_human_personal_workspace` SECURITY DEFINER
 *    capability - the same call the Better Auth hook makes. This driver holds
 *    no authority logic of its own and never writes an organization-tenancy
 *    table directly; the seam fails closed on every identity it cannot prove.
 *
 * 2. **Never infer authority.** Phase D forbids inferring user authority from
 *    `created_by`, connection attribution, a default workspace, a resource
 *    name, or current access. This driver acts only on deterministic evidence:
 *    a live Better Auth login identity for the exact subject, an organization
 *    whose own external identity IS that human, and a persisted owner-role
 *    workspace membership. Anything short of that is recorded unresolved with
 *    a reason code and left untouched - never guessed, never widened.
 *
 * 3. **Idempotent, resumable, concurrency-safe.** Each candidate is claimed
 *    independently with `FOR UPDATE SKIP LOCKED` on its exact owner workspace
 *    membership, so two operators running at once take disjoint work and
 *    neither double-provisions; the seam's own row locks are the final
 *    authority. Running the command again converges rather than duplicating,
 *    and `--dry-run` writes nothing at all.
 */
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, setRlsContext, withRlsContext } from "./database";
import { ensureManagedHumanPersonalWorkspace } from "./managed-human-provisioning";

/** Why a candidate cannot be provisioned from deterministic evidence alone. */
export type OrganizationMembershipBackfillUnresolvedReason =
  /** No Better Auth login identity exists for this subject: the `user:<id>`
   *  subject is a persisted string with nothing behind it. Guessing an
   *  identity here would be exactly the inference Phase D forbids. */
  | "missing_login_identity"
  /** The organization's own external identity is not this human. 0219's seam
   *  provisions only a managed human's self-owned organization, and 0263's
   *  invitation acceptance is bound to the invited human's own authenticated
   *  session - so no operator-runnable idempotent lifecycle operation exists
   *  for this row. It needs a human act, not a backfill. */
  | "organization_identity_mismatch"
  /** The subject has workspace access in this organization but holds no
   *  owner-role workspace membership, which the lifecycle seam requires as
   *  proof of ownership. Promoting them would manufacture authority. */
  | "missing_owner_workspace_membership"
  /** An anchor exists but is suspended or revoked. Reactivation is an explicit
   *  owner-authorized 0263 lifecycle action; a backfill must never perform it. */
  | "membership_terminal_status";

export type OrganizationMembershipBackfillCandidate = {
  subjectId: string;
  resolution: "provisionable" | "already_anchored" | "unresolved";
  reasonCode: OrganizationMembershipBackfillUnresolvedReason | null;
  organizationMembershipId: string | null;
  personalWorkspaceId: string | null;
};

export type OrganizationMembershipBackfillOutcome =
  | {
      subjectId: string;
      outcome: "provisioned";
      organizationMembershipId: string;
      personalWorkspaceId: string;
    }
  | {
      subjectId: string;
      outcome: "already_anchored";
      organizationMembershipId: string;
      personalWorkspaceId: string | null;
    }
  | {
      subjectId: string;
      outcome: "unresolved";
      reasonCode: OrganizationMembershipBackfillUnresolvedReason;
    }
  /** Another concurrent run holds this candidate's claim row. Deliberately not
   *  a failure: the next pass picks it up, which is what resumability means. */
  | { subjectId: string; outcome: "contended" }
  | { subjectId: string; outcome: "failed"; reasonCode: string };

export type OrganizationMembershipBackfillReport = {
  organizationId: string;
  dryRun: boolean;
  candidates: OrganizationMembershipBackfillCandidate[];
  results: OrganizationMembershipBackfillOutcome[];
  counts: {
    inspected: number;
    provisioned: number;
    alreadyAnchored: number;
    unresolved: number;
    contended: number;
    failed: number;
  };
};

type AnchorRow = {
  subjectId: string;
  membershipId: string;
  status: string;
  personalWorkspaceId: string | null;
};

const SUBJECT_PREFIX = "user:";

function subjectUserId(subjectId: string): string {
  return subjectId.slice(SUBJECT_PREFIX.length);
}

/** Drizzle expands a bare JS array into a parameter list, not a Postgres
 *  array, so every `= any(...)` / `text[]` argument is built explicitly. */
function textArray(values: readonly string[]) {
  return values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}::text`),
        sql`, `,
      )}]::text[]`;
}

/**
 * Enumerate the bounded, deterministically ordered backfill candidate set for
 * one organization and classify each one. Strictly read-only: safe to call
 * repeatedly, and the exact query `--dry-run` reports.
 */
export async function listOrganizationMembershipBackfillCandidates(
  db: Database,
  input: { organizationId: string; limit: number },
): Promise<OrganizationMembershipBackfillCandidate[]> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error("Organization membership backfill limit must be an integer from 1 to 100");
  }
  return await withRlsContext(
    db,
    { accountId: input.organizationId, workspaceId: null },
    async (scopedDb) => {
      // Population 1: humans with persisted workspace access in this
      // organization. Ordinary account-scoped application-role reads - no
      // widened visibility, no organization-tenancy table touched.
      const accessRows = await rawRows<{ subject_id: string; owner_membership_id: string | null }>(
        scopedDb,
        sql`
          select
            access.subject_id as subject_id,
            max(case when access.role = 'owner' then access.id::text else null end)
              as owner_membership_id
          from workspace_memberships access
          inner join workspaces workspace
            on workspace.id = access.workspace_id
           and workspace.account_id = access.account_id
          where access.account_id = ${input.organizationId}
            and access.subject_id like ${`${SUBJECT_PREFIX}%`}
          group by access.subject_id
          order by access.subject_id
          limit ${input.limit}
        `,
      );
      const ownerMembershipBySubject = new Map<string, string | null>(
        accessRows.map((row) => [row.subject_id, row.owner_membership_id]),
      );

      // Population 2: existing memberships that carry no personal workspace.
      // organization_memberships is FORCE-RLS with zero direct application
      // privileges, so this is the 0290 read-only definer seam.
      const [pendingResult] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`
          select list_organization_memberships_without_personal_workspace(
            ${input.organizationId}, ${input.limit}
          ) as result
        `,
      );
      const pendingRows = (pendingResult?.result ?? []) as Array<{
        subjectId: string;
        membershipId: string;
        status: string;
      }>;
      for (const row of pendingRows) {
        if (!ownerMembershipBySubject.has(row.subjectId)) {
          ownerMembershipBySubject.set(row.subjectId, null);
        }
      }

      const subjectIds = [...ownerMembershipBySubject.keys()].sort().slice(0, input.limit);
      if (subjectIds.length === 0) return [];

      // Owner-role proof for any subject that entered only through population 2.
      const missingOwnerProof = subjectIds.filter(
        (subjectId) => ownerMembershipBySubject.get(subjectId) == null,
      );
      if (missingOwnerProof.length > 0) {
        const ownerRows = await rawRows<{ subject_id: string; id: string }>(
          scopedDb,
          sql`
            select access.subject_id as subject_id, access.id::text as id
            from workspace_memberships access
            inner join workspaces workspace
              on workspace.id = access.workspace_id
             and workspace.account_id = access.account_id
            where access.account_id = ${input.organizationId}
              and access.role = 'owner'
              and access.subject_id = any(${textArray(missingOwnerProof)})
          `,
        );
        for (const row of ownerRows) ownerMembershipBySubject.set(row.subject_id, row.id);
      }

      const [anchorResult] = await rawRows<{ result: unknown }>(
        scopedDb,
        sql`
          select list_organization_membership_backfill_anchors(
            ${input.organizationId}, ${textArray(subjectIds)}
          ) as result
        `,
      );
      const anchorBySubject = new Map<string, AnchorRow>(
        ((anchorResult?.result ?? []) as AnchorRow[]).map((row) => [row.subjectId, row]),
      );

      // Deterministic login-identity evidence. `auth_users` is the Better Auth
      // user table; a subject with no row behind it is exactly the case Phase D
      // says must be recorded, not guessed.
      const userIds = subjectIds.map(subjectUserId);
      const identityRows = await rawRows<{ id: string }>(
        scopedDb,
        sql`select id from auth_users where id = any(${textArray(userIds)})`,
      );
      const knownUserIds = new Set(identityRows.map((row) => row.id));

      // The organization's own external identity. 0219's seam provisions only
      // a managed human's self-owned organization.
      const organizationRows = await rawRows<{
        external_source: string | null;
        external_id: string | null;
      }>(
        scopedDb,
        sql`
          select external_source, external_id
          from managed_accounts
          where id = ${input.organizationId}
        `,
      );
      const organization = organizationRows[0] ?? null;

      return subjectIds.map((subjectId): OrganizationMembershipBackfillCandidate => {
        const anchor = anchorBySubject.get(subjectId) ?? null;
        if (anchor && (anchor.status === "suspended" || anchor.status === "revoked")) {
          return {
            subjectId,
            resolution: "unresolved",
            reasonCode: "membership_terminal_status",
            organizationMembershipId: anchor.membershipId,
            personalWorkspaceId: anchor.personalWorkspaceId,
          };
        }
        if (anchor && anchor.personalWorkspaceId !== null) {
          return {
            subjectId,
            resolution: "already_anchored",
            reasonCode: null,
            organizationMembershipId: anchor.membershipId,
            personalWorkspaceId: anchor.personalWorkspaceId,
          };
        }
        if (!knownUserIds.has(subjectUserId(subjectId))) {
          return {
            subjectId,
            resolution: "unresolved",
            reasonCode: "missing_login_identity",
            organizationMembershipId: anchor?.membershipId ?? null,
            personalWorkspaceId: null,
          };
        }
        if (
          !organization ||
          organization.external_source !== "better-auth:user" ||
          organization.external_id !== subjectUserId(subjectId)
        ) {
          return {
            subjectId,
            resolution: "unresolved",
            reasonCode: "organization_identity_mismatch",
            organizationMembershipId: anchor?.membershipId ?? null,
            personalWorkspaceId: null,
          };
        }
        if (ownerMembershipBySubject.get(subjectId) == null) {
          return {
            subjectId,
            resolution: "unresolved",
            reasonCode: "missing_owner_workspace_membership",
            organizationMembershipId: anchor?.membershipId ?? null,
            personalWorkspaceId: null,
          };
        }
        return {
          subjectId,
          resolution: "provisionable",
          reasonCode: null,
          organizationMembershipId: anchor?.membershipId ?? null,
          personalWorkspaceId: null,
        };
      });
    },
  );
}

/**
 * Provision exactly one candidate inside one transaction.
 *
 * The transaction first claims the candidate's owner workspace membership with
 * `FOR UPDATE SKIP LOCKED`. That row is the natural claim: it is the exact
 * evidence the lifecycle seam validates, so holding it for the duration also
 * stops a concurrent workspace-membership removal from racing the anchor we are
 * writing. A skipped claim means a peer run owns this candidate right now -
 * reported as `contended`, picked up by the next pass.
 */
export async function provisionOrganizationMembershipBackfillCandidate(
  db: Database,
  input: { organizationId: string; subjectId: string },
): Promise<OrganizationMembershipBackfillOutcome> {
  return await db.transaction(async (tx) => {
    const scopedTx = tx as unknown as Database;
    await setRlsContext(scopedTx, { accountId: input.organizationId, workspaceId: null });
    const claimed = await rawRows<{ id: string }>(
      scopedTx,
      sql`
        select access.id::text as id
        from workspace_memberships access
        inner join workspaces workspace
          on workspace.id = access.workspace_id
         and workspace.account_id = access.account_id
        where access.account_id = ${input.organizationId}
          and access.subject_id = ${input.subjectId}
          and access.role = 'owner'
        order by access.id
        limit 1
        for update of access skip locked
      `,
    );
    if (claimed.length === 0) {
      // Either a peer run holds the claim, or the owner membership vanished
      // between enumeration and now. Both are safe to retry; neither may be
      // resolved by relaxing the evidence requirement.
      return { subjectId: input.subjectId, outcome: "contended" as const };
    }
    const provisioned = await ensureManagedHumanPersonalWorkspace(scopedTx, {
      accountId: input.organizationId,
      subjectId: input.subjectId,
    });
    return {
      subjectId: input.subjectId,
      outcome: "provisioned" as const,
      organizationMembershipId: provisioned.organizationMembershipId,
      personalWorkspaceId: provisioned.personalWorkspaceId,
    };
  });
}

/**
 * Run one bounded backfill pass over an organization. Safe to run repeatedly
 * and concurrently; `dryRun` inspects and classifies without writing anything.
 */
export async function runOrganizationMembershipBackfill(
  db: Database,
  input: { organizationId: string; limit: number; dryRun: boolean },
): Promise<OrganizationMembershipBackfillReport> {
  const candidates = await listOrganizationMembershipBackfillCandidates(db, {
    organizationId: input.organizationId,
    limit: input.limit,
  });
  const results: OrganizationMembershipBackfillOutcome[] = [];
  for (const candidate of candidates) {
    if (candidate.resolution === "unresolved") {
      results.push({
        subjectId: candidate.subjectId,
        outcome: "unresolved",
        reasonCode: candidate.reasonCode!,
      });
      continue;
    }
    if (candidate.resolution === "already_anchored") {
      results.push({
        subjectId: candidate.subjectId,
        outcome: "already_anchored",
        organizationMembershipId: candidate.organizationMembershipId!,
        personalWorkspaceId: candidate.personalWorkspaceId,
      });
      continue;
    }
    if (input.dryRun) continue;
    try {
      results.push(
        await provisionOrganizationMembershipBackfillCandidate(db, {
          organizationId: input.organizationId,
          subjectId: candidate.subjectId,
        }),
      );
    } catch (error) {
      // One candidate's failure must never roll back or hide the rest. The
      // reason is a bounded code; the exact diagnostic stays in the operator's
      // logs rather than becoming a stored blob.
      results.push({
        subjectId: candidate.subjectId,
        outcome: "failed",
        reasonCode:
          error instanceof Error && error.message.length > 0
            ? "lifecycle_seam_rejected"
            : "unknown_failure",
      });
    }
  }
  const countOf = (outcome: OrganizationMembershipBackfillOutcome["outcome"]): number =>
    results.filter((result) => result.outcome === outcome).length;
  return {
    organizationId: input.organizationId,
    dryRun: input.dryRun,
    candidates,
    results,
    counts: {
      inspected: candidates.length,
      provisioned: countOf("provisioned"),
      alreadyAnchored: countOf("already_anchored"),
      unresolved: countOf("unresolved"),
      contended: countOf("contended"),
      failed: countOf("failed"),
    },
  };
}
