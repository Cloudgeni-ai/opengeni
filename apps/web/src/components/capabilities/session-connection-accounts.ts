import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  McpConnectionAccountSelection,
  Session,
} from "@opengeni/sdk";

import { normalizeProviderDomain } from "@/lib/capabilities";

function personalConnections(item: CapabilityCatalogItem, connections: ConnectionMetadata[]) {
  const ref = item.connectionRef;
  if (ref?.subjectScope !== "subject") return [];
  // The shared catalog deliberately omits personal IDs. Resolve only against
  // the authenticated owner's private metadata, never store that ID in catalog.
  const matches = connections.filter(
    (entry) =>
      entry.subjectId !== null &&
      entry.authorityId != null &&
      entry.status === "active" &&
      (!ref.kind || entry.kind === ref.kind) &&
      (!ref.connectionId || entry.id === ref.connectionId) &&
      normalizeProviderDomain(entry.providerDomain) === normalizeProviderDomain(ref.providerDomain),
  );
  return matches;
}

export type ConnectedAccountGroup = {
  serverId: string;
  name: string;
  accounts: ConnectionMetadata[];
};

export async function sessionConnectedAccounts(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  items: CapabilityCatalogItem[],
  knownConnections?: ConnectionMetadata[],
): Promise<ConnectedAccountGroup[]> {
  const personal = items.filter(
    (item) =>
      item.enabled && item.connectionRef?.subjectScope === "subject" && item.runtime.mcpServerId,
  );
  if (personal.length === 0) return [];
  const connections = knownConnections ?? (await client.listOwnConnectionAccounts(workspaceId));
  return personal.map((item) => ({
    serverId: item.runtime.mcpServerId!,
    name: item.name,
    accounts: personalConnections(item, connections),
  }));
}

export function selectedConnectionAccounts(
  groups: ConnectedAccountGroup[],
  choices: Record<string, string>,
): { selections: McpConnectionAccountSelection[]; unresolved: ConnectedAccountGroup[] } {
  const selections: McpConnectionAccountSelection[] = [];
  const unresolved: ConnectedAccountGroup[] = [];
  for (const group of groups) {
    const chosen = choices[group.serverId];
    const account = chosen
      ? group.accounts.find((candidate) => candidate.id === chosen)
      : group.accounts.length === 1
        ? group.accounts[0]
        : undefined;
    if (account) selections.push({ serverId: group.serverId, connectionId: account.id });
    else if (group.accounts.length > 1 || chosen) unresolved.push(group);
  }
  return { selections, unresolved };
}

export async function sessionConnectionAccounts(
  client: OpenGeniBrowserClient,
  session: Pick<Session, "id" | "workspaceId">,
  items: CapabilityCatalogItem[],
  knownConnections?: ConnectionMetadata[],
): Promise<McpConnectionAccountSelection[]> {
  const groups = await sessionConnectedAccounts(
    client,
    session.workspaceId,
    items,
    knownConnections,
  );
  const { selections, unresolved } = selectedConnectionAccounts(groups, {});
  if (unresolved.length)
    throw new Error(`Choose an account for ${unresolved[0]!.name} before sending.`);
  return selections;
}
