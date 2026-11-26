import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { ChatClient } from "@opengeni/sdk";
import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  McpConnectionAccountSelection,
  McpServerConnectionRef,
  ChatSession as Session,
} from "@opengeni/sdk";

import { sameConnectorProviderDomain } from "@opengeni/contracts/nango";

function canonicalResource(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

/** Credential-free projection of the backend-authorized inventory, including inactive accounts. */
export function matchingConnectionAccounts(
  ref: NativeConnectorAccountRef["connectionRef"] | null | undefined,
  connections: readonly ConnectionMetadata[],
  endpoint?: string | null,
) {
  if (!ref || ref.authoritySource === "host") return [];
  // Inventory is authorized by the backend. This projection is not a grant,
  // and must never synthesize accounts from shared catalog metadata.
  const matches = connections.filter(
    (entry) =>
      (entry.subjectId === null || entry.authorityId != null) &&
      (!ref.kind || entry.kind === ref.kind) &&
      (ref.connectionId === undefined || entry.id === ref.connectionId) &&
      (!ref.resource ||
        (typeof entry.metadata?.resource === "string" &&
          canonicalResource(entry.metadata.resource) === canonicalResource(ref.resource))) &&
      // An OAuth audience can differ from the transport endpoint. Compare a
      // saved endpoint only to the catalog endpoint, not to its resource.
      (!endpoint ||
        typeof entry.metadata?.mcpUrl !== "string" ||
        canonicalResource(entry.metadata.mcpUrl) === canonicalResource(endpoint)) &&
      // Either backend's account counts for its connector (native or Nango).
      sameConnectorProviderDomain(entry.providerDomain, ref.providerDomain),
  );
  return matches;
}

export type ConnectedAccountGroup = {
  serverId: string;
  name: string;
  /** Includes accounts that stopped working (`status` not "active"); see `isLapsedAccount`. */
  accounts: ConnectionMetadata[];
};

/** An account that stopped working (for example its sign-in expired) and needs reconnecting. */
export function isLapsedAccount(account: Pick<ConnectionMetadata, "status">): boolean {
  return (
    account.status === "needs_reauth" || account.status === "revoked" || account.status === "error"
  );
}

/** The accounts a connector uses when the person made no choice: every working one. */
export function defaultConnectionAccountIds(group: ConnectedAccountGroup): string[] {
  return group.accounts.filter((account) => !isLapsedAccount(account)).map((account) => account.id);
}

/**
 * The first account the connector would send that stopped working: an
 * explicit pick that lapsed, or, with no choice, the only accounts it has.
 */
export function lapsedConnectionAccount(
  group: ConnectedAccountGroup | undefined,
  chosen: readonly string[] | undefined,
): ConnectionMetadata | null {
  if (!group) return null;
  const lapsed = group.accounts.filter(isLapsedAccount);
  if (lapsed.length === 0) return null;
  if (chosen !== undefined) return lapsed.find((account) => chosen.includes(account.id)) ?? null;
  return defaultConnectionAccountIds(group).length === 0 ? lapsed[0]! : null;
}

/** Missing key follows eligible defaults; an array is an exact, explicit set. */
export type ConnectionAccountChoices = Record<string, string[]>;

export type NativeConnectorAccountRef = {
  serverId: string;
  name: string;
  connectionRef: Pick<
    McpServerConnectionRef,
    | "connectionId"
    | "authoritySource"
    | "providerDomain"
    | "subjectScope"
    | "resource"
    | "selectedResources"
  > & { kind?: string | undefined };
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
    for (const account of matchingConnectionAccounts(ref.connectionRef, connections).filter(
      // Your own login works here only where you turned it on (D-54). An
      // account that stopped working stays listed so a pick of it shows as
      // needing reconnecting rather than vanishing.
      (entry) => entry.turnedOnHere !== false,
    )) {
      if (!group.accounts.some((existing) => existing.id === account.id))
        group.accounts.push(account);
    }
    groups.set(serverId, group);
  }
  return [...groups.values()];
}

export async function sessionConnectedAccounts(
  client: ChatClient<OpenGeniBrowserClient>,
  workspaceId: string,
  items: CapabilityCatalogItem[],
  knownConnections?: ConnectionMetadata[],
  /** How to read the accounts when none are known; a plain read by default. */
  loadConnections: () => Promise<ConnectionMetadata[]> = async () =>
    await client.listOwnConnectionAccounts(workspaceId, { includeInactive: true }),
): Promise<ConnectedAccountGroup[]> {
  const native = selectedNativeConnectorRefs(items);
  if (native.length === 0) return [];
  const connections = knownConnections ?? (await loadConnections());
  return connectedAccountGroups(native, connections);
}

export function selectedConnectionAccounts(
  groups: ConnectedAccountGroup[],
  choices: ConnectionAccountChoices,
): { selections: McpConnectionAccountSelection[]; unresolved: ConnectedAccountGroup[] } {
  const selections: McpConnectionAccountSelection[] = [];
  const unresolved: ConnectedAccountGroup[] = [];
  for (const group of groups) {
    // A workspace default can name a connector the sender has never connected
    // (or whose accounts all stopped working). No working account means no
    // access, not an account choice to resolve.
    const defaults = defaultConnectionAccountIds(group);
    if (choices[group.serverId] === undefined && defaults.length === 0) continue;
    const chosen = choices[group.serverId] ?? defaults;
    // Until an explicit empty-set wire representation exists, fail closed:
    // never submit an omission that the backend might interpret as defaults.
    // A pick that stopped working is still sent as picked: the server leaves
    // it out without widening, and the connector shows "Reconnect required".
    // Only an empty choice, or a pick no longer listed at all, needs review.
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
  client: ChatClient<OpenGeniBrowserClient>,
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
