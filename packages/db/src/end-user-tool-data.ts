/**
 * Erasing what Console agents keep about one end user (an `external_user:`
 * subject): their stored tool logins (`end_user_tool_credentials`) and the
 * display name and email the product sent (`organization_end_user_profiles`).
 *
 * Called inside the membership lifecycle transactions: removing the end user
 * from a workspace deletes their logins there; offboarding them from the
 * organization deletes their logins everywhere and their profile. Each
 * deletion is recorded in the Console audit log.
 */
import { sql } from "drizzle-orm";
import { insertConsoleAuditEvent } from "./console";
import { rawRows, withRlsContext, type Database } from "./database";

export type EndUserToolDataErasure = {
  removedLogins: number;
  profileRemoved: boolean;
};

export async function eraseEndUserToolData(
  tx: Database,
  input: {
    accountId: string;
    subjectId: string;
    /** One workspace's logins, or null for every workspace of the organization. */
    workspaceId: string | null;
    /** Also delete the organization-wide display profile. */
    includeProfile: boolean;
    actorSubjectId: string;
    reason: "workspace_member_removed" | "organization_member_offboarded";
  },
): Promise<EndUserToolDataErasure> {
  if (!input.subjectId.startsWith("external_user:")) {
    return { removedLogins: 0, profileRemoved: false };
  }
  // The account context sees every workspace's logins of the organization
  // (1503 policy); a workspace context only its own.
  const removedLogins = await withRlsContext(
    tx,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scoped) =>
      (
        await rawRows<{ id: string }>(
          scoped,
          sql`delete from end_user_tool_credentials
            where account_id = ${input.accountId}::uuid
              and end_user_subject_id = ${input.subjectId}
              ${input.workspaceId === null ? sql`` : sql`and workspace_id = ${input.workspaceId}::uuid`}
            returning id::text as id`,
        )
      ).length,
  );
  const profileRemoved = input.includeProfile
    ? await withRlsContext(
        tx,
        { accountId: input.accountId, workspaceId: null },
        async (scoped) =>
          (
            await rawRows<{ subject_id: string }>(
              scoped,
              sql`delete from organization_end_user_profiles
                where account_id = ${input.accountId}::uuid
                  and subject_id = ${input.subjectId}
                returning subject_id`,
            )
          ).length > 0,
      )
    : false;
  if (removedLogins > 0 || profileRemoved) {
    await withRlsContext(tx, { accountId: input.accountId, workspaceId: null }, (scoped) =>
      insertConsoleAuditEvent(scoped, {
        accountId: input.accountId,
        actorSubjectId: input.actorSubjectId,
        actorLabel: null,
        action: "tool_credential.deleted",
        workspaceId: input.workspaceId,
        sessionId: null,
        detail: {
          endUserSubjectId: input.subjectId,
          reason: input.reason,
          removedLogins,
          profileRemoved,
        },
      }),
    );
  }
  return { removedLogins, profileRemoved };
}
