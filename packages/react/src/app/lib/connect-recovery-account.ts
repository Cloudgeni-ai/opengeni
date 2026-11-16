import type { ConnectionMetadata } from "../types";

/** A connect account to recover and the workspace whose Connect owns it. */
export type ConnectRecoveryTarget<Account> = { account: Account; workspaceId: string };

/**
 * The exact account a chat notice names, for a reconnect or a step-up. An
 * account of this workspace is recovered here. A person's own account added in
 * another workspace and turned on here ("Use it here") belongs to that
 * workspace, whose Connect reconnects it: the person's own account inventory
 * (the one connection health reads) says which workspace that is. Each read
 * is authorized by the API as usual; null when the account is not found.
 */
export async function findConnectRecoveryTarget<Account>(input: {
  workspaceId: string;
  connectionId: string;
  /** `GET /connect/accounts` for one workspace. */
  accounts: (workspaceId: string) => Promise<readonly Account[]>;
  /** The person's own account inventory here (`listOwnConnectionAccounts`). */
  ownAccounts: () => Promise<readonly ConnectionMetadata[]>;
  find: (accounts: readonly Account[], connectionId: string) => Account | null;
}): Promise<ConnectRecoveryTarget<Account> | null> {
  const here = input.find(await input.accounts(input.workspaceId), input.connectionId);
  if (here) return { account: here, workspaceId: input.workspaceId };
  const own = (await input.ownAccounts().catch(() => [])).find(
    (connection) =>
      connection.id === input.connectionId &&
      connection.subjectId !== null &&
      connection.workspaceId !== input.workspaceId,
  );
  if (!own) return null;
  const elsewhere = input.find(
    await input.accounts(own.workspaceId).catch(() => []),
    input.connectionId,
  );
  return elsewhere ? { account: elsewhere, workspaceId: own.workspaceId } : null;
}
