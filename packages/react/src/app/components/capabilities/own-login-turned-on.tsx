import type { ConnectionMetadata } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

type OwnLoginClient = Pick<
  OpenGeniBrowserClient,
  "issueUserResourceGrant" | "revokeUserResourceGrant"
>;

/**
 * Your own login (an "Only me" account) works for your messages in your
 * Personal workspace and in each shared workspace where it is turned on
 * (D-54). It starts on where you added it. Turning it on here is your
 * standing grant for this workspace, never a per-chat approval.
 */
export function ownLoginOffHere(account: Pick<ConnectionMetadata, "subjectId" | "turnedOnHere">) {
  return account.subjectId !== null && account.turnedOnHere === false;
}

/** Whether this own login can be turned off here: on by a standing grant. */
export function ownLoginCanStopHere(
  account: Pick<ConnectionMetadata, "subjectId" | "turnedOnHere" | "turnedOnHereGrantId">,
) {
  return (
    account.subjectId !== null && account.turnedOnHere === true && !!account.turnedOnHereGrantId
  );
}

export async function turnOnOwnLoginHere(
  client: OwnLoginClient,
  workspaceId: string,
  account: Pick<ConnectionMetadata, "authorityId">,
): Promise<string> {
  if (!account.authorityId) throw new Error("This login isn't listed as yours yet. Try again.");
  const issued = await client.issueUserResourceGrant(workspaceId, account.authorityId, {
    scope: "user",
    resourceKind: "connection",
    mode: "always",
    context: "workspace_shared",
    workspaceSharedAcknowledged: true,
  });
  return issued.grant.grantId;
}

export async function stopOwnLoginHere(
  client: OwnLoginClient,
  workspaceId: string,
  account: Pick<ConnectionMetadata, "turnedOnHereGrantId">,
): Promise<void> {
  if (!account.turnedOnHereGrantId) return;
  await client.revokeUserResourceGrant(workspaceId, account.turnedOnHereGrantId);
}
