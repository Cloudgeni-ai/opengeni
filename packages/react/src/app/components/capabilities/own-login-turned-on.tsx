import type { ConnectionMetadata } from "@opengeni/sdk";
import type { ChatClient } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";

type OwnLoginClient = Pick<
  ChatClient<OpenGeniBrowserClient>,
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

/**
 * Turn your own logins on here: one account's connections, each once. The
 * same standing grant as `turnOnOwnLoginHere`. Tries every connection, then
 * reports the first failure.
 */
export async function turnOnOwnLoginsHere(
  client: OwnLoginClient,
  workspaceId: string,
  accounts: readonly Pick<ConnectionMetadata, "authorityId">[],
): Promise<void> {
  const authorities = new Map(
    accounts.flatMap((account) =>
      account.authorityId ? [[account.authorityId, account] as const] : [],
    ),
  );
  if (authorities.size === 0) throw new Error("This login isn't listed as yours yet. Try again.");
  const failures: unknown[] = [];
  for (const account of authorities.values()) {
    try {
      await turnOnOwnLoginHere(client, workspaceId, account);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}

/**
 * Turn your own logins off here: every standing grant behind them, once
 * each. One account connected twice has two connections, and turning it off leaves
 * neither on. Tries every grant, then reports the first failure.
 */
export async function stopOwnLoginsHere(
  client: OwnLoginClient,
  workspaceId: string,
  accounts: readonly Pick<ConnectionMetadata, "turnedOnHereGrantId">[],
): Promise<void> {
  const grantIds = new Set(
    accounts.flatMap((account) =>
      account.turnedOnHereGrantId ? [account.turnedOnHereGrantId] : [],
    ),
  );
  // Nothing to take back: it is on from where it was added, not by a grant here.
  if (grantIds.size === 0) throw new Error("This login can't be turned off here.");
  const failures: unknown[] = [];
  for (const grantId of grantIds) {
    try {
      await client.revokeUserResourceGrant(workspaceId, grantId);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
