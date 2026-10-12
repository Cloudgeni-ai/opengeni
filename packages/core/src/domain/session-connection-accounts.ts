import type {
  AccessGrant,
  ConnectionAccountIntent,
  McpConnectionAccountBinding,
  McpConnectionAccountSelection,
  McpPersonalConnectionDelegation,
  ResourceRef,
  ToolRef,
} from "@opengeni/contracts";
import { GOOGLE_DRIVE_PUBLICATION_SERVER_ID } from "@opengeni/contracts/google-drive";
import { PERSONAL_GITHUB_CONNECTION_SURFACE_ID } from "@opengeni/contracts/personal-github";
import { resolveSessionFirstPartyMcpTools, type Settings } from "@opengeni/config";
import { requireSession, requireWorkspace, type Database } from "@opengeni/db";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import {
  ConnectionAccountSelectionError,
  freezeConnectionAccounts,
  personalConnectionDelegationSourceForGrant,
} from "./personal-connection-delegations";
import { personalGitHubRepositoryResources } from "./resources";
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
  const workspace = await requireWorkspace(db, workspaceId);
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
      workspace.settings,
    ),
  });
  const effectiveFirstPartyTools = resolveSessionFirstPartyMcpTools(
    settings,
    session,
    workspace.settings,
  );
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
      effectiveFirstPartyTools.includes("editable_artifact_export") &&
      effectiveFirstPartyTools.includes("editable_artifact_export_status") &&
      (!session.firstPartyMcpPermissions?.length ||
        (session.firstPartyMcpPermissions.includes("artifacts:read") &&
          session.firstPartyMcpPermissions.includes("artifacts:publish"))),
    atlassianEnabled:
      effectiveFirstPartyTools.some((tool) => tool.startsWith("atlassian_")) &&
      (!session.firstPartyMcpPermissions?.length ||
        session.firstPartyMcpPermissions.includes("connections:read")),
  });
}

/** One connector a continued turn runs without, and why. */
export type ContinuedConnectionAccountGap = {
  serverId: string;
  /** The picked account that can no longer be used; null when none was picked. */
  connectionId: string | null;
  reason: string;
};

/**
 * Accounts for a turn that continues earlier work in this session: a goal
 * continuation, a wait wake-up, a command or child result, or informational
 * input delivered into the person's last message. It resolves the carried
 * intent exactly as that person's next message with the same picks would be
 * resolved now, against the session's current connectors and the person's
 * current accounts. Nothing from an earlier turn's accounts is copied.
 *
 * A picked account that can no longer be used is never replaced by another
 * account: its connector is left out of this turn. The same applies to a
 * connector whose account can no longer be chosen automatically (for example
 * several accounts now match and none was picked). Every other connector is
 * unaffected.
 *
 * `db` is the claim transaction, so every read runs one at a time.
 */
