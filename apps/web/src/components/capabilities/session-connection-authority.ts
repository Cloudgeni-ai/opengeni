import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type {
  CapabilityCatalogItem,
  ConnectionMetadata,
  McpConnectionAuthoritySelection,
  Session,
  UserResourceAuthoritySummary,
} from "@opengeni/sdk";

import { normalizeProviderDomain } from "@/lib/capabilities";

function personalConnection(item: CapabilityCatalogItem, connections: ConnectionMetadata[]) {
  const ref = item.connectionRef;
  if (ref?.subjectScope !== "subject") return undefined;
  // The shared catalog deliberately omits personal IDs. Resolve only against
  // the authenticated owner's private metadata, never store that ID in catalog.
  const matches = connections.filter(
    (entry) =>
      entry.subjectId !== null &&
      entry.status === "active" &&
      entry.kind === ref.kind &&
      normalizeProviderDomain(entry.providerDomain) === normalizeProviderDomain(ref.providerDomain),
  );
  if (matches.length > 1)
    throw new Error(
      "More than one personal account matches this integration. Review its connection settings before continuing.",
    );
  return matches[0];
}

export async function sessionConnectionAuthorities(
  client: OpenGeniBrowserClient,
  session: Pick<Session, "id" | "workspaceId" | "tenancy">,
  items: CapabilityCatalogItem[],
  knownConnections?: ConnectionMetadata[],
): Promise<McpConnectionAuthoritySelection[]> {
  const personal = items.filter(
    (item) =>
      item.enabled && item.connectionRef?.subjectScope === "subject" && item.runtime.mcpServerId,
  );
  if (personal.length === 0) return [];
  const connections = knownConnections ?? (await client.listConnections(session.workspaceId));
  if (!session.tenancy) throw new Error("Conversation sharing authority is not available.");
  const authorityEpoch = session.tenancy.authorityEpoch;
  const visibility =
    session.tenancy.visibility === "workspace" ? "workspace_shared" : "user_private";
  const authorities: UserResourceAuthoritySummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listUserResourceAuthorities(session.workspaceId, {
      resourceKind: "connection",
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    authorities.push(...page.authorities);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return personal.flatMap((item) => {
    const connection = personalConnection(item, connections);
    if (!connection?.authorityId) return [];
    const authority = authorities.find(
      (entry) =>
        entry.resourceId === connection.id &&
        entry.authorityId === connection.authorityId &&
        entry.status === "active",
    );
    // Only an exact-session grant is adopted here. A standing grant from another
    // surface never silently opts a personal account into this conversation.
    const grant = authority?.grants.find(
      (entry) =>
        entry.mode === "session" &&
        entry.status === "active" &&
        entry.action === "connection.use" &&
        entry.targetSessionId === session.id &&
        entry.targetWorkspaceId === session.workspaceId &&
        entry.authorityEpoch === authorityEpoch &&
        entry.context === visibility &&
        (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()),
    );
    return grant
      ? [
          {
            serverId: item.runtime.mcpServerId!,
            connectionId: connection.id,
            userDelegation: grant.delegation,
          },
        ]
      : [];
  });
}

/** Called only by the human's explicit Use-in-this-conversation action. */
export async function authorizeSessionPersonalConnection(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  sessionId: string,
  item: CapabilityCatalogItem,
  reviewedVisibility: "private" | "workspace",
  sharedOutputAcknowledged: boolean,
  stillCurrent: () => boolean,
): Promise<void> {
  const ref = item.connectionRef;
  if (ref?.subjectScope !== "subject" || !item.runtime.mcpServerId)
    throw new Error("The personal connection could not be resolved. Refresh and retry.");
  const [session, connections] = await Promise.all([
    client.getSession(workspaceId, sessionId),
    client.listConnections(workspaceId),
  ]);
  if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
  if (!session.tenancy || session.tenancy.visibility !== reviewedVisibility)
    throw new Error(
      "The conversation's visibility changed. Close and review the connection again.",
    );
  if (session.tenancy.visibility === "workspace" && !sharedOutputAcknowledged)
    throw new Error("Acknowledge shared results before using your personal account here.");
  const connection = personalConnection(item, connections);
  if (!connection?.authorityId)
    throw new Error(
      "This personal connection has no active sharing authority. Reconnect it and try again.",
    );
  const existing = await sessionConnectionAuthorities(client, session, [item], connections);
  if (!stillCurrent()) throw new Error("Connection setup was interrupted.");
  if (existing.some((entry) => entry.connectionId === connection.id)) return;
  await client.issueUserResourceGrant(workspaceId, connection.authorityId, {
    scope: "user",
    resourceKind: "connection",
    mode: "session",
    sessionId,
    expectedAuthorityEpoch: session.tenancy.authorityEpoch,
    context: session.tenancy.visibility === "workspace" ? "workspace_shared" : "user_private",
    workspaceSharedAcknowledged:
      session.tenancy.visibility === "workspace" && sharedOutputAcknowledged,
  });
}
