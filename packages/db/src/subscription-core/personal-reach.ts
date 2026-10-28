/**
 * The Personal-workspace reach of a workspace's own shared connection
 * (migration 1064): one marked `subscription_connection_workspaces` row that
 * gives the connection to the Personal workspace of the person who connected
 * it in a shared workspace, and nobody else's.
 *
 * A marked row serves only while that person still belongs to the workspace
 * it came through. Suspension and offboarding delete those memberships, and
 * triggers delete the row as well; the readers check it anyway, as the
 * database routines do, so every reader agrees with `subscription_connection_visible`.
 */
import { sql, type SQL } from "drizzle-orm";

/** True for an ordinary assignment row, and for a marked one only while it is live. */
export function liveWorkspaceAssignment(alias: string): SQL {
  const column = (name: string) => sql`${sql.identifier(alias)}.${sql.identifier(name)}`;
  return sql`(${column("personal_reach_subject_id")} is null or exists (
    select 1 from workspace_memberships reach_member
    where reach_member.account_id = ${column("account_id")}
      and reach_member.workspace_id = ${column("personal_reach_via_workspace_id")}
      and reach_member.subject_id = ${column("personal_reach_subject_id")}))`;
}

/** A subject that may receive the reach: a managed human (`user:`), never a key or service principal. */
export function personalReachSubject(subjectId: string | null | undefined): subjectId is string {
  return typeof subjectId === "string" && subjectId.startsWith("user:");
}
