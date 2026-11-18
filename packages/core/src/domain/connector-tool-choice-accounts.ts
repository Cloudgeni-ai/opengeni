import { connectionAccountIdentityLabel } from "@opengeni/contracts/connection-account-label";
import {
  isNangoProviderDomain,
  sameConnectorProviderDomain,
  type ConnectionMetadata,
} from "@opengeni/contracts";
import {
  copyConnectorToolPermissionPolicies,
  listConnectorToolPermissionPolicies,
  type Database,
} from "@opengeni/db";
import { listOwnConnectionMetadata } from "./personal-connection-delegations";

/**
 * A person's tool choices belong to the provider account they signed in as,
 * not to the integration backend that holds its credential: the account's
 * connection under the native backend and under Nango share them, so
 * switching a connector's backend never resets "Ask first" or "Always allow"
 * (docs/nango.md). Tool ids are the same under both backends, because one
 * reviewed bridge serves both.
 */

type ChoiceConnection = Pick<
  ConnectionMetadata,
  "id" | "accountId" | "workspaceId" | "subjectId" | "providerDomain" | "kind" | "metadata"
>;

/** The account a connection verifiably signed in as; never a name its owner gave it. */
function verifiedAccountName(connection: ChoiceConnection): string | null {
  const name = connectionAccountIdentityLabel(connection.metadata, "").trim();
  return name ? name.toLowerCase() : null;
}

/**
 * The owner's connections of the same connector and verified provider account
 * under the other integration backend. An unverified account matches nothing.
 */
export function sameAccountOtherBackendConnections<T extends ConnectionMetadata>(
  connection: ChoiceConnection,
  owned: readonly T[],
): T[] {
  const name = verifiedAccountName(connection);
  if (!connection.subjectId || !name) return [];
  return owned.filter(
    (candidate) =>
      candidate.id !== connection.id &&
      candidate.accountId === connection.accountId &&
      candidate.subjectId === connection.subjectId &&
      candidate.kind === connection.kind &&
      (candidate.status === "active" || candidate.status === "needs_reauth") &&
      isNangoProviderDomain(candidate.providerDomain) !==
        isNangoProviderDomain(connection.providerDomain) &&
      sameConnectorProviderDomain(candidate.providerDomain, connection.providerDomain) &&
      verifiedAccountName(candidate) === name,
  );
}

async function counterparts(
  db: Database,
  connection: ChoiceConnection,
): Promise<ConnectionMetadata[]> {
  if (!connection.subjectId) return [];
  return sameAccountOtherBackendConnections(
    connection,
    await listOwnConnectionMetadata(db, {
      accountId: connection.accountId,
      workspaceId: connection.workspaceId,
      subjectId: connection.subjectId,
      reach: "anywhere",
      includeInactive: true,
    }),
  );
}

/**
 * Give a personal connection that has no tool choices yet the ones its
 * provider account already has under the other backend (the most recently
 * changed, if several). Idempotent: a connection with any choice keeps them.
 */
export async function carryConnectorToolChoices(
  db: Database,
  connection: ChoiceConnection,
): Promise<void> {
  if (!connection.subjectId) return;
  let newest: { connection: ConnectionMetadata; changedAt: number } | null = null;
  for (const candidate of await counterparts(db, connection)) {
    const rows = await listConnectorToolPermissionPolicies(db, {
      accountId: candidate.accountId,
      workspaceId: candidate.workspaceId,
      connectionId: candidate.id,
    });
    if (rows.length === 0) continue;
    const changedAt = Math.max(...rows.map((row) => row.updatedAt.getTime()));
    if (!newest || changedAt > newest.changedAt) newest = { connection: candidate, changedAt };
  }
  if (!newest) return;
  await copyConnectorToolPermissionPolicies(db, {
    accountId: connection.accountId,
    subjectId: connection.subjectId,
    from: { workspaceId: newest.connection.workspaceId, connectionId: newest.connection.id },
    to: { workspaceId: connection.workspaceId, connectionId: connection.id },
  });
}

/** After a change, the same provider account under the other backend gets the same choices. */
export async function mirrorConnectorToolChoices(
  db: Database,
  connection: ChoiceConnection,
  serverId: string,
): Promise<void> {
  if (!connection.subjectId) return;
  for (const candidate of await counterparts(db, connection))
    await copyConnectorToolPermissionPolicies(db, {
      accountId: connection.accountId,
      subjectId: connection.subjectId,
      from: { workspaceId: connection.workspaceId, connectionId: connection.id },
      to: { workspaceId: candidate.workspaceId, connectionId: candidate.id },
      serverId,
    });
}
