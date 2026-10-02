import type { AccessGrant } from "@opengeni/contracts";
import type { Settings } from "@opengeni/config";
import { requireSession, requireWorkspace, type Database } from "@opengeni/db";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import {
  freezeConnectionAccounts,
  personalConnectionDelegationSourceForGrant,
} from "./personal-connection-delegations";
import {
  sessionToolsForConnectionAccounts,
  settingsWithSessionMcpServerMetadata,
} from "./sessions";
import { workspaceSessionToolPolicyDefaultServerIdsFor } from "./session-tool-policy";

/** Freeze the authenticated request's eligible accounts before starting voice.
 * The resulting lease snapshot, not a later participant or ambient connection,
 * supplies authority to both live delegations and automatic transcript handoff. */
export async function freezeSessionRealtimeConnectionAccounts(input: {
  db: Database;
  settings: Settings;
  grant: AccessGrant;
  workspaceId: string;
  sessionId: string;
}) {
  const { db, settings, grant, workspaceId, sessionId } = input;
  const session = await requireSession(db, workspaceId, sessionId);
  const capabilitySettings = await settingsWithEnabledCapabilityMcpServers(
    db,
    workspaceId,
    settings,
    {
      subjectId: grant.subjectId,
    },
  );
  const runtimeSettings = settingsWithSessionMcpServerMetadata(
    capabilitySettings,
    session.mcpServers,
  );
  const tools = sessionToolsForConnectionAccounts({
    session,
    runtimeMcpServers: runtimeSettings.mcpServers,
    defaultMcpServerIds: workspaceSessionToolPolicyDefaultServerIdsFor(
      capabilitySettings.mcpServers,
      (await requireWorkspace(db, workspaceId)).settings,
    ),
  });
  return await freezeConnectionAccounts({
    db,
    settings: runtimeSettings,
    accountId: grant.accountId,
    workspaceId,
    tools,
    resources: session.resources,
    source: personalConnectionDelegationSourceForGrant(grant),
    targetSessionId: sessionId,
    googleDrivePublicationEnabled:
      session.firstPartyMcpTools.includes("editable_artifact_export") &&
      session.firstPartyMcpTools.includes("editable_artifact_export_status") &&
      (!session.firstPartyMcpPermissions?.length ||
        (session.firstPartyMcpPermissions.includes("artifacts:read") &&
          session.firstPartyMcpPermissions.includes("artifacts:publish"))),
    atlassianEnabled:
      session.firstPartyMcpTools.some((tool) => tool.startsWith("atlassian_")) &&
      (!session.firstPartyMcpPermissions?.length ||
        session.firstPartyMcpPermissions.includes("connections:read")),
  });
}
