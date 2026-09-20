import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  McpConnectionAccountSelection,
  McpServerConnectionRef,
  Session,
} from "@opengeni/sdk";

import { normalizeProviderDomain } from "@/lib/capabilities";

function eligibleConnections(
  ref: NativeConnectorAccountRef["connectionRef"],
  connections: readonly ConnectionMetadata[],
) {
  if (!ref || ref.authoritySource === "host") return [];
  // Inventory is authorized by the backend. This projection is not a grant,
  // and must never synthesize accounts from shared catalog metadata.
  const matches = connections.filter(
    (entry) =>
      (entry.subjectId === null || entry.authorityId != null) &&
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

/** Missing key follows eligible defaults; an array is an exact, explicit set. */
export type ConnectionAccountChoices = Record<string, string[]>;

export type NativeConnectorAccountRef = {
  serverId: string;
  name: string;
  connectionRef: Pick<
    McpServerConnectionRef,
    "connectionId" | "authoritySource" | "providerDomain" | "subjectScope"
  > & { kind?: string };
};

export function selectedNativeConnectorRefs(
  items: readonly CapabilityCatalogItem[],
): NativeConnectorAccountRef[] {
  return items.flatMap((item) =>
    item.enabled &&
    item.runtime.mcpServerId &&
    item.connectionRef &&
    item.connectionRef.authoritySource !== "host"
      ? [{ serverId: item.runtime.mcpServerId, name: item.name, connectionRef: item.connectionRef }]
      : [],
  );
}

export function connectionAccountChoices(selections: McpConnectionAccountSelection[]) {
  const choices: ConnectionAccountChoices = {};
  for (const { serverId, connectionId } of selections) {
    const ids = (choices[serverId] ??= []);
    if (!ids.includes(connectionId)) ids.push(connectionId);
  }
  return choices;
}

export function connectedAccountGroups(
  refs: readonly NativeConnectorAccountRef[],
  connections: readonly ConnectionMetadata[],
): ConnectedAccountGroup[] {
  const groups = new Map<string, ConnectedAccountGroup>();
  for (const ref of refs) {
    if (ref.connectionRef.authoritySource === "host") continue;
    const serverId = ref.serverId;
    const group = groups.get(serverId) ?? { serverId, name: ref.name, accounts: [] };
    for (const account of eligibleConnections(ref.connectionRef, connections)) {
      if (!group.accounts.some((existing) => existing.id === account.id))
        group.accounts.push(account);
    }
    groups.set(serverId, group);
  }
  return [...groups.values()];
}

export async function sessionConnectedAccounts(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  items: CapabilityCatalogItem[],
  knownConnections?: ConnectionMetadata[],
): Promise<ConnectedAccountGroup[]> {
  const native = selectedNativeConnectorRefs(items);
  if (native.length === 0) return [];
  const connections = knownConnections ?? (await client.listOwnConnectionAccounts(workspaceId));
  return connectedAccountGroups(native, connections);
}

export function selectedConnectionAccounts(
  groups: ConnectedAccountGroup[],
  choices: ConnectionAccountChoices,
): { selections: McpConnectionAccountSelection[]; unresolved: ConnectedAccountGroup[] } {
  const selections: McpConnectionAccountSelection[] = [];
  const unresolved: ConnectedAccountGroup[] = [];
  for (const group of groups) {
    const chosen = choices[group.serverId] ?? group.accounts.map((account) => account.id);
    // Until an explicit empty-set wire representation exists, fail closed:
    // never submit an omission that the backend might interpret as defaults.
    if (
      !chosen.length ||
      chosen.some((id) => !group.accounts.some((account) => account.id === id))
    ) {
      unresolved.push(group);
      continue;
    }
    for (const connectionId of new Set(chosen))
      selections.push({ serverId: group.serverId, connectionId });
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
    throw new Error(`Check accounts for ${unresolved[0]!.name} before sending.`);
  return selections;
}
