/**
 * Codex connect and disconnect on the shared subscription core (M3 PR 3b),
 * under the names and shapes M3 shipped. The writers themselves are
 * provider-neutral (`subscription-core/connections`); this module supplies
 * Codex as data and maps Codex's sign-in facts (the FedRAMP routing flag)
 * into the connection's provider state.
 *
 * API handlers reach this module only for the `core` cutover disposition, and
 * every write also rechecks the enabled cutover in the database. Nothing here
 * reads or writes a legacy Codex table.
 */
import type { Database } from "./database";
import {
  connectSubscriptionCoreConnection,
  disconnectAllSubscriptionCoreConnections,
  disconnectSubscriptionCoreConnection,
  type SubscriptionCoreConnectRefusal,
  type SubscriptionCoreConnectScope,
  type SubscriptionCoreDisconnectOutcome,
} from "./subscription-core/connections";
import { SUBSCRIPTION_CORE_CODEX } from "./subscription-core-codex-adapter";
import type { SubscriptionCoreCodexWake } from "./subscription-core-codex-compat";

export { SubscriptionCoreCodexOrganizationManagedError } from "./subscription-core-codex-errors";

export type SubscriptionCoreCodexCredentialInput = {
  /** v1 envelope of JSON {access_token, refresh_token, id_token}. */
  credentialEncrypted: string;
  providerAccountId: string | null;
  /**
   * The signed-in person within the upstream account (the id_token's ChatGPT
   * user). Two people's logins of one ChatGPT workspace are distinct shared
   * connections; only the same person's login reconnects in place.
   */
  providerSubjectId: string | null;
  planType: string | null;
  isFedramp: boolean;
  expiresAt: Date | null;
  lastRefreshAt: Date | null;
  accountEmail: string | null;
  label: string | null;
  /** Verified managed-browser human, never inferred from a grant's spelling. */
  connectedBySubjectId?: string | null;
};

export type SubscriptionCoreCodexConnectRefusal = SubscriptionCoreConnectRefusal;

export type SubscriptionCoreCodexConnectResult =
  | {
      kind: "connected";
      id: string;
      isNew: boolean;
      ownership: "shared" | "personal";
      wake: SubscriptionCoreCodexWake;
    }
  | { kind: "refused"; reason: SubscriptionCoreCodexConnectRefusal };

/**
 * Connect (or reconnect) one Codex account from a device-code sign-in. The
 * caller delivers `wake` after commit.
 */
export async function connectSubscriptionCoreCodexConnection(
  db: Database,
  input: SubscriptionCoreConnectScope & SubscriptionCoreCodexCredentialInput,
): Promise<SubscriptionCoreCodexConnectResult> {
  const { isFedramp, ...rest } = input;
  return await connectSubscriptionCoreConnection(db, SUBSCRIPTION_CORE_CODEX, {
    ...rest,
    // The FedRAMP routing flag is Codex provider state (absent means false).
    providerState: isFedramp ? { isFedramp: true } : {},
  });
}

export type SubscriptionCoreCodexDisconnectOutcome = SubscriptionCoreDisconnectOutcome;

export type SubscriptionCoreCodexDisconnectResult = {
  outcome: SubscriptionCoreCodexDisconnectOutcome;
  /** The canonical connection, when the route id resolved. */
  connectionId: string | null;
  /** Workspaces whose Apps designation the removal cleared (for audit). */
  clearedAppsWorkspaceIds: string[];
  wake: SubscriptionCoreCodexWake | null;
};

/**
 * Disconnect one Codex account. Throws `SubscriptionCoreCodexOrganizationManagedError`
 * for an organization account named from a workspace route. The caller
 * delivers `wake` after commit.
 */
export async function disconnectSubscriptionCoreCodexConnection(
  db: Database,
  input: SubscriptionCoreConnectScope & { connectionId: string },
): Promise<SubscriptionCoreCodexDisconnectResult> {
  return await disconnectSubscriptionCoreConnection(db, SUBSCRIPTION_CORE_CODEX, input);
}

/**
 * The legacy workspace "disconnect all": every account this workspace manages
 * (or, in a person's own Personal workspace, their personal connections),
 * atomically. Any refusal leaves everything connected.
 */
export async function disconnectAllSubscriptionCoreCodexConnections(
  db: Database,
  input: SubscriptionCoreConnectScope & { workspaceId: string },
): Promise<{
  removed: number;
  refused: {
    outcome: Exclude<SubscriptionCoreCodexDisconnectOutcome, "removed" | "not_found">;
    connectionIds: string[];
  } | null;
  clearedAppsWorkspaceIds: string[];
  wake: SubscriptionCoreCodexWake | null;
}> {
  return await disconnectAllSubscriptionCoreConnections(db, SUBSCRIPTION_CORE_CODEX, input);
}
