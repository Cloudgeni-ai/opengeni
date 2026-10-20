import { OPENGENI_API_CONTRACT_REVISION } from "@opengeni/sdk";
import { OPENGENI_SLACK_BOT_REQUESTED_SCOPES } from "@opengeni/contracts/slack-bot-scopes";
export const workspaceId = "00000000-0000-4000-8000-000000000811";
export const siblingId = "00000000-0000-4000-8000-000000000812";
export const accountId = "00000000-0000-4000-8000-000000000813";
export const connectionId = "00000000-0000-4000-8000-000000000814";
export const now = "2026-09-07T00:00:00.000Z";
export type SlackFixtureState = {
  installed: boolean; routingSaves: number; disconnects: number; connectionsReady?: Promise<void>; multiple?: boolean;
  access?: Record<string, { enabled: boolean; generation: number; workspaceIds: string[] | null }>;
  routes?: Record<string, unknown[]>;
};
export async function slackFixtureResponse(request: Request, state: SlackFixtureState): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json", "x-opengeni-api-contract": OPENGENI_API_CONTRACT_REVISION },
    });
    if (path.endsWith("/memory-slack-publications/configuration")) return json({ current: { enabled: false, revision: 1, connectionId, slackChannelId: "CDEV", slackChannelName: "#dev", autoImportances: ["major"], reviewImportances: ["normal"] } });
    if (path === "/v1/inbox" && request.method === "GET")
      return json({ items: [], needsYouCount: 0, unreadCount: 0 });
    if (path === "/v1/config/client")
      return json({
        deploymentRevision: "slack-settings-test",
        apiContractRevision: OPENGENI_API_CONTRACT_REVISION,
        defaultModel: "gpt-5.6-sol",
        allowedModels: ["gpt-5.6-sol"],
        models: [],
        defaultReasoningEffort: "low",
        allowedReasoningEfforts: ["low"],
        mcpServers: [],
        fileUploads: { enabled: false, maxSizeBytes: 1_048_576 },
        productAccessMode: "configured",
        auth: { mode: "none" },
        structuredServices: { fileSystem: false, git: false, terminalEvents: false },
      });
    if (path === "/v1/access/me")
      return json({
        mode: "configured",
        subjectId: "slack-test",
        subjectLabel: "Slack test",
        accountGrants: [{ accountId, permissions: ["account:admin", "account:read"] }],
        workspaceGrants: [workspaceId, siblingId].map((id) => ({
          workspaceId: id,
          accountId,
          subjectId: "slack-test",
          permissions: [
            "workspace:admin",
            "connections:read",
            "connections:write",
            "capabilities:read",
            "sessions:create", "sessions:read", "scheduled_tasks:manage", "scheduled_tasks:run",
          ],
        })),
        defaultAccountId: accountId,
        defaultWorkspaceId: workspaceId,
      });
    if (path === "/v1/workspaces")
      return json([workspace(workspaceId, "Cloudgeni"), workspace(siblingId, "Analytics")]);
    // Keep provider readiness independent of the connection lookup held during reload.
    if (path.endsWith("/connect/catalog"))
      return json([
        {
          id: "slack-bot",
          label: "Opengeni Slack bot",
          family: "slack",
          readiness: "available",
          ownership: ["workspace"],
          setup: ["oauth"],
        },
      ]);
    if (path.endsWith("/session-tenancy/capabilities")) return json({ activated: true, canCreatePrivate: false, reason: "not_activated", defaultVisibility: "workspace" });
    if (path.endsWith("/model-catalog")) return json({ models: [], defaultSelection: null, creditsSelection: null });
    if (path.endsWith("/agent-learning/read")) return json({ settings: {}, version: 1, ownerKey: `workspace:${workspaceId}` });
    if (path.endsWith("/scheduled-tasks/private-summaries")) return json({ items: [], nextCursor: null });
    if (path.endsWith("/scheduled-tasks/attention")) return json({ items: [] });
    if (path.endsWith("/scheduled-tasks")) return json([]);
    if (path.endsWith("/machines")) return json({ machines: [] });
    if (path.endsWith("/vaults")) return json([]);
    if (path.endsWith("/connections/accounts")) return json({ connections: state.multiple ? [personalAccount()] : [] });
    if (path.endsWith("/capabilities")) return json({ items: [], installations: [] });
    if (path.endsWith("/connections")) {
      await state.connectionsReady;
      return json({ connections: [...(state.installed && path.includes(workspaceId) ? [bot(), ...(state.multiple ? [communityBot()] : [])] : []), ...(state.multiple ? [personalAccount()] : [])] });
    }
    if (path.endsWith("/connections/slack-bot/available"))
      return json({ connections: state.installed ? [bot(), ...(state.multiple ? [communityBot()] : [])] : [], organizationSharedConnectionIds: state.installed ? [connectionId, ...(state.multiple ? [communityBot().id] : [])] : [] });
    if (path.endsWith("/slack-bot/organization-access")) {
      const id = path.split("/").at(-3)!;
      const access = (state.access ??= {});
      if (request.method === "PUT") access[id] = { ...await request.json(), generation: (access[id]?.generation ?? 1) + 1 };
      return json(access[id] ?? { enabled: true, generation: 1, workspaceIds: null });
    }
    if (path.endsWith("/connections/slack-bot/bindings"))
      return json({ bindings: state.installed && path.includes(workspaceId) ? [binding(), ...(state.multiple ? [{ ...binding(), id: "00000000-0000-4000-8000-000000000819", connectionId: communityBot().id, slackTeamId: "TCOMMUNITY", slackTeamName: "Community", botId: "BCOMMUNITY", botUserId: "UCOMMUNITY" }] : [])] : [] });
    if (path.endsWith("/channel-routes")) {
      if (request.method === "PUT") {
        state.routingSaves++;
        const body = await request.json();
        (state.routes ??= {})[body.connectionId] = body.routes;
        return json({ routes: body.routes, routingEnabled: true });
      }
      return json({ routes: state.routes?.[url.searchParams.get("connectionId") ?? connectionId] ?? [], routingEnabled: true });
    }
    if (path.endsWith("/reaction-channels"))
      return json({ channels: [{ id: "CDEV", name: "dev", isPrivate: false }], nextCursor: null });
    if (request.method === "DELETE" && path.endsWith(connectionId)) {
      state.disconnects++;
      return json({});
    }

    if (path.endsWith("/skills/search")) return json({ items: [], nextCursor: null });
    if (path.endsWith("/skills")) return json({ skills: [] });
    if (path.endsWith("/skills/content")) return json({ skills: [], nextCursor: null });
    if (path.endsWith("/capabilities/discovery/plugins"))
      return json({ items: [], total: 0, nextOffset: null });
    if (path.endsWith("/plugins")) return json({ plugins: [] });
    if (path.endsWith("/integrations/definitions")) return json({ definitions: [] });
    if (path.endsWith("/integrations")) return json({ integrations: [] });
    if (path.endsWith("/sessions"))
      return json({
        sessions: [],
        pinned: [],
        pinnedTruncated: false,
        nextCursor: null,
        filtersApplied: true,
        sortBy: url.searchParams.get("sortBy") ?? "updatedAt",
        archiveStatus: url.searchParams.get("archiveStatus") ?? "active",
        ...(url.searchParams.get("needsYouOnly") === "true" ? { needsYouOnly: true } : {}),
        ...(url.searchParams.get("includeTotals") === "true"
          ? { totals: { needsYouCount: 0, groups: [] } }
          : {}),
      });
    if (path.endsWith("/channels") || path.endsWith("/rigs") || path.endsWith("/variable-sets"))
      return json([]);
    if (path.endsWith("/github/app"))
      return json({ configured: false, missing: [], installUrl: null });
    return json({});
}

