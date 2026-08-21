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
 * share one transaction snapshot and one advisory fence. Seams that need to ask
 * about a subject that is NOT the caller call
 * {@link namedSubjectHasLiveWorkspaceAuthority} (`@opengeni/db`), which is a thin
 * scope wrapper over exactly this body.
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
 * # This function is NOT an authorization. Read this before relying on it.
 *
 * It answers "does subject X hold authority over workspace W". It does NOT
 * establish that the caller is X. Nothing here authenticates anybody.
 *
 * The scope assertion below is a **consistency check, not an authorization**.
 * It prevents one thing: a caller naming a third-party subject while its
 * transaction is scoped to someone else. It cannot detect a caller that scoped
 * the transaction to an attacker-chosen subject in the first place, because
 * `withWorkspaceSubjectRls(db, workspaceId, subjectId, ...)` takes that subject
 * from its argument too. At today's three call sites both sides come from the
 * same variable, so the check is a tautology there and fires only if a future
 * refactor makes them diverge. Treat it as a tripwire against that refactor —
 * never as evidence that the subject was authenticated.
 *
 * **The actual authorization for the personal-workspace exception lives in the
 * API layer**: `AccessGrantAuthorization.canonicalManagedHumanSession`
 * (`@opengeni/core`), stamped only where a Better Auth cookie was verified. A
 * caller that has not proven that must not enable the exception. If you are
 * adding a caller, that stamp is the part you have to get right; this function
 * will happily answer `true` for any subject you scope a transaction to.
 *
 * Non-`user:` subjects (API keys, delegated service principals, configured and
 * local principals) can never own an organization membership, so they
 * short-circuit to the plain membership answer instead of tripping
 * `list_self_organization_memberships`' `42501`.
 */
export async function subjectHasLiveWorkspaceAuthorityInScope(
  scopedDb: Database,
  input: { accountId: string; workspaceId: string; subjectId: string },
): Promise<boolean> {
  // CONSISTENCY CHECK, NOT AN AUTHORIZATION. This function deliberately does not
  // set `opengeni.subject_id`, so it cannot be handed a scope of its own — that
  // makes the oracle shape unrepresentable here. But the scope it inherits was
  // set by `withWorkspaceSubjectRls` from ITS caller's argument, so a match
  // proves only that one caller used one subject consistently; it proves
  // nothing about who that subject is. Authorization is the API layer's
  // canonical-managed-cookie stamp. See the doc comment above.
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
 * The applied subject GUC, or `""` when none is set. `""` is the canonical
 * "unset" for this GUC: `current_subject_id()` is
 * `nullif(current_setting('opengeni.subject_id', true), '')` (0239 precedent), so
 * a caller restoring `""` genuinely clears it rather than pinning an empty
 * subject. Never throws, so it is safe for capturing a prior value that may
 * legitimately be absent.
 */
export async function rlsSubjectIdOrEmpty(scopedDb: Database): Promise<string> {
  const [row] = await rawRows<{ subjectId: string | null }>(
    scopedDb,
    sql`select current_setting('opengeni.subject_id', true) as "subjectId"`,
  );
  return row?.subjectId ?? "";
}

/**
 * The subject of the caller's ALREADY-applied RLS scope, required to be present.
 * Used by the in-scope resolver to check that a caller is asking about its own
 * scope rather than naming a third party — a consistency check, not proof that
 * anything authenticated that subject.
 */
async function subjectIdInRlsScope(scopedDb: Database): Promise<string> {
  const subjectId = await rlsSubjectIdOrEmpty(scopedDb);
  if (!subjectId) {
    throw new Error("RLS subject context is not applied on the active backend");
  }
  return subjectId;
}

/**
 * The tenant account of the caller's ALREADY-applied RLS scope. `withRlsContext`
 * sets and read-back-verifies this GUC on the pinned backend before running the
 * scoped body, so it is exact rather than a re-derivation — which lets a seam
 * that only received a workspace id consult
 * {@link subjectHasLiveWorkspaceAuthorityInScope} without a second round trip to
 * resolve the account.
 */
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
