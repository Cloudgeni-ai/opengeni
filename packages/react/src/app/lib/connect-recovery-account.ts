import type { ConnectionMetadata } from "../types";

/**
 * A connect account to recover and the workspace whose Connect owns it.
 * `via`: `native` reconnects that exact account through a connect attempt;
 * `connector` (an account held by an integration platform) signs in again
 * through its connector's own Connect, never a native attempt.
 */
export type ConnectRecoveryTarget<Account> = {
  account: Account;
  workspaceId: string;
  via: "native" | "connector";
};

/**
 * The exact account a chat notice names, for a reconnect or a step-up. An
 * account of this workspace is recovered here. A person's own account added in
 * another workspace and turned on here ("Use it here") belongs to that
 * workspace, whose Connect reconnects it: the person's own account inventory
 * (the one connection health reads) says which workspace that is. Each read
 * is authorized by the API as usual; null when the account is not found.
 */
export async function findConnectRecoveryTarget<
  Account extends { backend?: string | undefined },
>(input: {
  workspaceId: string;
  connectionId: string;
  /** `GET /connect/accounts` for one workspace. */
  accounts: (workspaceId: string) => Promise<readonly Account[]>;
  /** The person's own account inventory here (`listOwnConnectionAccounts`). */
  ownAccounts: () => Promise<readonly ConnectionMetadata[]>;
  find: (accounts: readonly Account[], connectionId: string) => Account | null;
}): Promise<ConnectRecoveryTarget<Account> | null> {
  const here = input.find(await input.accounts(input.workspaceId), input.connectionId);
  if (here) return target(here, input.workspaceId);
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
  return elsewhere ? target(elsewhere, own.workspaceId) : null;
}

function target<Account extends { backend?: string | undefined }>(
  account: Account,
  workspaceId: string,
): ConnectRecoveryTarget<Account> {
  return { account, workspaceId, via: account.backend ? "connector" : "native" };
}
