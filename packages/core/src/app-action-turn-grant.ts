import { Permission, type AccessGrant } from "@opengeni/contracts";
import type { TurnAppActionGrant } from "@opengeni/db";
import { hasLiteralPermission, hasPermission, type AccessGrantAuthorization } from "./access";

/**
 * What a message's turn may do through app actions, frozen when the message
 * is accepted (see resolveSessionAppActionAuthority):
 *
 * - Only a person's own message gets one; agents, API keys and services get
 *   none, so their turns run no app actions.
 * - Changes wait for that person's confirmation in the chat only when they
 *   sent the message signed in to the app itself. Any other accepted person
 *   sign-in is delegated (an embed's host-issued token, an external user,
 *   another integration's person token): someone else vouches for who the
 *   person is, so changes stay off unless the deployment turned on
 *   delegated-sign-in changes, which covers all of them; reads still work.
 * - It never carries more than the request itself could do: the workspace
 *   grant and, for organization-level actions, the account grant it was
 *   resolved with, plus `workspace:admin` exactly when that request could
 *   change this workspace's settings (`workspaceSettings`, from
 *   workspaceSettingsAuthorized): a Personal workspace's owner holds no
 *   admin grant there, but configures it like one, and so does their chat.
 */
export function turnAppActionGrant(input: {
  grant: AccessGrant;
  authorization?: AccessGrantAuthorization | null | undefined;
  delegatedSignInChangesEnabled: boolean;
  /** workspaceSettingsAuthorized for this same request and its workspace. */
  workspaceSettings: boolean;
}): TurnAppActionGrant | null {
  const { grant, authorization } = input;
  const metadata = grant.metadata ?? {};
  if (
    grant.principalKind !== "human_session" ||
    grant.serviceInitiator ||
    grant.serviceInitiatorContext ||
    metadata.turnId !== undefined ||
    metadata.attemptId !== undefined ||
    !authorization?.contextIntegrity ||
    authorization.grant.subjectId !== grant.subjectId ||
    authorization.grant.workspaceId !== grant.workspaceId
  ) {
    return null;
  }
  const signedIn =
    authorization.canonicalManagedHumanSession || authorization.canonicalLocalHumanSession;
  const account = authorization.accountGrant;
  return {
    subjectId: grant.subjectId,
    changes: signedIn || input.delegatedSignInChangesEnabled ? "confirm" : "none",
    permissions: Permission.options.filter(
      (permission) =>
        hasPermission(grant.permissions, permission, grant.permissionMode) ||
        (account !== null &&
          account.accountId === grant.accountId &&
          hasLiteralPermission(account.permissions, permission)) ||
        (permission === "workspace:admin" && input.workspaceSettings),
    ),
  };
}
