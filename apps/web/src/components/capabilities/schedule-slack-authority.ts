import { attachSessionCapability } from "./attach-session-capability";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import type { CapabilityCatalogItem, McpConnectionAuthoritySelection } from "@opengeni/sdk";
import type { ScheduledTaskFormState } from "@/lib/scheduled-tasks";
import {
  authorizeSessionPersonalConnection,
  sessionConnectionAuthorities,
} from "./session-connection-authority";

/** Only invoked by the authenticated human's explicit schedule submission. */
export async function authorizeScheduledSlack(
  client: OpenGeniBrowserClient,
  workspaceId: string,
  form: ScheduledTaskFormState,
  catalog: CapabilityCatalogItem[],
  stillCurrent: () => boolean,
): Promise<{
  connectionAuthorities: McpConnectionAuthoritySelection[];
  serverId: string;
} | null> {
  const check = () => {
    if (!stillCurrent()) throw new Error("Schedule setup was interrupted. Review and retry.");
  };
  check();
  if (!form.personalSlackCapabilityId) return null;
  if (form.existingPersonalConnections?.length)
    throw new Error(
      "This schedule already has personal access. Create a separate schedule to authorize another account without replacing its existing access.",
    );
  if (!form.personalSlackAcknowledged)
    throw new Error("Review and authorize personal Slack access for this schedule.");
  const item = catalog.find((entry) => entry.id === form.personalSlackCapabilityId);
  if (
    !item?.enabled ||
    item.endpointUrl?.replace(/\/+$/, "") !== "https://mcp.slack.com/mcp" ||
    item.connectionRef?.subjectScope !== "subject" ||
    !item.runtime.mcpServerId
  )
    throw new Error("Connect your personal Slack account in Capabilities before scheduling.");
  if (form.runMode === "existing_session") {
    await attachSessionCapability(client, workspaceId, form.targetSessionId, item, stillCurrent);
    check();
    const session = await client.getSession(workspaceId, form.targetSessionId);
    check();
    if (!session.connectionContext)
      throw new Error("Conversation authority is unavailable. Reload and retry.");
    await authorizeSessionPersonalConnection(
      client,
      workspaceId,
      session.id,
      item,
      session.connectionContext.visibility,
      form.personalSlackAcknowledged,
      stillCurrent,
    );
    const connectionAuthorities = await sessionConnectionAuthorities(client, session, [item]);
    check();
    if (connectionAuthorities.length !== 1)
      throw new Error("Personal Slack authorization is unavailable.");
    return { connectionAuthorities, serverId: item.runtime.mcpServerId };
  }
  const connections = (await client.listConnections(workspaceId)).filter(
    (entry) =>
      entry.subjectId !== null &&
      entry.status === "active" &&
      entry.providerDomain === item.connectionRef!.providerDomain &&
      entry.kind === item.connectionRef!.kind &&
      entry.authorityId,
  );
  check();
  if (connections.length !== 1)
    throw new Error("Select one personal Slack account in Capabilities before scheduling.");
  const connection = connections[0]!;
  const { grant } = await client.issueUserResourceGrant(workspaceId, connection.authorityId!, {
    scope: "user",
    resourceKind: "connection",
    mode: "always",
    context: "workspace_shared",
    workspaceSharedAcknowledged: true,
  });
  check();
  return {
    serverId: item.runtime.mcpServerId,
    connectionAuthorities: [
      {
        serverId: item.runtime.mcpServerId,
        connectionId: connection.id,
        userDelegation: grant.delegation,
      },
    ],
  };
}
