import { sql } from "drizzle-orm";
import { rawRows, type Database } from "./database";
import { PERSONAL_WORKSPACE_EXTERNAL_SOURCE } from "./personal-workspace-membership";

/**
 * The model account settings of a Personal workspace belong to its owner
 * (migration 1233): the owner, acting as themselves, may change what the
 * organization has not locked, as a shared workspace's administrators can.
 *
 * The database admits the owner's write only in a transaction that declared
 * the owner here. Declare it only after the API verified the owner acting as
 * themselves (`workspaceSettingsAuthorized`): the owner's membership row alone
 * admits whoever names the owner's subject, a delegated bearer included.
 */
export type PersonalWorkspaceOwnerSettingsInput = {
  /** The request verified the Personal workspace's owner acting as themselves. */
  personalWorkspaceOwnerVerified?: boolean | undefined;
};

/** Declare, for this transaction, that `subjectId` is the verified owner (see above). */
export async function declarePersonalWorkspaceOwnerSettings(
  tx: Database,
  input: { subjectId: string } & PersonalWorkspaceOwnerSettingsInput,
): Promise<void> {
  if (input.personalWorkspaceOwnerVerified !== true) return;
  await rawRows(
    tx,
    sql`select set_config('opengeni.personal_workspace_owner_settings', ${input.subjectId}, true)`,
  );
}

/**
 * Whether the subject is this Personal workspace's owner with their owner row
 * (1231), and the request verified them. False for anyone else, for a
 * Personal workspace without an owner row (local and external-user ones) and
 * for any workspace that isn't Personal.
 */
export async function personalWorkspaceOwnerMayChangeSettings(
  tx: Database,
  input: {
    accountId: string;
    workspaceId: string;
    subjectId: string;
  } & PersonalWorkspaceOwnerSettingsInput,
): Promise<boolean> {
  if (input.personalWorkspaceOwnerVerified !== true) return false;
  const [row] = await rawRows<{ owner: boolean }>(
    tx,
    sql`select exists (
        select 1 from workspaces personal
        join workspace_memberships owner_row
          on owner_row.workspace_id = personal.id and owner_row.account_id = personal.account_id
        where personal.id = ${input.workspaceId}::uuid
          and personal.account_id = ${input.accountId}::uuid
          and personal.external_source = ${PERSONAL_WORKSPACE_EXTERNAL_SOURCE}
          and personal.external_id = personal.account_id::text || ':' || owner_row.subject_id
          and owner_row.subject_id = ${input.subjectId}
      ) as owner`,
  );
  return row?.owner === true;
}
