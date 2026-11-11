// Shared by the continued-account shared-reads test and its latency benchmark.
import type postgres from "postgres";
import type {
  ConnectionAccountIntent,
  McpConnectionAccountSelection,
  ResourceRef,
  ToolRef,
} from "@opengeni/contracts";
import { GOOGLE_DRIVE_PUBLICATION_SERVER_ID } from "@opengeni/contracts/google-drive";
import { PERSONAL_GITHUB_CONNECTION_SURFACE_ID } from "@opengeni/contracts/personal-github";
import type { Settings } from "@opengeni/config";
import { testSettings } from "@opengeni/testing/settings";
import {
  createSession,
  requireSession,
  requireWorkspace,
  type ClaimSessionWorkForAttemptInput,
  type Database,
} from "@opengeni/db";
import { settingsWithEnabledCapabilityMcpServers } from "../src/domain/capabilities";
import {
  ConnectionAccountSelectionError,
  freezeConnectionAccounts,
} from "../src/domain/personal-connection-delegations";
import { personalGitHubRepositoryResources } from "../src/domain/resources";
import {
  sessionToolsForConnectionAccounts,
  settingsWithSessionMcpServerMetadata,
} from "../src/domain/sessions";
import { workspaceSessionToolPolicyDefaultServerIdsFor } from "../src/domain/session-tool-policy";
import type { ContinuedConnectionAccountGap } from "../src/domain/session-connection-accounts";

/**
 * The resolution as it was before reads were shared, kept verbatim: every
 * helper it calls runs its unshared path when no `ConnectionAccountReads` is
 * passed, so this is the old behavior to compare against.
 */
export async function resolveContinuedConnectionAccountsUnshared(input: {
  db: Database;
  settings: Settings;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  intent: ConnectionAccountIntent;
  claimedSession?: Parameters<
    NonNullable<ClaimSessionWorkForAttemptInput["resolveContinuedConnectionAccounts"]>
  >[1]["session"];
}) {
  const { db, settings, accountId, workspaceId, sessionId, intent } = input;
  const principalSubjectId =
    intent.principal.kind === "subject" ? intent.principal.subjectId : null;
  const session = input.claimedSession ?? (await requireSession(db, workspaceId, sessionId));
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
  const withoutPersonalRepositories = (from: ResourceRef[]) => {
    const personal = new Set<ResourceRef>(personalGitHubRepositoryResources(from));
    return from.filter((resource) => !personal.has(resource));
  };
  let resources: ResourceRef[] = principalSubjectId
    ? session.resources
    : withoutPersonalRepositories(session.resources);
  const applies = (selection: McpConnectionAccountSelection) =>
    selection.serverId === GOOGLE_DRIVE_PUBLICATION_SERVER_ID
      ? false
      : selection.serverId === PERSONAL_GITHUB_CONNECTION_SURFACE_ID
        ? personalGitHubRepositoryResources(resources).length > 0
        : tools.some((tool) => tool.kind === "mcp" && tool.id === selection.serverId);
  let selections = intent.selections.filter(applies);
  const gaps: ContinuedConnectionAccountGap[] = [];
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
      if (dropped.has(PERSONAL_GITHUB_CONNECTION_SURFACE_ID)) {
        resources = withoutPersonalRepositories(resources);
      }
    }
  }
}

export const settings = testSettings({
  sandboxBackend: "none",
  githubPersonalOauthEnabled: true,
  githubPersonalAllRepositoriesEnabled: true,
});

/**
 * An organization with a shared team workspace whose connectors are enabled
 * capabilities: `connectors` subject-scoped ones and one wiki used through a
 * workspace-owned account. Mia has her own account for every connector made
 * in the team workspace, and one more for the first connector made in
 * another workspace (not turned on in the team). Bob has his own account for
 * the first connector; Carol has none. Sessions exist in the team workspace
 * and in Mia's Personal workspace, which carries her team connectors.
 */
