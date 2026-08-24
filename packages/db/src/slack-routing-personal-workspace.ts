// The personal-workspace pointer, in its own leaf module.
//
// Both the Slack routing resolvers and the Slack access-request path need it,
// and this keeps that from becoming an import cycle between them.
import { sql } from "drizzle-orm";

import { type Database } from "./database";
import { listSelfOrganizationMemberships } from "./organization-membership-lifecycle";
import { rlsSubjectIdOrEmpty } from "./workspace-authority";

/**
 * The subject's own personal workspace in one organization, or null.
 *
 * Only an `active` membership counts, and only that membership's own
 * `personalWorkspaceId` pointer is read - never a default workspace, a
 * `created_by`, or current access.
 *
 * Non-`user:` subjects (API keys, delegated service principals, configured and
 * local principals) can never own an organization membership, so they
 * short-circuit rather than tripping `list_self_organization_memberships`'
 * `42501` guard.
 */
export async function personalWorkspaceIdForSubject(
  db: Database,
  input: { accountId: string; subjectId: string },
): Promise<string | null> {
  if (!input.subjectId.startsWith("user:")) return null;
  // `listSelfOrganizationMemberships` opens its own scope and sets
  // `opengeni.subject_id` to the probed subject. Under drizzle a nested
  // transaction is a SAVEPOINT, and releasing a savepoint does NOT undo a
  // transaction-local `set_config`, so without this the probed subject would
  // leak out and silently re-scope the rest of a caller-owned transaction.
  // `namedSubjectHasLiveWorkspaceAuthority` guards the same hazard the same
  // way; empty string is the canonical "unset" because `current_subject_id()`
  // is `nullif(current_setting(...), '')`.
  const priorSubjectId = await rlsSubjectIdOrEmpty(db);
  let completed = false;
  try {
    const memberships = await listSelfOrganizationMemberships(db, input.subjectId);
    const membership = memberships.find(
      (candidate) =>
        candidate.status === "active" &&
        candidate.organizationId === input.accountId &&
        candidate.personalWorkspaceId !== null,
    );
    completed = true;
    return membership?.personalWorkspaceId ?? null;
  } finally {
    const restore = db.execute(
      sql`select set_config('opengeni.subject_id', ${priorSubjectId}, true)`,
    );
    if (completed) {
      await restore;
    } else {
      // A failed statement can leave a caller-owned transaction aborted.
      // Preserve the original diagnostic rather than replacing it with the
      // restore's `25P02`.
      await restore.catch(() => undefined);
    }
  }
}
