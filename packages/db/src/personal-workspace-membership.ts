import { sql, type SQL } from "drizzle-orm";
import * as schema from "./schema";

/**
 * The identity every Personal workspace carries: `external_source` is this
 * value and `external_id` is `<organization id>:<owner subject>`. Migration 1159
 * keeps it immutable and refuses any `workspace_memberships` row in such a
 * workspace other than its owner's.
 */
export const PERSONAL_WORKSPACE_EXTERNAL_SOURCE = "opengeni:organization-membership";

/**
 * Excludes a Personal workspace's own row from a `workspace_memberships` read.
 *
 * Migration 1159 makes a Personal workspace hold at most one row, its owner's.
 * That row is not membership evidence here. A membership row admits whoever
 * names its subject: a delegated bearer, a host token, a seam that never
 * checks who is asking. The owner reaches their Personal workspace only
 * through the `organization_memberships.personal_workspace_id` pointer, and only
 * with verified owning-user proof (`hasVerifiedOwningUserAuthorization`,
 * `personalWorkspaceOwnerException`). Every membership read in the runtime
 * applies this predicate, so a row in a Personal workspace changes nothing
 * about who can reach it. Only the SQL functions, which take their subject
 * from the scoped transaction, see the row.
 *
 * Renders against the unaliased `workspace_memberships` table.
 */
export function membershipOutsidePersonalWorkspace(): SQL {
  return sql`not exists (
    select 1 from ${schema.workspaces} personal_workspace
    where personal_workspace.id = ${schema.workspaceMemberships.workspaceId}
      and personal_workspace.external_source = ${PERSONAL_WORKSPACE_EXTERNAL_SOURCE}
  )`;
}

/** {@link membershipOutsidePersonalWorkspace} for a query that already joins `workspaces`. */
export function joinedWorkspaceIsNotPersonal(): SQL {
  return sql`${schema.workspaces.externalSource} is distinct from ${PERSONAL_WORKSPACE_EXTERNAL_SOURCE}`;
}

/** {@link membershipOutsidePersonalWorkspace} for raw SQL naming the membership table `alias`. */
export function rawMembershipOutsidePersonalWorkspace(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("invalid membership alias");
  return sql`not exists (
    select 1 from workspaces personal_workspace
    where personal_workspace.id = ${sql.raw(alias)}.workspace_id
      and personal_workspace.external_source = ${PERSONAL_WORKSPACE_EXTERNAL_SOURCE}
  )`;
}