export async function world(connectors: number, handles: { admin: postgres.Sql; db: Database }) {
  const { admin } = handles;
  const suffix = crypto.randomUUID().slice(0, 8);
  const [org] = await admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`shared reads ${suffix}`}) returning id`;
  const accountId = org!.id;
  const workspace = async (name: string) => {
    const [row] = await admin<{ id: string }[]>`
      insert into workspaces (account_id, name) values (${accountId}, ${name}) returning id`;
    await admin`insert into workspace_inference_controls (workspace_id, account_id)
      values (${row!.id}, ${accountId})`;
    return row!.id;
  };
  const team = await workspace("Team");
  const otherTeam = await workspace("Other team");
  const miaPersonal = await workspace("Mia personal");
  const bobPersonal = await workspace("Bob personal");
  const carolPersonal = await workspace("Carol personal");
  const mia = `user:mia-${suffix}`;
  const bob = `user:bob-${suffix}`;
  const carol = `user:carol-${suffix}`;
  await admin`insert into organization_memberships (account_id, subject_id, status, personal_workspace_id)
    values (${accountId}, ${mia}, 'active', ${miaPersonal}),
           (${accountId}, ${bob}, 'active', ${bobPersonal}),
           (${accountId}, ${carol}, 'active', ${carolPersonal})`;
  await admin`insert into workspace_memberships (account_id, workspace_id, subject_id)
    values (${accountId}, ${team}, ${mia}), (${accountId}, ${team}, ${bob}),
           (${accountId}, ${team}, ${carol}), (${accountId}, ${otherTeam}, ${mia})`;
  const connection = async (input: {
    workspaceId: string;
    subjectId: string | null;
    providerDomain: string;
    resource?: string;
  }) =>
    await admin.begin(async (tx) => {
      await tx`select set_config('opengeni.account_id', ${accountId}, true),
        set_config('opengeni.workspace_id', ${input.workspaceId}, true),
        set_config('opengeni.subject_id', ${input.subjectId ?? ""}, true)`;
      const [row] = await tx<{ id: string }[]>`
        insert into connections (
          account_id, workspace_id, subject_id, provider_domain, kind, credential_encrypted, metadata
        ) values (
          ${accountId}, ${input.workspaceId}, ${input.subjectId}, ${input.providerDomain},
          'oauth2', 'fixture-ciphertext',
          ${tx.json(input.resource ? { resource: input.resource } : {})}
        ) returning id`;
      return row!.id;
    });
  const enable = async (input: {
    serverId: string;
    providerDomain: string;
    endpoint: string;
    connectionRef: Record<string, unknown>;
  }) => {
    const capabilityId = `mcp:${input.serverId}`;
    await admin`insert into capability_catalog_items (
      id, account_id, workspace_id, kind, source, name, endpoint_url,
      auth_model, auth_kind, provider_domain, mcp_url, metadata
    ) values (
      ${capabilityId}, ${accountId}, ${team}, 'mcp', 'manual', ${input.serverId},
      ${input.endpoint}, 'oauth2', 'oauth2', ${input.providerDomain}, ${input.endpoint},
      ${admin.json({ mcpServerId: input.serverId })}
    )`;
    await admin`insert into capability_installations (
      account_id, workspace_id, capability_id, kind, status, config, metadata
    ) values (
      ${accountId}, ${team}, ${capabilityId}, 'mcp', 'active',
      ${admin.json({ connectionRef: input.connectionRef })},
      ${admin.json({ mcpConnectivity: { status: "auth_deferred" } })}
    )`;
  };
  const servers: string[] = [];
  const miaAccounts: string[] = [];
  for (let index = 0; index < connectors; index += 1) {
    const serverId = `tool${index}-${suffix}`;
    const providerDomain = `tool${index}-${suffix}.example.test`;
    await enable({
      serverId,
      providerDomain,
      endpoint: `https://${providerDomain}/mcp`,
      connectionRef: { providerDomain, kind: "oauth2", subjectScope: "subject" },
    });
    servers.push(serverId);
    miaAccounts.push(await connection({ workspaceId: team, subjectId: mia, providerDomain }));
  }
  const firstDomain = `tool0-${suffix}.example.test`;
  const miaElsewhere = await connection({
    workspaceId: otherTeam,
    subjectId: mia,
    providerDomain: firstDomain,
  });
  const bobAccount = await connection({
    workspaceId: team,
    subjectId: bob,
    providerDomain: firstDomain,
  });
  const wiki = `wiki-${suffix}`;
  const wikiDomain = `wiki-${suffix}.example.test`;
  const wikiAccount = await connection({
    workspaceId: team,
    subjectId: null,
    providerDomain: wikiDomain,
  });
  await enable({
    serverId: wiki,
    providerDomain: wikiDomain,
    endpoint: `https://${wikiDomain}/mcp`,
    connectionRef: {
      providerDomain: wikiDomain,
      kind: "oauth2",
      connectionId: wikiAccount,
      subjectScope: "workspace",
    },
  });
  const tools: ToolRef[] = [
    ...[...servers, wiki].map((id) => ({ kind: "mcp" as const, id })),
    { kind: "mcp", id: "opengeni" },
  ];
  const session = async (workspaceId: string) =>
    await createSession(handles.db, {
      accountId,
      workspaceId,
      subjectId: mia,
      initialMessage: "Work",
      resources: [],
      tools,
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
    });
  return {
    sql: admin,
    accountId,
    team,
    otherTeam,
    miaPersonal,
    mia,
    bob,
    carol,
    servers,
    wiki,
    miaAccounts,
    miaElsewhere,
    bobAccount,
    wikiAccount,
    teamSession: await session(team),
    personalSession: await session(miaPersonal),
  };
}

export type World = Awaited<ReturnType<typeof world>>;

export function intentFor(
  principal: string | null,
  selections: McpConnectionAccountSelection[] = [],
): ConnectionAccountIntent {
  return {
    version: 1,
    principal: principal ? { kind: "subject", subjectId: principal } : { kind: "none" },
    selections,
  };
}
