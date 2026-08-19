import { OrganizationMember } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";

/**
 * THE canonical live-workspace-authority resolver for one exact subject, run on
 * a handle that is ALREADY inside the caller's transaction with that subject's
 * RLS context applied.
 *
 * `getWorkspaceGrant` is a bare `workspace_memberships` join and is therefore
 * NOT a complete authority answer: a managed human's personal workspace
 * deliberately has no row in that table (migration 0219 raises on one), so its
 * owner's access is the `organization_memberships.personal_workspace_id`
 * pointer instead. Any seam that re-derives "does this subject still hold
 * workspace authority here" from that bare join denies the one human who always
 * belongs. This module exists so that rule has exactly one implementation.
 *
 * Seams that must serialize the answer with their own writes — session listing,
 * session pins, the composer draft — call this variant so the read and the write
 * share one transaction snapshot and one advisory fence. Seams that just need
 * the answer call {@link subjectHasLiveWorkspaceAuthority} (`@opengeni/db`),
 * which is a thin scope wrapper over exactly this body.
 *
 * True when the subject currently holds workspace authority the same way the
 * route-time access builder derives it: a `workspace_memberships` row whose
 * owning organization membership (when one exists) is active, or an active
 * organization membership whose personal-workspace pointer is exactly this
 * workspace. Never infers authority any other way; a deleted membership row and
 * a suspended/revoked organization membership are both false. Only the
 * membership's own `personal_workspace_id` counts as stated authority — nothing
 * is read from `created_by`, a default workspace, a resource name, or current
 * access.
 *
 * **Owner-only by construction.** The personal-workspace half reads
 * `list_self_organization_memberships`, a SECURITY DEFINER seam (0263) that
 * raises `42501` unless the requested subject is exactly the transaction's own
 * `opengeni.subject_id` GUC and matches `user:%`. The only fact it can ever
 * return is "subject X owns personal workspace W", for the exact X named — so
 * no account or organization administrator, API key, service principal, or
 * delegated bearer reaches a different human's personal workspace through it,
 * whatever subject a caller supplies. Callers must still keep the exception off
 * a principal's own authorization path: pass only a subject the caller is
 * entitled to ask about (its own canonical managed-cookie subject, or the
 * frozen owner of a delegation it already holds).
 *
 * Non-`user:` subjects (API keys, delegated service principals, configured and
 * local principals) can never own an organization membership, so they
 * short-circuit to the plain membership answer instead of tripping that
 * `42501`.
 */
export async function subjectHasLiveWorkspaceAuthorityInScope(
  scopedDb: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<boolean> {
  // This function must never be an arbitrary-subject oracle. It deliberately
  // does NOT set `opengeni.subject_id`: it answers only about the subject the
  // caller's transaction is ALREADY scoped to, which
  // `withWorkspaceSubjectRls(db, workspaceId, subjectId, ...)` applied and read
  // back on the pinned backend before this body runs. The assertion below turns
  // "the caller happened to pass the right subject" into "the caller cannot
  // pass any other one" — without it, a seam that forwards a request-derived
  // subject would reach `list_self_organization_memberships` under a scope it
  // did not authenticate.
  const scopedSubjectId = await subjectIdInRlsScope(scopedDb);
  if (scopedSubjectId !== input.subjectId) {
    throw new Error(
      "subjectHasLiveWorkspaceAuthorityInScope: subject does not match the applied RLS scope",
    );
  }
  const [membershipRow] = await rawRows<{ present: number }>(
    scopedDb,
    sql`select 1 as present from workspace_memberships
      where subject_id = ${input.subjectId}
        and workspace_id = ${input.workspaceId}
      limit 1`,
  );
  if (!input.subjectId.startsWith("user:")) {
    return Boolean(membershipRow);
  }
  const [organizationMembershipResult] = await rawRows<{ result: unknown }>(
    scopedDb,
    sql`select list_self_organization_memberships(${input.subjectId}) as result`,
  );
  const organizationMemberships = OrganizationMember.array().parse(
    organizationMembershipResult?.result ?? [],
  );
  const selfOrganizationMembership = organizationMemberships.find(
    (organizationMembership) => organizationMembership.organizationId === input.accountId,
  );
  if (membershipRow) {
    // Mirror the access builder's inactive-organization filter: a persisted
    // membership row is dead while its organization membership is
    // suspended/revoked. A subject with no organization membership at all
    // (legacy/standalone) keeps its persisted row's authority.
    return !selfOrganizationMembership || selfOrganizationMembership.status === "active";
  }
  return (
    selfOrganizationMembership?.status === "active" &&
    selfOrganizationMembership.personalWorkspaceId === input.workspaceId
  );
}

/**
 * The tenant account of the caller's ALREADY-applied RLS scope. `withRlsContext`
 * sets and read-back-verifies this GUC on the pinned backend before running the
 * scoped body, so it is exact rather than a re-derivation — which lets a seam
 * that only received a workspace id consult
 * {@link subjectHasLiveWorkspaceAuthorityInScope} without a second round trip to
 * resolve the account.
 */
/**
 * The authenticated subject of the caller's ALREADY-applied RLS scope, as
 * `setSubjectRlsContext` set and read back on the pinned backend. Used to prove
 * that a caller is asking about its own scope rather than naming a third party.
 */
async function subjectIdInRlsScope(scopedDb: Database): Promise<string> {
  const [row] = await rawRows<{ subjectId: string | null }>(
    scopedDb,
    sql`select current_setting('opengeni.subject_id', true) as "subjectId"`,
  );
  const subjectId = row?.subjectId ?? "";
  if (!subjectId) {
    throw new Error("RLS subject context is not applied on the active backend");
  }
  return subjectId;
}

export async function accountIdInRlsScope(scopedDb: Database): Promise<string> {
  const [row] = await rawRows<{ accountId: string | null }>(
    scopedDb,
    sql`select current_setting('opengeni.account_id', true) as "accountId"`,
  );
  const accountId = row?.accountId ?? "";
  if (!accountId) {
    throw new Error("RLS account context is not applied on the active backend");
  }
  return accountId;
}