function workspace(id: string, name: string) {
  return {
    id,
    accountId,
    kind: "shared",
    name,
    slug: name.toLowerCase(),
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    inferenceControl: {
      state: "active",
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
    },
    defaultRigId: null,
    createdAt: now,
    updatedAt: now,
  };
}
function bot() {
  return {
    id: connectionId,
    accountId,
    workspaceId,
    subjectId: null,
    providerDomain: "slack.com",
    kind: "app_install",
    status: "active",
    grantedScopes: [...OPENGENI_SLACK_BOT_REQUESTED_SCOPES],
    expiresAt: null,
    lastRefreshAt: now,
    lastUsedAt: now,
    lastError: null,
    version: 1,
    verifiedInstallAt: now,
    verifiedInstallVersion: 1,
    metadata: {
      credentialRole: "opengeni_slack_bot",
      credentialLabel: "OpenGeni Slack bot",
      slackTeamId: "TACME",
      slackTeamName: "Cloudgeni",
      botId: "BACME",
      botUserId: "UACME",
      botDisplayName: "Opengeni",
    },
    createdBySubjectId: "slack-test",
    updatedBySubjectId: "slack-test",
    createdAt: now,
    updatedAt: now,
  };
}
function binding() {
  return {
    id: "00000000-0000-4000-8000-000000000815",
    accountId,
    accountName: "Cloudgeni",
    workspaceId,
    workspaceName: "Cloudgeni",
    connectionId,
    connectionStatus: "active",
    connectionVersion: 1,
    slackTeamId: "TACME",
    slackTeamName: "Cloudgeni",
    botId: "BACME",
    botUserId: "UACME",
    botDisplayName: "Opengeni",
    state: "active",
    quarantineReason: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function communityBot() {
  const row = bot();
  return { ...row, id: "00000000-0000-4000-8000-000000000818", metadata: { ...row.metadata, slackTeamId: "TCOMMUNITY", slackTeamName: "Community", botId: "BCOMMUNITY", botUserId: "UCOMMUNITY" } };
}
function personalAccount() {
  return { ...bot(), id: "00000000-0000-4000-8000-000000000820", kind: "oauth2", subjectId: "slack-test", metadata: { slackUserName: "Alex", slackUserId: "UALEX", slackTeamId: "TACME", slackTeamName: "Cloudgeni", mcpUrl: "https://mcp.slack.com/mcp" } };
}
