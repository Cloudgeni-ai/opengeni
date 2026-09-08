import type { ConnectAccount } from "./types";

/** A provider/domain match is not account identity. Never silently substitute
 * another account when the original connection has disappeared. */
export function findConnectRecoveryAccount(
  accounts: readonly ConnectAccount[],
  connectionId: string | null | undefined,
): ConnectAccount | null {
  if (!connectionId) return null;
  const matches = accounts.filter(
    (account) => account.id === connectionId || account.id === `social:${connectionId}`,
  );
  if (matches.length > 1)
    throw new Error("Connection recovery is ambiguous; choose the exact account.");
  return matches[0] ?? null;
}