export async function resolveContinuedConnectionAccounts(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  intent: ConnectionAccountIntent;
}): Promise<{
  mcpAccountBindings: McpConnectionAccountBinding[] | null;
  personalConnectionDelegations: McpPersonalConnectionDelegation[];
  /** Connectors the turn runs without, because their account cannot be used. */
  gaps: ContinuedConnectionAccountGap[];
}> {
  const { db, settings, accountId, workspaceId, sessionId, intent } = input;
  const principalSubjectId =
    intent.principal.kind === "subject" ? intent.principal.subjectId : null;
  const session = await requireSession(db, workspaceId, sessionId);
  const workspace = await requireWorkspace(db, workspaceId);
  const capabilitySettings = await settingsWithEnabledCapabilityMcpServers(
    db,
    workspaceId,
    settings,
    principalSubjectId
      ? { subjectId: principalSubjectId, oneReadAtATime: true }
      : { oneReadAtATime: true },
  );
  const runtimeSettings = settingsWithSessionMcpServerMetadata(
    capabilitySettings,
    session.mcpServers,
  );
  let tools: ToolRef[] = sessionToolsForConnectionAccounts({
    session,
    runtimeMcpServers: runtimeSettings.mcpServers,
    defaultMcpServerIds: workspaceSessionToolPolicyDefaultServerIdsFor(
      capabilitySettings.mcpServers,
      workspace.settings,
    ),
  });
  const effectiveFirstPartyTools = resolveSessionFirstPartyMcpTools(
    settings,
    session,
    workspace.settings,
  );
  let googleDrivePublicationEnabled =
    effectiveFirstPartyTools.includes("editable_artifact_export") &&
    effectiveFirstPartyTools.includes("editable_artifact_export_status") &&
    (!session.firstPartyMcpPermissions?.length ||
      (session.firstPartyMcpPermissions.includes("artifacts:read") &&
        session.firstPartyMcpPermissions.includes("artifacts:publish")));
  const atlassianEnabled =
    effectiveFirstPartyTools.some((tool) => tool.startsWith("atlassian_")) &&
    (!session.firstPartyMcpPermissions?.length ||
      session.firstPartyMcpPermissions.includes("connections:read"));
  const withoutPersonalRepositories = (from: ResourceRef[]) => {
    const personal = new Set<ResourceRef>(personalGitHubRepositoryResources(from));
    return from.filter((resource) => !personal.has(resource));
  };
  // Work without a person behind it never uses a personal repository grant.
  let resources: ResourceRef[] = principalSubjectId
    ? session.resources
    : withoutPersonalRepositories(session.resources);
  // A pick for a connector the session no longer uses does not apply.
  const applies = (selection: McpConnectionAccountSelection) =>
    selection.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID
      ? googleDrivePublicationEnabled
      : selection.serverId === PERSONAL_GITHUB_CONNECTION_SURFACE_ID
        ? personalGitHubRepositoryResources(resources).length > 0
        : tools.some((tool) => tool.kind === "mcp" && tool.id === selection.serverId);
  let selections = intent.selections.filter(applies);
  const gaps: ContinuedConnectionAccountGap[] = [];
  // Each round removes at least one connector or pick, so this always ends.
  for (let round = 0; ; round += 1) {
    try {
      const resolved = await freezeConnectionAccounts({
        db,
        accountId,
        workspaceId,
        settings: runtimeSettings,
        tools,
        resources,
        source: principalSubjectId
          ? { kind: "subject", subjectId: principalSubjectId, accountId }
          : { kind: "none" },
        targetSessionId: sessionId,
        googleDrivePublicationEnabled,
        atlassianEnabled,
        authoritySelections: selections,
      });
      return {
        mcpAccountBindings: resolved.mcpAccountBindings,
        personalConnectionDelegations: resolved.personalConnectionDelegations,
        gaps,
      };
    } catch (error) {
      if (!(error instanceof ConnectionAccountSelectionError)) throw error;
      const named = error.diagnostic.accounts.filter(
        (account) =>
          account.connectionId === null ||
          selections.some(
            (selection) =>
              selection.serverId === account.serverId &&
              selection.connectionId === account.connectionId,
          ),
      );
      // The person lost access to this workspace: none of their picks can be used.
      const unusable =
        named.length > 0
          ? named
          : error.diagnostic.reason === "owner_access_unavailable"
            ? selections.map((selection) => ({ ...selection, reason: error.diagnostic.reason }))
            : [];
      const dropped = new Set(unusable.map((account) => account.serverId));
      if (dropped.size === 0 || round > intent.selections.length + tools.length + 2) throw error;
      gaps.push(
        ...unusable.map((account) => ({
          serverId: account.serverId,
          connectionId: account.connectionId,
          reason: account.reason,
        })),
      );
      selections = selections.filter((selection) => !dropped.has(selection.serverId));
      tools = tools.filter((tool) => !(tool.kind === "mcp" && dropped.has(tool.id)));
      if (dropped.has(GOOGLE_DRIVE_PUBLICATION_SERVER_ID)) googleDrivePublicationEnabled = false;
      if (dropped.has(PERSONAL_GITHUB_CONNECTION_SURFACE_ID)) {
        resources = withoutPersonalRepositories(resources);
      }
    }
  }
}
