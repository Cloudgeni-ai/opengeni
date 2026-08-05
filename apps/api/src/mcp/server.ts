import { createHash } from "node:crypto";
import {
  CreateScheduledTaskRequest,
  DEFAULT_FIRST_PARTY_MCP_TOOLS,
  FIRST_PARTY_MCP_TOOL_NAMES,
  defaultRepositoryMountPath,
  SESSION_EVENT_RAW_DELTA_TYPES,
  SessionEventLatestClass,
  SessionEventPayloadMode,
  SessionEventReadDirection,
  SessionEventReadMode,
  SessionEventResultMode,
  SessionEventSemanticClass,
  SessionEventType,
  compactSessionEventResult,
  sessionEventLatestClassToSemanticClass,
  SessionMcpCredentialUpdateInput,
  VariableSetVariableName,
  type AccessGrant,
  type GitHubRepository,
  type FirstPartyMcpToolName,
  type Permission,
  type ResourceRef,
  type SessionAuthorizationOperation,
  type SessionAuthorizationSurface,
  type Session,
  type ScheduledTask,
  UpdateScheduledTaskRequest,
  normalizeWorkspaceArtifactSlug,
  WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES,
} from "@opengeni/contracts";
import {
  correctWorkspaceMemory,
  countVariableSets,
  beginRigChangeVerificationAttempt,
  createVariableSet,
  deleteScheduledTask,
  encryptVariableSetValue,
  getSession,
  getSessionGoal,
  getSessionQueueSnapshot,
  getSessionTurn,
  getOrCreatePreferenceRegistrySnapshot,
  getPreferenceRegistryFullContent,
  getVariableSet,
  getVariableSetByName,
  listScheduledTaskRuns,
  listScheduledTasks,
  listSessionEventPage,
  listSessionDiscoverySummaries,
  projectEffectiveControlForRelatedAccess,
  projectSessionForRelatedAccess,
  type SessionDiscoveryCursor,
  type SessionDiscoveryOrderBy,
  listRigs,
  listRigChangeMonitoringSummaries,
  listRigVersionMonitoringSummaries,
  listSocialPosts,
  recordAuditEvent,
  recordSyncedSocialPosts,
  listVariableSets,
  MEMORY_CORRECT_TOOL_DESCRIPTION,
  MEMORY_SAVE_TOOL_DESCRIPTION,
  MEMORY_SEARCH_TOOL_DESCRIPTION,
  requireScheduledTask,
  requireSession,
  saveWorkspaceMemory,
  searchWorkspaceMemories,
  serializeEffectiveSessionControl,
  setSessionGoalStatusWithEvent,
  setVariableSetVariable,
  updateScheduledTask,
  updateSessionGoalWithEvent,
  upsertSessionGoalWithEvent,
  RigChangeAlreadyVerifyingError,
  RigChangeTransitionError,
  createWorkspaceArtifact,
  getWorkspaceArtifact,
  getWorkspaceArtifactContentRef,
  listWorkspaceArtifacts,
  publishWorkspaceArtifactVersion,
  rollbackWorkspaceArtifact,
} from "@opengeni/db";
import { appendAndPublishEvents, publishDurableSessionEvents } from "@opengeni/events";
import {
  createSignedState,
  GitHubAppConfigurationError,
  githubAppMissingSettings,
} from "@opengeni/github";
import {
  McpServer,
  type RegisteredTool,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import * as z4 from "zod/v4";
import {
  hasPermission,
  authorizedSocialConnectionsForGrant,
  requireSessionAuthorization,
  requireSessionAuthorizationListScope,
  type ResolvedSessionAuthorization,
} from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  githubBindingStatus,
  listWorkspaceGitHubInstallationBindings,
  listWorkspaceGitHubRepositories,
} from "../github-access";
import { githubBrowserBaseUrl, githubBrowserGrantClaims } from "../github-browser-flow";
import {
  socialMentionsLive,
  socialOwnPostsLive,
  socialPostReply,
  socialSearchLive,
  socialThreadLive,
} from "../integrations/social-api";
import {
  promoteVerifiedDefinitionEditChangeForApi,
  proposeRigChangeForApi,
  requireRigChangeForApi,
  requireRigForApi,
  assertAllowedVariableSetVariableName,
  MAX_ENVIRONMENTS_PER_WORKSPACE,
  MAX_VARIABLES_PER_ENVIRONMENT,
  recordVariableSetAuditEvent,
  requireVariableSetEncryption,
} from "@opengeni/core";
import {
  captureScheduledTaskRestoreState,
  createValidatedScheduledTask,
  manualScheduledTaskTriggerUsageKey,
  manualScheduledTaskTriggerWorkflowId,
  scheduledTaskToolsProvided,
  scheduledTaskTriggerToken,
  ScheduledTaskSyncError,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validatedScheduledTaskUpdate,
} from "@opengeni/core";
import {
  acceptSessionUserMessageWithOutcome,
  controlAgentSessionWorkstream,
  controlHumanSessionWorkstream,
  createSessionForRequestWithOutcome,
  SessionSpawnDeniedError,
  sessionSpawnDenialEnvelope,
  sendAgentSessionMessage,
  steerAgentSession,
  updateSessionTitle,
  sessionWithEffectiveToolPolicy,
  workspaceSessionToolPolicyDefaultServerIds,
  workspaceSessionToolPolicyServerIds,
  type AgentSessionCommandContext,
} from "@opengeni/core";
import {
  buildFleetContextForSession,
  listFleet,
  provisionSandbox,
  runOnSandbox,
  swapActiveSandbox,
  type FleetContext,
  type FleetServices,
  type RunOnOp,
} from "@opengeni/core";
import {
  boundSessionEventCompactResult,
  boundSessionEventMcpPage,
  boundSessionDetailMcp,
  boundRigDetailMcp,
  SESSION_EVENT_MCP_MAX_BYTES,
} from "./session-view";
import { mcpMutationReceipt, sessionCreateMutationReceipt } from "./receipts";
import {
  boundScheduledTaskDetailMcp,
  boundScheduledTaskMcpPage,
  scheduledTaskMcpSummary,
} from "./scheduled-task-view";
import type { ToolspaceMcpSurface } from "./toolspace";
import { ensureSessionGroupReady as ensureViewerSessionGroupReady } from "../sandbox/viewer";
import {
  createOpenGeniSlackBotClient,
  resolveSlackBotConnectionForTool,
} from "../integrations/slack-bot";

export type McpServerOptions = {
  // Origin of the HTTP request that reached the MCP route. Browser-oriented
  // tools use it only when no configured public base URL is available.
  requestOrigin?: string | null;
  toolspace?: ToolspaceMcpSurface | null;
  workspaceMemoryEnabled?: boolean | undefined;
};

type FirstPartyToolAuthorization = {
  sessionRequired?: true;
  allOf?: readonly Permission[];
  anyOf?: readonly Permission[];
};

/**
 * Authorization is deliberately complete and separate from visibility. The
 * `satisfies Record` check makes every catalog addition choose an explicit
 * registration predicate before it can compile.
 */
const FIRST_PARTY_TOOL_AUTHORIZATION = {
  set_session_title: { sessionRequired: true, allOf: ["sessions:control"] },
  goal_set: { sessionRequired: true, allOf: ["goals:manage"] },
  goal_update: { sessionRequired: true, allOf: ["goals:manage"] },
  goal_complete: { sessionRequired: true, allOf: ["goals:manage"] },
  goal_pause: { sessionRequired: true, allOf: ["goals:manage"] },
  memory_search: { sessionRequired: true, allOf: ["documents:search"] },
  memory_save: { sessionRequired: true, allOf: ["documents:search"] },
  memory_correct: { sessionRequired: true, allOf: ["documents:search"] },
  preference_registry_summary: { sessionRequired: true, allOf: ["workspace:read"] },
  preference_registry_get: { sessionRequired: true, allOf: ["workspace:read"] },
  sandboxes_list: { sessionRequired: true, allOf: ["sessions:read"] },
  sandbox_attach: { sessionRequired: true, allOf: ["sessions:control"] },
  sandbox_swap: { sessionRequired: true, allOf: ["sessions:control"] },
  run_on: { sessionRequired: true, allOf: ["sessions:control"] },
  sandbox_provision: { sessionRequired: true, allOf: ["sessions:control"] },
  rig_list: { allOf: ["rigs:use"] },
  rig_get: { allOf: ["rigs:use"] },
  rig_propose_change: { allOf: ["rigs:use"] },
  rig_verify: { allOf: ["rigs:use"] },
  rig_promote: { allOf: ["rigs:manage"] },
  sessions_list: { allOf: ["sessions:read"] },
  session_get: { allOf: ["sessions:read"] },
  session_events: { allOf: ["sessions:read"] },
  session_create: { allOf: ["sessions:create"] },
  session_send_message: { allOf: ["sessions:control"] },
  session_pause: { allOf: ["sessions:control"] },
  session_resume: { allOf: ["sessions:control"] },
  session_steer: { sessionRequired: true, allOf: ["sessions:control"] },
  set_other_session_title: { allOf: ["sessions:control"] },
  variable_set_list: { allOf: ["variable-sets:use"] },
  environment_list: { allOf: ["variable-sets:use"] },
  variable_set_set_variable: { allOf: ["variable-sets:manage"] },
  environment_set_variable: { allOf: ["variable-sets:manage"] },
  github_connect_link: { allOf: ["github:use"] },
  github_repositories_list: { allOf: ["github:use"] },
  social_connections_list: { allOf: ["connections:read"] },
  social_posts_recent: { allOf: ["connections:read"] },
  social_daily_analysis_context: { allOf: ["connections:read"] },
  social_search_live: { allOf: ["connections:read"] },
  social_mentions_live: { allOf: ["connections:read"] },
  social_thread_fetch: { allOf: ["connections:read"] },
  // Writes the social_posts store, so it takes the write scope like the REST
  // equivalent (POST /social/posts is workspace:admin).
  social_posts_sync: { allOf: ["connections:write"] },
  // Publishes under the user's identity: connections:write keeps it out of the
  // default agent permission set, unlike the read-only social tools above.
  social_post_reply: { allOf: ["connections:write"] },
  scheduled_tasks_list: { anyOf: ["scheduled_tasks:manage", "scheduled_tasks:run"] },
  scheduled_tasks_get: { anyOf: ["scheduled_tasks:manage", "scheduled_tasks:run"] },
  scheduled_tasks_create: { allOf: ["scheduled_tasks:manage"] },
  scheduled_tasks_update: { allOf: ["scheduled_tasks:manage"] },
  scheduled_tasks_pause: { allOf: ["scheduled_tasks:manage"] },
  scheduled_tasks_resume: { allOf: ["scheduled_tasks:manage"] },
  scheduled_tasks_trigger: { allOf: ["scheduled_tasks:run"] },
  scheduled_tasks_delete: { allOf: ["scheduled_tasks:manage"] },
  scheduled_task_runs_list: { anyOf: ["scheduled_tasks:manage", "scheduled_tasks:run"] },
  slack_bot_list_channels: { allOf: ["connections:read"] },
  slack_bot_channel_history: { allOf: ["connections:read"] },
  slack_bot_thread_replies: { allOf: ["connections:read"] },
  slack_bot_list_users: { allOf: ["connections:read"] },
  slack_bot_list_files: { allOf: ["connections:read"] },
  slack_bot_file_info: { allOf: ["connections:read"] },
  slack_bot_file_content: { allOf: ["connections:read"] },
  slack_bot_post_message: { allOf: ["connections:read"] },
  slack_bot_delete_message: { allOf: ["connections:read"] },
  artifacts_list: { sessionRequired: true, allOf: ["artifacts:read"] },
  artifacts_get_source: { sessionRequired: true, allOf: ["artifacts:read"] },
  artifacts_create: { sessionRequired: true, allOf: ["artifacts:publish"] },
  artifacts_publish: { sessionRequired: true, allOf: ["artifacts:publish"] },
  artifacts_rollback: { sessionRequired: true, allOf: ["artifacts:publish"] },
} satisfies Record<FirstPartyMcpToolName, FirstPartyToolAuthorization>;

const FIRST_PARTY_MCP_TOOL_NAME_SET = new Set<string>(FIRST_PARTY_MCP_TOOL_NAMES);

class PolicyMcpServer extends McpServer {
  private registeredToolCount = 0;

  constructor(
    private readonly grant: AccessGrant,
    private readonly sessionId: string | null,
    private readonly selectedTools: ReadonlySet<FirstPartyMcpToolName> | null,
    private readonly allowUncatalogued: boolean,
  ) {
    super({ name: "opengeni", version: "1.0.0" });
  }

  override registerTool<
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: InputArgs;
      outputSchema?: OutputArgs;
      annotations?: ToolAnnotations;
      _meta?: Record<string, unknown>;
    },
    cb: ToolCallback<InputArgs>,
  ): RegisteredTool {
    const catalogued = FIRST_PARTY_MCP_TOOL_NAME_SET.has(name);
    let admitted = this.allowUncatalogued && !catalogued;
    if (catalogued) {
      const toolName = name as FirstPartyMcpToolName;
      const policy: FirstPartyToolAuthorization = FIRST_PARTY_TOOL_AUTHORIZATION[toolName];
      const authorized =
        (!policy.sessionRequired || this.sessionId !== null) &&
        (policy.allOf?.every((permission) => hasPermission(this.grant.permissions, permission)) ??
          true) &&
        (policy.anyOf?.some((permission) => hasPermission(this.grant.permissions, permission)) ??
          true);
      const selected = this.selectedTools === null || this.selectedTools.has(toolName);
      admitted = authorized && selected;
    }
    if (!admitted) {
      return {
        ...(config.title ? { title: config.title } : {}),
        ...(config.description ? { description: config.description } : {}),
        ...(config.annotations ? { annotations: config.annotations } : {}),
        ...(config._meta ? { _meta: config._meta } : {}),
        handler: cb as RegisteredTool["handler"],
        enabled: false,
        enable() {},
        disable() {},
        update() {},
        remove() {},
      };
    }
    this.registeredToolCount += 1;
    return super.registerTool(name, config, cb);
  }

  ensureToolsListHandler(): void {
    if (this.registeredToolCount > 0) return;
    super
      .registerTool(
        "__opengeni_empty_first_party_surface__",
        {
          description: "Internal disabled placeholder for an empty first-party surface.",
          inputSchema: z4.object({}),
        },
        async () => ({
          content: [{ type: "text" as const, text: '{"unavailable":true}' }],
        }),
      )
      .disable();
  }
}

export function buildOpenGeniMcpServer(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  options: McpServerOptions = {},
): McpServer {
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });
  const can = (permission: Permission) => hasPermission(grant.permissions, permission);
  const toolspaceMode = options.toolspace != null;
  let socialConnectionsPromise: ReturnType<typeof authorizedSocialConnectionsForGrant> | undefined;
  const authorizedSocialConnections = () =>
    (socialConnectionsPromise ??= authorizedSocialConnectionsForGrant({
      db: deps.db,
      grant,
      limit: 500,
    }));
  const requireAuthorizedSocialConnection = async (connectionId: string) => {
    const authority = (await authorizedSocialConnections()).find(
      ({ connection }) => connection.id === connectionId,
    );
    if (!authority) throw new Error(`Unknown or unavailable social connection: ${connectionId}`);
    return authority;
  };

  // Session-scoped tools key off the worker-asserted sessionId claim (signed
  // into the delegated token by the worker, never agent-controlled).
  const sessionId =
    typeof grant.metadata?.["sessionId"] === "string"
      ? (grant.metadata["sessionId"] as string)
      : null;
  const selectedTools =
    sessionId !== null && !toolspaceMode
      ? new Set(
          (grant.metadata?.["firstPartyMcpTools"] as FirstPartyMcpToolName[] | undefined) ??
            DEFAULT_FIRST_PARTY_MCP_TOOLS,
        )
      : null;
  const server = new PolicyMcpServer(grant, sessionId, selectedTools, toolspaceMode);
  // set_session_title names the agent's OWN session — pure session metadata,
  // not a goal operation — so it is available on every session, gated only on
  // the signed sessionId (NOT goals:manage, and NOT on a goal existing).
  if (sessionId !== null && (!toolspaceMode || can("sessions:control"))) {
    server.registerTool(
      "set_session_title",
      {
        description:
          "Set this session's display title to a concise 3-7 word summary. The title persists across turns: call once on a new untitled session, then only when the topic materially changes. Never call it as routine setup after a continuation, resume, or interruption, or merely to reassert the same title. A human-set title cannot be replaced.",
        inputSchema: { title: z4.string().min(1).max(200) },
      },
      async ({ title }) => {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.title.write");
        const result = await updateSessionTitle(deps, grant, sessionId, title, "agent");
        return json({
          ok: true,
          updated: result.updated,
          title: result.title ?? title,
        });
      },
    );
  }
  // Goal tools require goals:manage (in the default first-party permission set).
  if (sessionId !== null && can("goals:manage")) {
    registerGoalTools(server, deps, grant, sessionId, json);
  }
  // Toolspace grants are the sandbox's narrowed proxy surface. Unlike the
  // normal first-party worker token, a bare toolspace:call token does not see
  // unpermissioned session tools; memory follows that title/goal parity and
  // stays on the normal first-party MCP surface only.
  if (!toolspaceMode && sessionId !== null && options.workspaceMemoryEnabled === true) {
    registerMemoryTools(server, deps, grant, sessionId, json);
  }
  if (!toolspaceMode && sessionId !== null && preferenceAttemptClaims(grant) !== null) {
    registerPreferenceRegistryTools(server, deps, grant, json);
  }
  if (!toolspaceMode && sessionId !== null && preferenceAttemptClaims(grant) !== null) {
    registerWorkspaceArtifactTools(server, deps, grant, sessionId, json);
  }

  // Fleet tools (M7 bring-your-own-compute): list / attach / swap / run_on /
  // provision over the session's Modal box + the workspace's enrolled machines.
  // Session-scoped like goals (they steer THIS session's active-sandbox pointer),
  // so they register only when the grant carries the worker-signed sessionId claim
  // (never agent-controlled). Gated on the selfhosted feature flag: the active
  // pointer + swap are only meaningful when bring-your-own-compute is enabled.
  if (!toolspaceMode && sessionId !== null && deps.settings.sandboxSelfhostedEnabled) {
    registerFleetTools(server, deps, grant, sessionId, json);
  }
  if (!toolspaceMode) {
    registerRigTools(server, deps, grant, can, sessionId, json);
    registerSlackBotTools(server, deps, grant, sessionId, json);
  }

  // Orchestration, variableSet, and GitHub status tools are permission-gated
  // at registration: a grant without the permission does not see the tool.
  // Sandboxed workers reach this server with the first-party delegated
  // permission set (firstPartyMcpPermissions in @opengeni/runtime), which is
  // POWERFUL BY DEFAULT — it carries sessions:*, variable sets:*, and github:use,
  // so agents can spawn/read sessions, manage variable set variables, inspect
  // GitHub connection availability, and use already-bound repository resources
  // out of the box. GitHub installation credentials are refreshed host-side and
  // never returned through a model-visible MCP tool. A user DEMOTES a specific
  // session by setting a narrower session.firstPartyMcpPermissions (capped to
  // the creator's own grant); operators still cap what any session can be given.
  registerWorkspaceOrchestrationTools(server, deps, grant, can, sessionId, toolspaceMode, json);
  registerVariableSetTools(server, deps, grant, can, json);
  if (can("github:use")) {
    registerGitHubConnectTool(server, deps, grant, options, json);
  }

  if (!toolspaceMode || can("github:use")) {
    server.registerTool(
      "github_repositories_list",
      {
        description:
          "List GitHub App repositories available as scheduled task repository resources. Use the returned resource object in scheduled task agentConfig.resources.",
        inputSchema: { limit: z4.number().int().positive().optional() },
      },
      async ({ limit }) => {
        try {
          const repositories = await listWorkspaceGitHubRepositories(deps, grant.workspaceId);
          const visible = typeof limit === "number" ? repositories.slice(0, limit) : repositories;
          return json({
            repositories: visible.map((repository) =>
              repositoryWithScheduledTaskResource(repository),
            ),
          });
        } catch (error) {
          if (error instanceof GitHubAppConfigurationError) {
            throw new Error(`GitHub App is not configured: ${error.missing.join(", ")}`, {
              cause: error,
            });
          }
          throw error;
        }
      },
    );
  }

  if (!toolspaceMode || can("connections:read")) {
    server.registerTool(
      "social_connections_list",
      {
        description:
          "List connected social media accounts available to social media analysis packs.",
        inputSchema: { limit: z4.number().int().positive().optional() },
      },
      async ({ limit }) =>
        json({
          connections: (await authorizedSocialConnections())
            .slice(0, boundedMcpLimit(limit))
            .map(({ connection }) => connection),
        }),
    );

    server.registerTool(
      "social_posts_recent",
      {
        description: "List recent social media posts imported or synced into OpenGeni.",
        inputSchema: {
          connectionIds: z4.array(z4.string().uuid()).optional(),
          since: z4.string().optional(),
          windowHours: z4.number().int().positive().optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionIds, since, windowHours, limit }) => {
        const authorized = await authorizedSocialConnections();
        const selected = connectionIds?.length
          ? connectionIds.map((id) => {
              const match = authorized.find(({ connection }) => connection.id === id);
              if (!match) throw new Error(`Unknown or unavailable social connection: ${id}`);
              return match;
            })
          : authorized;
        const personalSubjectId = selected.find(({ subjectId }) => subjectId)?.subjectId ?? null;
        const sinceDate = since
          ? parseMcpDate(since, "since")
          : new Date(Date.now() - (windowHours ?? 24) * 60 * 60 * 1000);
        return json({
          since: sinceDate.toISOString(),
          posts: await listSocialPosts(deps.db, {
            workspaceId: grant.workspaceId,
            subjectId: personalSubjectId,
            connectionIds: selected.map(({ connection }) => connection.id),
            since: sinceDate,
            limit: boundedMcpLimit(limit),
          }),
        });
      },
    );

    server.registerTool(
      "social_daily_analysis_context",
      {
        description:
          "Collect social account and recent post context for a daily marketing analysis run.",
        inputSchema: {
          connectionIds: z4.array(z4.string().uuid()).optional(),
          documentBaseIds: z4.array(z4.string().uuid()).optional(),
          since: z4.string().optional(),
          windowHours: z4.number().int().positive().optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionIds, documentBaseIds, since, windowHours, limit }) => {
        const authorized = await authorizedSocialConnections();
        const allConnections = authorized.map(({ connection }) => connection);
        const selectedIds =
          connectionIds && connectionIds.length > 0 ? new Set(connectionIds) : null;
        const connections = selectedIds
          ? allConnections.filter((connection) => selectedIds.has(connection.id))
          : allConnections.filter((connection) => connection.status === "connected");
        if (selectedIds) {
          const foundIds = new Set(connections.map((connection) => connection.id));
          const missing = [...selectedIds].filter((id) => !foundIds.has(id));
          if (missing.length > 0) {
            throw new Error(`Unknown social connection IDs: ${missing.join(", ")}`);
          }
        }
        const sinceDate = since
          ? parseMcpDate(since, "since")
          : new Date(Date.now() - (windowHours ?? 24) * 60 * 60 * 1000);
        const posts =
          connections.length > 0
            ? await listSocialPosts(deps.db, {
                workspaceId: grant.workspaceId,
                subjectId:
                  authorized.find(
                    ({ connection, subjectId }) =>
                      subjectId && connections.some((selected) => selected.id === connection.id),
                  )?.subjectId ?? null,
                connectionIds: connections.map((connection) => connection.id),
                since: sinceDate,
                limit: boundedMcpLimit(limit),
              })
            : [];
        return json({
          generatedAt: new Date().toISOString(),
          window: {
            since: sinceDate.toISOString(),
            until: new Date().toISOString(),
          },
          documentBaseIds: documentBaseIds ?? [],
          connections,
          posts,
          instructions: [
            "Use docs MCP search tools for the supplied documentBaseIds when brand, campaign, or audience knowledge is needed.",
            "Report data gaps explicitly when posts or metrics are missing.",
            "Do not infer unpublished metrics or hidden platform data.",
          ],
        });
      },
    );

    // Live provider reads (X / Reddit). Tokens are resolved and used entirely
    // host-side; the agent only ever sees normalized post payloads.
    server.registerTool(
      "social_search_live",
      {
        description:
          "Search live conversations on a connected social account (X recent search or Reddit search). Use social_connections_list first to find the connectionId. For Reddit, pass subreddit to scope the search.",
        inputSchema: {
          connectionId: z4.string().uuid(),
          query: z4.string().min(1).max(512),
          subreddit: z4.string().min(1).max(100).optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionId, query, subreddit, limit }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialSearchLive(
          deps,
          { workspaceId: grant.workspaceId, connectionId, subjectId: authority.subjectId },
          { query, subreddit, limit },
        );
        return json({ provider: result.connection.provider, posts: result.posts });
      },
    );

    server.registerTool(
      "social_mentions_live",
      {
        description:
          "Fetch live mentions of the connected account (X mentions timeline, or the Reddit inbox with username mentions and comment replies).",
        inputSchema: {
          connectionId: z4.string().uuid(),
          sinceId: z4.string().optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionId, sinceId, limit }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialMentionsLive(
          deps,
          { workspaceId: grant.workspaceId, connectionId, subjectId: authority.subjectId },
          { sinceId, limit },
        );
        return json({ provider: result.connection.provider, posts: result.posts });
      },
    );

    server.registerTool(
      "social_thread_fetch",
      {
        description:
          "Fetch a live conversation thread: for X pass a tweet id (returns the conversation), for Reddit pass a post id or t3_ fullname (returns the post plus top comments).",
        inputSchema: {
          connectionId: z4.string().uuid(),
          id: z4.string().min(1).max(100),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionId, id, limit }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialThreadLive(
          deps,
          { workspaceId: grant.workspaceId, connectionId, subjectId: authority.subjectId },
          { id, limit },
        );
        return json({ provider: result.connection.provider, posts: result.posts });
      },
    );
  }

  // Writes are gated on connections:write (never in the default first-party
  // agent permission set) so scheduled tasks must opt in, and deployments can
  // additionally wrap posting in a requireApproval policy.
  if (!toolspaceMode || can("connections:write")) {
    server.registerTool(
      "social_posts_sync",
      {
        description:
          "Sync the connected account's own recent posts from the provider into OpenGeni's social_posts store (idempotent), so social_posts_recent and daily analysis see fresh data.",
        inputSchema: {
          connectionId: z4.string().uuid(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ connectionId, limit }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialOwnPostsLive(
          deps,
          { workspaceId: grant.workspaceId, connectionId, subjectId: authority.subjectId },
          { limit },
        );
        // A post without a provider timestamp is skipped rather than recorded
        // at sync time: publishedAt drives analysis windows, and the dedup
        // index would freeze a fabricated date forever.
        const datedPosts = result.posts.filter((post) => post.createdAt !== null);
        const synced = await recordSyncedSocialPosts(deps.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          connectionId,
          subjectId: authority.subjectId,
          posts: datedPosts.map((post) => ({
            externalPostId: post.id,
            url: post.url,
            authorHandle: post.author,
            text: post.text,
            publishedAt: new Date(post.createdAt!),
            metrics: post.metrics,
          })),
        });
        return json({
          provider: result.connection.provider,
          fetched: result.posts.length,
          inserted: synced.inserted,
          skipped: synced.skipped,
          skippedMissingDate: result.posts.length - datedPosts.length,
        });
      },
    );

    server.registerTool(
      "social_post_reply",
      {
        description:
          "Publish a reply from the connected social account. X: inReplyToId is the tweet id to reply to. Reddit: inReplyToId is a fullname (t3_<post> or t1_<comment>). Draft and get approval before calling this — it posts publicly and immediately.",
        inputSchema: {
          connectionId: z4.string().uuid(),
          inReplyToId: z4.string().min(1).max(100),
          text: z4.string().min(1).max(10000),
        },
      },
      async ({ connectionId, inReplyToId, text }) => {
        const authority = await requireAuthorizedSocialConnection(connectionId);
        const result = await socialPostReply(
          deps,
          { workspaceId: grant.workspaceId, connectionId, subjectId: authority.subjectId },
          { inReplyToId, text },
        );
        // Outbound publishes leave a durable, secret-free receipt (house
        // pattern: the Slack bot post audit), so who posted what where stays
        // answerable after the session is gone.
        await recordAuditEvent(deps.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
          action: "social.post_reply",
          targetType: "social_connection",
          targetId: connectionId,
          metadata: {
            provider: result.connection.provider,
            inReplyToId,
            postedId: result.postedId,
            url: result.url,
          },
        });
        return json({
          provider: result.connection.provider,
          postedId: result.postedId,
          url: result.url,
        });
      },
    );
  }

  if (!toolspaceMode || can("scheduled_tasks:manage") || can("scheduled_tasks:run")) {
    server.registerTool(
      "scheduled_tasks_list",
      {
        description:
          "List compact scheduled-task summaries. Prompts, goal text, resource/tool bodies, and metadata values are represented by byte/count facts; page with offset and use scheduled_tasks_get for a bounded explicit detail projection.",
        inputSchema: {
          limit: z4.number().int().positive().max(50).optional(),
          offset: z4.number().int().nonnegative().max(10_000).optional(),
        },
      },
      async ({ limit: requestedLimit, offset: requestedOffset }) => {
        const limit = requestedLimit ?? 25;
        const offset = requestedOffset ?? 0;
        const rows = await listScheduledTasks(deps.db, grant.workspaceId, limit + 1, offset);
        return json(
          boundScheduledTaskMcpPage({
            tasks: rows.slice(0, limit),
            limit,
            offset,
            sourceHasMore: rows.length > limit,
          }),
        );
      },
    );

    server.registerTool(
      "scheduled_tasks_get",
      {
        description:
          "Get one scheduled task. The default is the same compact summary used by scheduled_tasks_list; pass includeEntity=true for a bounded projection with an 8 KiB prompt preview, bounded goal fields, resource/tool identity previews, and metadata keys without values.",
        inputSchema: { id: z4.string().uuid(), includeEntity: z4.boolean().optional() },
      },
      async ({ id, includeEntity }) => {
        const task = await requireScheduledTask(deps.db, grant.workspaceId, id);
        return json(
          includeEntity ? boundScheduledTaskDetailMcp(task) : scheduledTaskMcpSummary(task),
        );
      },
    );

    server.registerTool(
      "scheduled_tasks_create",
      {
        description: "Create a scheduled task.",
        inputSchema: {
          name: z4.string(),
          schedule: z4.unknown(),
          runMode: z4.string().optional(),
          overlapPolicy: z4.string().optional(),
          agentConfig: z4.unknown(),
          status: z4.string().optional(),
          variableSetId: z4.string().uuid().optional(),
          // Deprecated alias of variableSetId; declared so MCP validation doesn't
          // strip it before the contract parse maps it (rename back-compat).
          environmentId: z4.string().uuid().optional(),
          // Bind the task to a rig; declared so MCP validation doesn't strip it.
          rigId: z4.string().uuid().nullable().optional(),
          metadata: z4.record(z4.string(), z4.unknown()).optional(),
        },
      },
      async (args) => {
        const payload = CreateScheduledTaskRequest.parse(args);
        requireVariableSetsUseForMcpAttachment(grant, payload.variableSetId);
        await requireLimit(deps, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          action: "schedule:create",
          quantity: 1,
        });
        const task = await createValidatedScheduledTask({
          settings: deps.settings,
          db: deps.db,
          objectStorage: deps.objectStorage,
          grant,
          payload,
          toolsProvided: scheduledTaskToolsProvided(args),
        });
        try {
          await syncCreatedScheduledTask({
            db: deps.db,
            workflowClient: deps.workflowClient,
            task,
          });
        } catch (error) {
          if (!(error instanceof ScheduledTaskSyncError) || error.persistenceRestored) {
            throw error;
          }
          return json(
            scheduledTaskReceipt("scheduled_tasks_create", task, "partial_failure", true, {
              partialFailure: { stage: "schedule_sync", retryable: true },
              warnings: [
                "The task database record committed, but Temporal schedule synchronization failed.",
              ],
            }),
          );
        }
        return json(scheduledTaskReceipt("scheduled_tasks_create", task, "created", true));
      },
    );

    server.registerTool(
      "scheduled_tasks_update",
      {
        description: "Update a scheduled task.",
        inputSchema: {
          id: z4.string().uuid(),
          name: z4.string().optional(),
          schedule: z4.unknown().optional(),
          runMode: z4.string().optional(),
          overlapPolicy: z4.string().optional(),
          agentConfig: z4.unknown().optional(),
          status: z4.string().optional(),
          variableSetId: z4.string().uuid().nullable().optional(),
          // Deprecated alias of variableSetId (rename back-compat); declared so MCP
          // validation doesn't strip it before the contract parse maps it.
          environmentId: z4.string().uuid().nullable().optional(),
          // Bind the task to a rig; declared so MCP validation doesn't strip it.
          rigId: z4.string().uuid().nullable().optional(),
          metadata: z4.record(z4.string(), z4.unknown()).optional(),
        },
      },
      async ({ id, ...raw }) => {
        const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
        const previous = await captureScheduledTaskRestoreState(deps.db, existing);
        const payload = UpdateScheduledTaskRequest.parse(raw);
        requireVariableSetsUseForMcpAttachment(grant, payload.variableSetId);
        const update = await validatedScheduledTaskUpdate({
          settings: deps.settings,
          db: deps.db,
          objectStorage: deps.objectStorage,
          grant,
          existing,
          payload,
          toolsProvided: scheduledTaskToolsProvided(raw),
        });
        const task = await updateScheduledTask(deps.db, grant.workspaceId, id, update);
        await syncUpdatedScheduledTask({
          db: deps.db,
          workflowClient: deps.workflowClient,
          previous,
          task,
        });
        return json(task);
      },
    );

    server.registerTool(
      "scheduled_tasks_pause",
      {
        description: "Pause a scheduled task.",
        inputSchema: { id: z4.string().uuid() },
      },
      async ({ id }) => {
        const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
        const previous = await captureScheduledTaskRestoreState(deps.db, existing);
        const task = await updateScheduledTask(deps.db, grant.workspaceId, id, {
          status: "paused",
        });
        await syncUpdatedScheduledTask({
          db: deps.db,
          workflowClient: deps.workflowClient,
          previous,
          task,
        });
        return json(task);
      },
    );

    server.registerTool(
      "scheduled_tasks_resume",
      {
        description: "Resume a scheduled task.",
        inputSchema: { id: z4.string().uuid() },
      },
      async ({ id }) => {
        const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
        const previous = await captureScheduledTaskRestoreState(deps.db, existing);
        const task = await updateScheduledTask(deps.db, grant.workspaceId, id, {
          status: "active",
        });
        await syncUpdatedScheduledTask({
          db: deps.db,
          workflowClient: deps.workflowClient,
          previous,
          task,
        });
        return json(task);
      },
    );

    server.registerTool(
      "scheduled_tasks_trigger",
      {
        description:
          "Trigger a scheduled task immediately. Pass a stable triggerId to make a retried trigger idempotent (one charge, one run).",
        inputSchema: {
          id: z4.string().uuid(),
          triggerId: z4.string().min(1).max(128).optional(),
        },
      },
      async ({ id, triggerId }) => {
        const task = await requireScheduledTask(deps.db, grant.workspaceId, id);
        await requireLimit(deps, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          action: "agent_run:create",
          quantity: 1,
          model: task.agentConfig.model ?? deps.settings.openaiModel,
        });
        const triggerToken = scheduledTaskTriggerToken(triggerId);
        const agentRunUsageIdempotencyKey = manualScheduledTaskTriggerUsageKey(
          grant.workspaceId,
          task.id,
          triggerToken,
        );
        const triggerWorkflowId = manualScheduledTaskTriggerWorkflowId(task.id, triggerToken);
        await deps.workflowClient.triggerScheduledTask({
          task,
          agentRunUsageIdempotencyKey,
          triggerWorkflowId,
          initiator: { kind: "subject", subjectId: grant.subjectId },
        });
        try {
          await recordWorkspaceUsage(deps, {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            subjectId: grant.subjectId,
            eventType: "agent_run.created",
            quantity: 1,
            unit: "run",
            sourceResourceType: "scheduled_task",
            sourceResourceId: task.id,
            idempotencyKey: agentRunUsageIdempotencyKey,
          });
        } catch {
          return json(
            scheduledTaskReceipt("scheduled_tasks_trigger", task, "partial_failure", true, {
              partialFailure: { stage: "usage_recording", retryable: true },
              warnings: [
                "The Temporal run trigger completed, but usage recording failed; retry with the same triggerId.",
              ],
              idempotencyStatus: triggerId ? "unknown" : "not_requested",
              facts: { triggerWorkflowId },
            }),
          );
        }
        return json(
          scheduledTaskReceipt("scheduled_tasks_trigger", task, "triggered", true, {
            idempotencyStatus: triggerId ? "unknown" : "not_requested",
            facts: { triggerWorkflowId },
          }),
        );
      },
    );

    server.registerTool(
      "scheduled_tasks_delete",
      {
        description: "Delete a scheduled task.",
        inputSchema: { id: z4.string().uuid() },
      },
      async ({ id }) => {
        const task = await requireScheduledTask(deps.db, grant.workspaceId, id);
        await deps.workflowClient.deleteScheduledTaskSchedule({
          temporalScheduleId: task.temporalScheduleId,
        });
        try {
          await deleteScheduledTask(deps.db, grant.workspaceId, id);
        } catch {
          return json(
            scheduledTaskReceipt("scheduled_tasks_delete", task, "partial_failure", true, {
              partialFailure: { stage: "database_delete", retryable: true },
              warnings: [
                "The Temporal schedule was deleted, but the task database record remains.",
              ],
            }),
          );
        }
        return json(
          mcpMutationReceipt({
            operation: "scheduled_tasks_delete",
            committed: true,
            outcome: "deleted",
            changed: true,
            resource: { type: "scheduled_task", id: task.id, state: "deleted" },
            idempotency: { status: "not_supported" },
          }),
        );
      },
    );

    server.registerTool(
      "scheduled_task_runs_list",
      {
        description: "List runs for a scheduled task.",
        inputSchema: {
          taskId: z4.string().uuid(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ taskId, limit }) =>
        json({
          runs: await listScheduledTaskRuns(deps.db, grant.workspaceId, taskId, limit ?? 100),
        }),
    );
  }

  registerToolspaceProxyTools(server, options.toolspace ?? null);
  server.ensureToolsListHandler();

  return server;
}

function registerSlackBotTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string | null,
  json: JsonResult,
): void {
  const clientFor = async (connectionId?: string) => {
    const resolved = await resolveSlackBotConnectionForTool({
      db: deps.db,
      grant,
      sessionId,
      ...(connectionId ? { requestedConnectionId: connectionId } : {}),
    });
    return createOpenGeniSlackBotClient(deps, resolved);
  };

  server.registerTool(
    "slack_bot_list_channels",
    {
      description:
        "List public and bot-visible private Slack channels through the workspace-shared OpenGeni bot. isMember identifies channels the bot may read/post in; the bot never joins channels automatically.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(200).optional(),
      },
    },
    async ({ connectionId, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).listChannels({
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_channel_history",
    {
      description:
        "Read Slack channel history as the workspace-shared OpenGeni bot. Public and private channels both require bot membership; invite the bot to private channels first.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(100).optional(),
      },
    },
    async ({ connectionId, channelId, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).channelHistory({
          channelId,
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_thread_replies",
    {
      description:
        "Read a Slack thread as the workspace-shared OpenGeni bot. Pass the channel ID and the parent message timestamp returned by channel history. The result includes the parent followed by its replies.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        threadTimestamp: z4.string().min(1).max(64),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(100).optional(),
      },
    },
    async ({ connectionId, channelId, threadTimestamp, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).threadReplies({
          channelId,
          threadTimestamp,
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_list_users",
    {
      description: "List Slack workspace users through the workspace-shared OpenGeni bot.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(200).optional(),
      },
    },
    async ({ connectionId, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).listUsers({
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_list_files",
    {
      description:
        "List Slack files and canvases shared with a channel where the workspace-shared OpenGeni bot is already a member.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        cursor: z4.string().max(1024).optional(),
        limit: z4.number().int().min(1).max(200).optional(),
      },
    },
    async ({ connectionId, channelId, cursor, limit }) =>
      json(
        await (
          await clientFor(connectionId)
        ).listFiles({
          channelId,
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_file_info",
    {
      description:
        "Read safe metadata for a Slack file or canvas shared with a channel where the workspace-shared OpenGeni bot is already a member. For an embedded huddle transcript, also pass the shared canvas file ID as parentFileId so OpenGeni can verify the indirect share.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        fileId: z4.string().min(1).max(64),
        parentFileId: z4.string().min(1).max(64).optional(),
      },
    },
    async ({ connectionId, channelId, fileId, parentFileId }) =>
      json(
        await (
          await clientFor(connectionId)
        ).fileInfo({
          channelId,
          fileId,
          ...(parentFileId ? { parentFileId } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_file_content",
    {
      description:
        "Read a bounded page of UTF-8 text from a Slack file or canvas shared with a channel where the workspace-shared OpenGeni bot is already a member. For an embedded huddle transcript, also pass the shared canvas file ID as parentFileId so OpenGeni can verify the channel-to-canvas-to-transcript chain. Slack may still restrict a huddle transcript body to participants; that returns huddle_transcript_requires_participant_access. Private Slack URLs and credentials are never returned. Continue with nextOffset when truncated is true.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        channelId: z4.string().min(1).max(64),
        fileId: z4.string().min(1).max(64),
        parentFileId: z4.string().min(1).max(64).optional(),
        offset: z4.number().int().min(0).max(4_000_000).optional(),
      },
    },
    async ({ connectionId, channelId, fileId, parentFileId, offset }) =>
      json(
        await (
          await clientFor(connectionId)
        ).fileContent({
          channelId,
          fileId,
          ...(parentFileId ? { parentFileId } : {}),
          ...(offset !== undefined ? { offset } : {}),
        }),
      ),
  );

  server.registerTool(
    "slack_bot_post_message",
    {
      description:
        "Post as the workspace-shared OpenGeni bot. Pass channelId for a channel where the bot is already a member, or userId to open/post a DM; pass exactly one. To reply in a thread, also pass its parent message timestamp as threadTimestamp. Generate one operationId UUID per intended message and reuse that same UUID on every retry.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        operationId: z4.string().uuid(),
        channelId: z4.string().min(1).max(64).optional(),
        userId: z4.string().min(1).max(64).optional(),
        threadTimestamp: z4.string().min(1).max(64).optional(),
        text: z4.string().min(1).max(40_000),
      },
    },
    async ({ connectionId, operationId, channelId, userId, threadTimestamp, text }) => {
      if (Boolean(channelId) === Boolean(userId)) {
        throw new Error("exactly one of channelId or userId is required");
      }
      return json(
        await (
          await clientFor(connectionId)
        ).postMessage({
          operationId,
          ...(channelId ? { channelId } : {}),
          ...(userId ? { userId } : {}),
          ...(threadTimestamp ? { threadTimestamp } : {}),
          text,
        }),
      );
    },
  );

  server.registerTool(
    "slack_bot_delete_message",
    {
      description:
        "Delete a message authored by the workspace-shared OpenGeni bot. Pass the channel ID and exact message timestamp returned by a prior post or channel/thread read. Generate one operationId UUID per intended deletion and reuse it on every retry, including after an unknown outcome. Slack refuses deletion of messages not authored by this bot.",
      inputSchema: {
        connectionId: z4.string().uuid().optional(),
        operationId: z4.string().uuid(),
        channelId: z4.string().min(1).max(64),
        timestamp: z4.string().min(1).max(64),
      },
    },
    async ({ connectionId, operationId, channelId, timestamp }) =>
      json(
        await (await clientFor(connectionId)).deleteMessage({ operationId, channelId, timestamp }),
      ),
  );
}

function registerToolspaceProxyTools(server: McpServer, surface: ToolspaceMcpSurface | null): void {
  if (!surface) {
    return;
  }
  // McpServer installs its tools/list handler lazily on the first registered
  // tool. A legitimate empty Toolspace surface (no selected proxyable servers,
  // no active turn, or all optional upstreams unavailable) must therefore seed
  // and disable one invisible tool; otherwise `ogtool list` receives JSON-RPC
  // "Method not found" instead of the valid `{ tools: [] }` response.
  if (surface.tools.length === 0) {
    server
      .registerTool(
        "__opengeni_empty_toolspace_surface__",
        {
          description: "Internal disabled placeholder for an empty Toolspace surface.",
          inputSchema: z4.object({}),
        },
        async () => ({
          content: [{ type: "text" as const, text: '{"unavailable":true}' }],
        }),
      )
      .disable();
    return;
  }
  for (const tool of surface.tools) {
    server.registerTool(
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: z4.object({}).passthrough(),
        _meta: {
          opengeni: {
            origin: "toolspace",
            subjectId: surface.subjectId,
            sessionId: surface.sessionId,
            ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
          },
        },
      },
      async (args) => await tool.call(args),
    );
  }
}

/** Only a prompt explicitly supplied through the human/API channel may redirect a user-paused goal. */
export function isHumanDirectedTurn(turn: { source: string }): boolean {
  return turn.source === "user" || turn.source === "api";
}

/**
 * Sacred user pause: a goal a human paused (pausedReason 'user_pause') must
 * never be resurrected by a MACHINE turn. Child-completion notification turns
 * carry a "resume it now" nudge; without this guard the agent processing one of
 * them would call goal_set and re-arm the exact autonomous loop the user just
 * paused (the runaway that made Pause feel broken). A genuine user message
 * still redirects freely (it is not a child-notification turn), and the
 * human-driven API resume path (PATCH /goal) is unaffected.
 *
 * Classification is by CALLER IDENTITY — `callerTurnId` is the turn that minted
 * this MCP token (signed into it by the worker at turn setup). We deliberately
 * do NOT read the session's live `active_turn_id`: that pointer can flip to a
 * different turn between reads (a machine turn ends and a human turn becomes
 * active mid-check), which would misclassify the caller and, worst case, refuse
 * a legitimate human `goal_set` — inverting the guard against the very human
 * power it must preserve. A caller turn's source/metadata are immutable, so this
 * read is race-free. No caller identity ⇒ fail OPEN (only a positively
 * identified machine child-notification caller is refused).
 */
export async function assertGoalReactivationAllowed(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
  callerTurnId: string | null,
): Promise<void> {
  if (!callerTurnId) {
    return;
  }
  const goal = await getSessionGoal(deps.db, workspaceId, sessionId);
  if (!goal || goal.status !== "paused" || goal.pausedReason !== "user_pause") {
    return;
  }
  const turn = await getSessionTurn(deps.db, workspaceId, callerTurnId);
  if (turn && !isHumanDirectedTurn(turn)) {
    throw new Error(
      "This session was paused by the user. An internal turn cannot resume or replace the goal — only a new human/API prompt can. Report your findings and do not call goal_set.",
    );
  }
}

function registerGoalTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: (value: unknown) => { content: Array<{ type: "text"; text: string }> },
): void {
  server.registerTool(
    "goal_set",
    {
      description:
        "Set or replace this session's goal. While a goal is active the session keeps working: idle moments synthesize continuation turns until goal_complete or goal_pause is called. Replacing a goal reactivates it and resets the continuation budget.",
      inputSchema: {
        text: z4.string().min(1),
        successCriteria: z4.string().min(1).optional(),
        maxAutoContinuations: z4.number().int().positive().optional(),
      },
    },
    async ({ text, successCriteria, maxAutoContinuations }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const callerTurnId =
        typeof grant.metadata?.["turnId"] === "string"
          ? (grant.metadata["turnId"] as string)
          : null;
      await assertGoalReactivationAllowed(deps, grant.workspaceId, sessionId, callerTurnId);
      const { goal, events } = await upsertSessionGoalWithEvent(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        text,
        successCriteria: successCriteria ?? null,
        maxAutoContinuations: maxAutoContinuations ?? null,
        createdBy: "agent",
        actor: "agent",
      });
      if (events.length > 0) {
        await deps.bus.publish(grant.workspaceId, sessionId, events);
      }
      return json(goal);
    },
  );

  server.registerTool(
    "goal_update",
    {
      description:
        "Revise the session goal's text or success criteria, or record a progress note. Counts as progress for the no-progress detector; the goal stays active.",
      inputSchema: {
        text: z4.string().min(1).optional(),
        successCriteria: z4.string().min(1).optional(),
        progressNote: z4.string().min(1).optional(),
        idempotencyKey: z4.string().uuid(),
      },
    },
    async ({ text, successCriteria, progressNote, idempotencyKey }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      const context = exactAgentCommandContext(grant, sessionId);
      const { goal, events, operationId, replay } = await updateSessionGoalWithEvent(
        deps.db,
        grant.workspaceId,
        sessionId,
        {
          ...(text !== undefined ? { text } : {}),
          ...(successCriteria !== undefined ? { successCriteria } : {}),
          ...(progressNote !== undefined ? { progressNote } : {}),
          actor: "agent",
          command: {
            accountId: grant.accountId,
            actor: {
              type: "agent_attempt",
              attemptId: context.callerAttemptId,
              sessionId: context.callerSessionId,
              turnId: context.callerTurnId,
              executionGeneration: context.callerExecutionGeneration,
            },
            operationKey: idempotencyKey,
          },
        },
      );
      await publishDurableSessionEvents(deps.bus, grant.workspaceId, sessionId, events);
      return json({ ...goal, operationId, replay });
    },
  );

  server.registerTool(
    "goal_complete",
    {
      description:
        "Mark the session goal as completed. Requires concrete evidence (what was done and how it satisfies the success criteria). Completion prevents further continuation turns.",
      inputSchema: { evidence: z4.string().min(1) },
    },
    async ({ evidence }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (!existing) {
        throw new Error("this session has no goal; use goal_set first");
      }
      const { goal, events } = await setSessionGoalStatusWithEvent(
        deps.db,
        grant.workspaceId,
        sessionId,
        {
          status: "completed",
          evidence,
          event: { type: "goal.completed", evidence },
        },
      );
      const changed = events.length > 0;
      if (events.length > 0) {
        await deps.bus.publish(grant.workspaceId, sessionId, events);
      }
      return json(
        mcpMutationReceipt({
          operation: "goal_complete",
          committed: true,
          outcome: changed ? "updated" : "unchanged",
          changed,
          resource: {
            type: "session_goal",
            id: goal.id,
            version: goal.version,
            state: goal.status,
          },
          timestamp: goal.updatedAt,
          idempotency: { status: "not_supported" },
          nextAction: { tool: "session_get", arguments: { sessionId } },
        }),
      );
    },
  );

  server.registerTool(
    "goal_pause",
    {
      description:
        "Pause the session goal with a rationale (blocked, not productive, needs human input). No further continuation turns are synthesized until the goal is resumed or replaced.",
      inputSchema: { rationale: z4.string().min(1) },
    },
    async ({ rationale }) => {
      await authorizeFirstPartySession(deps, grant, sessionId, "session.goal.write");
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (!existing) {
        throw new Error("this session has no goal; use goal_set first");
      }
      const { goal, events } = await setSessionGoalStatusWithEvent(
        deps.db,
        grant.workspaceId,
        sessionId,
        {
          status: "paused",
          rationale,
          pausedReason: "agent",
          event: {
            type: "goal.paused",
            actor: "agent",
            reason: "agent",
            rationale,
          },
        },
      );
      const changed = events.length > 0;
      if (events.length > 0) {
        await deps.bus.publish(grant.workspaceId, sessionId, events);
      }
      return json(
        mcpMutationReceipt({
          operation: "goal_pause",
          committed: true,
          outcome: changed ? "updated" : "unchanged",
          changed,
          resource: {
            type: "session_goal",
            id: goal.id,
            version: goal.version,
            state: goal.status,
          },
          timestamp: goal.updatedAt,
          idempotency: { status: "not_supported" },
          nextAction: { tool: "session_get", arguments: { sessionId } },
        }),
      );
    },
  );
}

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

async function authorizeFirstPartySession(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  operation: SessionAuthorizationOperation,
): Promise<ResolvedSessionAuthorization | null> {
  return await requireSessionAuthorization(deps, grant, {
    sessionId,
    operation,
    surface: "first_party_mcp",
  });
}

function registerWorkspaceArtifactTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  const attempt = () => {
    const claims = preferenceAttemptClaims(grant);
    if (!claims) throw new Error("Exact signed artifact attempt authority is required.");
    return claims;
  };
  const authorize = async () => {
    await authorizeFirstPartySession(deps, grant, sessionId, "session.first_party_mcp.call");
  };
  const prepare = (html: string) => {
    if (!deps.objectStorage) throw new Error("Object storage is not configured");
    const bytes = new TextEncoder().encode(html);
    if (bytes.byteLength < 1 || bytes.byteLength > WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES) {
      throw new Error(
        `Artifact HTML must be 1-${WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES} UTF-8 bytes`,
      );
    }
    const contentSha256 = createHash("sha256").update(bytes).digest("hex");
    const contentKey = `workspaces/${grant.workspaceId}/workspace-artifacts/blobs/${contentSha256}.html`;
    return {
      contentKey,
      contentSha256,
      sizeBytes: bytes.byteLength,
      persistContent: async () => {
        await deps.objectStorage!.putObject({
          key: contentKey,
          contentType: "text/html; charset=utf-8",
          body: bytes,
          sha256: contentSha256,
        });
      },
    };
  };
  const provenance = (
    idempotencyKey: string,
    sourceToolName: "artifacts_create" | "artifacts_publish" | "artifacts_rollback",
  ) => {
    const claims = attempt();
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      operationKey: `attempt:${createHash("sha256")
        .update(
          `${claims.sessionId}:${claims.turnId}:${claims.attemptId}:${claims.executionGeneration}:${idempotencyKey}`,
        )
        .digest("hex")}`,
      actorSubjectId: grant.subjectId,
      sourceSessionId: claims.sessionId,
      sourceTurnId: claims.turnId,
      sourceAttemptId: claims.attemptId,
      sourceExecutionGeneration: claims.executionGeneration,
      sourceToolName,
    };
  };

  server.registerTool(
    "artifacts_list",
    {
      description:
        "List the generic published artifacts in this workspace and their current versions.",
      inputSchema: {},
    },
    async () => {
      await authorize();
      return json(await listWorkspaceArtifacts(deps.db, grant.workspaceId));
    },
  );

  server.registerTool(
    "artifacts_get_source",
    {
      description:
        "Read an artifact's metadata and exact HTML source. Omit versionId for the current version.",
      inputSchema: {
        artifactId: z4.string().uuid(),
        versionId: z4.string().uuid().optional(),
      },
    },
    async ({ artifactId, versionId }) => {
      await authorize();
      if (!deps.objectStorage) throw new Error("Object storage is not configured");
      const [detail, ref] = await Promise.all([
        getWorkspaceArtifact(deps.db, grant.workspaceId, artifactId),
        getWorkspaceArtifactContentRef(deps.db, grant.workspaceId, artifactId, versionId),
      ]);
      const object = await deps.objectStorage.getObjectBytes(ref.contentKey);
      if (!object) throw new Error("Artifact content is unavailable");
      const actualHash = createHash("sha256").update(object.bytes).digest("hex");
      if (actualHash !== ref.version.contentSha256)
        throw new Error("Artifact content failed integrity verification");
      return json({ detail, version: ref.version, html: new TextDecoder().decode(object.bytes) });
    },
  );

  server.registerTool(
    "artifacts_create",
    {
      description:
        "Create and publish a generic static workspace artifact from a complete, self-contained HTML document with inline CSS. JavaScript and active or navigation-capable markup do not render in the MVP.",
      inputSchema: {
        title: z4.string().min(1).max(120),
        description: z4.string().max(2000).nullable().optional(),
        slug: z4
          .string()
          .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
          .max(96)
          .optional(),
        html: z4.string().min(1).max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    async ({ title, description, slug, html, idempotencyKey }) => {
      await authorize();
      const artifactId = crypto.randomUUID();
      const slugBase = slug ?? (normalizeWorkspaceArtifactSlug(title) || "artifact");
      const resolvedSlug = slug ?? `${slugBase.slice(0, 87)}-${artifactId.slice(0, 8)}`;
      return json(
        await createWorkspaceArtifact(deps.db, {
          artifactId,
          slug: resolvedSlug,
          title,
          description: description ?? null,
          ...prepare(html),
          ...provenance(idempotencyKey, "artifacts_create"),
        }),
      );
    },
  );

  server.registerTool(
    "artifacts_publish",
    {
      description:
        "Publish a new immutable static HTML/CSS version. JavaScript and active or navigation-capable markup do not render in the MVP. First read the current source and pass its version id for optimistic concurrency.",
      inputSchema: {
        artifactId: z4.string().uuid(),
        expectedCurrentVersionId: z4.string().uuid(),
        title: z4.string().min(1).max(120).optional(),
        description: z4.string().max(2000).nullable().optional(),
        html: z4.string().min(1).max(WORKSPACE_ARTIFACT_HTML_MAX_UTF8_BYTES),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    async ({ artifactId, expectedCurrentVersionId, title, description, html, idempotencyKey }) => {
      await authorize();
      return json(
        await publishWorkspaceArtifactVersion(deps.db, {
          artifactId,
          expectedCurrentVersionId,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...prepare(html),
          ...provenance(idempotencyKey, "artifacts_publish"),
        }),
      );
    },
  );

  server.registerTool(
    "artifacts_rollback",
    {
      description:
        "Promote an existing immutable artifact version back to current without rewriting history.",
      inputSchema: {
        artifactId: z4.string().uuid(),
        versionId: z4.string().uuid(),
        expectedCurrentVersionId: z4.string().uuid(),
        reason: z4.string().min(1).max(4096),
        idempotencyKey: z4.string().min(1).max(200),
      },
    },
    async ({ artifactId, versionId, expectedCurrentVersionId, reason, idempotencyKey }) => {
      await authorize();
      return json(
        await rollbackWorkspaceArtifact(deps.db, {
          artifactId,
          versionId,
          expectedCurrentVersionId,
          reason,
          ...provenance(idempotencyKey, "artifacts_rollback"),
        }),
      );
    },
  );
}

function preferenceAttemptClaims(grant: AccessGrant): {
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
} | null {
  const metadata = grant.metadata ?? {};
  if (
    typeof metadata["sessionId"] !== "string" ||
    typeof metadata["turnId"] !== "string" ||
    typeof metadata["attemptId"] !== "string" ||
    typeof metadata["executionGeneration"] !== "number" ||
    !Number.isSafeInteger(metadata["executionGeneration"]) ||
    metadata["executionGeneration"] < 1 ||
    metadata["executionGeneration"] > 2_147_483_647
  ) {
    return null;
  }
  return {
    sessionId: metadata["sessionId"],
    turnId: metadata["turnId"],
    attemptId: metadata["attemptId"],
    executionGeneration: metadata["executionGeneration"],
  };
}

function registerPreferenceRegistryTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  json: JsonResult,
): void {
  const attemptClaims = () => {
    const resolved = preferenceAttemptClaims(grant);
    if (!resolved) throw new Error("Exact signed preference attempt authority is required.");
    return {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      ...resolved,
    };
  };

  server.registerTool(
    "preference_registry_summary",
    {
      description:
        "List bounded deterministic descriptors for organization, workspace, and immutable initiating-human preferences frozen to this exact attempt. Full content is omitted; retrieve only a relevant returned handle.",
      inputSchema: {},
    },
    async () => json(await getOrCreatePreferenceRegistrySnapshot(deps.db, attemptClaims())),
  );

  server.registerTool(
    "preference_registry_get",
    {
      description:
        "Retrieve full content for one preference in this exact attempt snapshot. Handles from another account, workspace, human, or attempt are rejected.",
      inputSchema: { retrievalHandle: z4.string().min(1).max(512) },
    },
    async ({ retrievalHandle }) =>
      json(await getPreferenceRegistryFullContent(deps.db, attemptClaims(), retrievalHandle)),
  );
}

const MemoryKindSchema = z4.enum(["preference", "semantic", "procedural", "decision", "episodic"]);

function scheduledTaskReceipt(
  operation: string,
  task: ScheduledTask,
  outcome: "created" | "updated" | "unchanged" | "triggered" | "partial_failure",
  changed: boolean,
  options: {
    partialFailure?: { stage: string; retryable: boolean };
    warnings?: string[];
    idempotencyStatus?: "not_supported" | "not_requested" | "applied" | "replayed" | "unknown";
    facts?: Record<string, string | number | boolean | null>;
  } = {},
) {
  return mcpMutationReceipt({
    operation,
    committed: true,
    outcome,
    changed,
    resource: {
      type: "scheduled_task",
      id: task.id,
      version: task.updatedAt,
      state: task.status,
    },
    timestamp: task.updatedAt,
    idempotency: { status: options.idempotencyStatus ?? "not_supported" },
    ...(options.partialFailure ? { partialFailure: options.partialFailure } : {}),
    ...(options.warnings ? { warnings: options.warnings } : {}),
    ...(options.facts ? { facts: options.facts } : {}),
    nextAction: { tool: "scheduled_tasks_get", arguments: { id: task.id } },
  });
}

function memoryPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 119)}…`;
}

function registerMemoryTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  server.registerTool(
    "memory_search",
    {
      description: MEMORY_SEARCH_TOOL_DESCRIPTION,
      inputSchema: {
        query: z4.string().min(1),
        kind: MemoryKindSchema.optional(),
        limit: z4.number().int().positive().max(20).optional(),
      },
    },
    async ({ query, kind, limit }) =>
      json({
        results: await searchWorkspaceMemories(
          deps.db,
          grant.workspaceId,
          {
            query,
            ...(kind ? { kind } : {}),
            ...(limit ? { limit } : {}),
          },
          deps.getDocumentServices().embedder,
        ),
      }),
  );

  server.registerTool(
    "memory_save",
    {
      description: MEMORY_SAVE_TOOL_DESCRIPTION,
      inputSchema: {
        text: z4.string().min(1),
        kind: MemoryKindSchema,
        confidence: z4.number().min(0).max(1).optional(),
        replaces_id: z4.string().min(1).optional(),
      },
    },
    async ({ text, kind, confidence, replaces_id }) => {
      const result = await saveWorkspaceMemory(
        deps.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          text,
          kind,
          ...(confidence !== undefined ? { confidence } : {}),
          ...(replaces_id ? { replacesId: replaces_id } : {}),
          origin: "agent",
        },
        deps.getDocumentServices().embedder,
      );
      await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [
        {
          type: "memory.saved",
          payload: {
            memoryId: result.memory.id,
            kind: result.memory.kind,
            preview: memoryPreview(result.memory.text),
            deduped: result.deduped,
            ...(result.superseded ? { supersededMemoryId: result.superseded.id } : {}),
          },
        },
      ]);
      const changed = !result.deduped || result.updated || result.superseded !== null;
      const outcome =
        result.updated || result.superseded !== null
          ? "updated"
          : result.deduped
            ? "unchanged"
            : "created";
      return json(
        mcpMutationReceipt({
          operation: "memory_save",
          committed: true,
          outcome,
          changed,
          resource: {
            type: "knowledge_memory",
            id: result.memory.id,
            state: result.memory.status,
          },
          relatedResources: result.superseded
            ? [
                {
                  type: "knowledge_memory",
                  id: result.superseded.id,
                  state: result.superseded.status,
                },
              ]
            : undefined,
          timestamp: result.memory.updatedAt,
          idempotency: { status: "not_supported" },
          warnings: [
            ...(result.redactionCount > 0
              ? [`Redacted ${result.redactionCount} sensitive value(s) before committing memory.`]
              : []),
            ...(!result.embedded
              ? ["Memory committed without a vector embedding; keyword search remains available."]
              : []),
          ],
          facts: {
            deduped: result.deduped,
            dedupeReason: result.dedupeReason,
            updatedInPlace: result.updated,
            redactionCount: result.redactionCount,
            embedded: result.embedded,
          },
        }),
      );
    },
  );

  server.registerTool(
    "memory_correct",
    {
      description: MEMORY_CORRECT_TOOL_DESCRIPTION,
      inputSchema: {
        id: z4.string().min(1),
        reason: z4.string().min(1).optional(),
        replacement_text: z4.string().min(1).optional(),
      },
    },
    async ({ id, reason, replacement_text }) => {
      const result = await correctWorkspaceMemory(
        deps.db,
        {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          id,
          ...(reason ? { reason } : {}),
          ...(replacement_text ? { replacementText: replacement_text } : {}),
        },
        deps.getDocumentServices().embedder,
      );
      await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [
        {
          type: "memory.corrected",
          payload: {
            memoryId: result.memory.id,
            kind: result.memory.kind,
            preview: memoryPreview(result.memory.text),
            action: result.action,
            ...(reason ? { reason: memoryPreview(reason) } : {}),
            ...(result.replacement
              ? {
                  replacementMemoryId: result.replacement.id,
                  replacementPreview: memoryPreview(result.replacement.text),
                }
              : {}),
          },
        },
      ]);
      return json(
        mcpMutationReceipt({
          operation: "memory_correct",
          committed: true,
          outcome: "updated",
          changed: true,
          resource: {
            type: "knowledge_memory",
            id: result.memory.id,
            state: result.memory.status,
          },
          relatedResources: result.replacement
            ? [
                {
                  type: "knowledge_memory",
                  id: result.replacement.id,
                  state: result.replacement.status,
                },
              ]
            : undefined,
          timestamp: (result.replacement ?? result.memory).updatedAt,
          idempotency: { status: "not_supported" },
          facts: { correctionAction: result.action },
        }),
      );
    },
  );
}

// Fleet tools (M7 bring-your-own-compute). Session-scoped (they steer THIS
// session's active-sandbox pointer + reach the workspace's enrolled machines),
// registered only with the worker-signed sessionId claim + the selfhosted flag.
// The agent uses these to list the fleet (its Modal box + enrolled machines),
// attach/swap the active sandbox mid-conversation (heterogeneous, single-active,
// epoch-fenced), run a one-off op on a specific machine without swapping, and
// surface provisioning (enroll-a-machine) instructions to a human.
function registerFleetTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  const services: FleetServices = {
    db: deps.db,
    settings: deps.settings,
    bus: deps.bus,
    ensureSessionGroupReady: async (ctx) => {
      const session = await requireSession(deps.db, ctx.workspaceId, ctx.sessionId);
      return await ensureViewerSessionGroupReady(
        { db: deps.db, settings: deps.settings, bus: deps.bus },
        { accountId: ctx.accountId, workspaceId: ctx.workspaceId, session },
      );
    },
  };

  // Resolve the session's group sandbox (the default/home fleet member) at
  // call-time via the shared helper (same context the user-authenticated swap
  // REST route builds). Throws when the session has no box (backend:none) — the
  // fleet is only meaningful for a session that runs in a sandbox.
  const fleetContext = async (): Promise<FleetContext> =>
    await buildFleetContextForSession(deps, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
    });

  server.registerTool(
    "sandboxes_list",
    {
      description:
        "List the sandboxes this session can run on: its own session sandbox plus enrolled selfhosted machines. `liveness` is conservative: online requires observed provider existence and verified workspace readiness. An idle session-home sandbox may report offline/cold/draining and still wake or restore on the next ordinary sandbox operation; never infer that shell/files are unavailable from list liveness alone—only a typed operation/attach failure proves that. Provider, lease, route, archive, restore, workspace, lease epoch, and route epoch are also reported separately. Use an entry `id` as an attach/swap/run_on target.",
      inputSchema: {},
    },
    async () => json(await listFleet(services, await fleetContext())),
  );

  server.registerTool(
    "sandbox_attach",
    {
      description:
        'Attach this session to a sandbox for the next tool call. The target must be owned and verified ready. A same-target attach is a repair request: it revalidates readiness and advances the route epoch rather than returning unchanged success. Recovery-in-progress/degraded/unrecoverable outcomes are typed. Use a sandboxes_list `id`, or "session"/"default" for home.',
      inputSchema: { target: z4.string().min(1) },
    },
    async ({ target }) => json(await swapActiveSandbox(services, await fleetContext(), target)),
  );

  server.registerTool(
    "sandbox_swap",
    {
      description:
        'Swap the active sandbox for this session mid-conversation. Validates ownership and verified readiness, then advances the route epoch. Same-target swaps also revalidate and fence stale route caches. An operation that encountered provider disappearance is not replayed; retry only after a typed recovery-ready result. Use a sandboxes_list `id`, or "session"/"default" for home.',
      inputSchema: { target: z4.string().min(1) },
    },
    async ({ target }) => json(await swapActiveSandbox(services, await fleetContext(), target)),
  );

  server.registerTool(
    "run_on",
    {
      description:
        "Run a ONE-OFF op on a SPECIFIC enrolled selfhosted machine WITHOUT changing this session's active sandbox (a side-channel to another machine). Ops: exec (run a command), read (read a file), write (write a file). Exec returns exact exitCode plus typed timedOut and the effective deadlineMs; a deadline kill or missing exit proof is never ok:true, and an ambiguous transport loss is not replayed. `target` = a selfhosted sandboxes_list `id`. To make a machine the active sandbox instead, use sandbox_swap.",
      inputSchema: {
        target: z4.string().min(1),
        op: z4.discriminatedUnion("kind", [
          z4.object({
            kind: z4.literal("exec"),
            cmd: z4.string().min(1),
            workdir: z4.string().optional(),
          }),
          z4.object({ kind: z4.literal("read"), path: z4.string().min(1) }),
          z4.object({
            kind: z4.literal("write"),
            path: z4.string().min(1),
            content: z4.string(),
          }),
        ]),
      },
    },
    async ({ target, op }) =>
      json(await runOnSandbox(services, await fleetContext(), target, op as RunOnOp)),
  );

  server.registerTool(
    "sandbox_provision",
    {
      description:
        "Provision a new sandbox for the fleet. kind=selfhosted returns device-flow enrollment instructions to share with a HUMAN (install the agent + enroll their machine with loud whole-machine consent — the agent cannot self-consent). kind=modal creates a named Modal sandbox record, but it is NOT yet attachable as a swap target: routing a session onto a second Modal box is not supported yet, so sandbox_swap to its id is rejected. Use the session's own box (the default) or attach a Connected Machine instead.",
      inputSchema: {
        kind: z4.enum(["selfhosted", "modal"]),
        name: z4.string().min(1).max(120).optional(),
      },
    },
    async ({ kind, name }) =>
      json(
        await provisionSandbox(services, await fleetContext(), {
          kind,
          ...(name ? { name } : {}),
        }),
      ),
  );
}

async function beginMcpRigVerificationAttempt(
  deps: ApiRouteDeps,
  workspaceId: string,
  changeId: string,
) {
  try {
    return await beginRigChangeVerificationAttempt(deps.db, workspaceId, changeId, {
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (
      error instanceof RigChangeAlreadyVerifyingError ||
      error instanceof RigChangeTransitionError
    ) {
      throw new Error(error.message, { cause: error });
    }
    throw error;
  }
}

function verificationAttempt(change: {
  verification?: Record<string, unknown> | null;
}): number | string {
  return typeof change.verification?.attempt === "number"
    ? change.verification.attempt
    : crypto.randomUUID();
}

function registerRigTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  sessionId: string | null,
  json: JsonResult,
): void {
  if (can("rigs:use")) {
    server.registerTool(
      "rig_list",
      {
        description: "List workspace rigs and their active versions.",
        inputSchema: {},
      },
      async () => json({ rigs: await listRigs(deps.db, grant.workspaceId) }),
    );

    server.registerTool(
      "rig_get",
      {
        description:
          "Get one rig's bounded active definition plus compact historical version/change summaries. Historical setup scripts, checks, payloads, and verification logs are represented by counts/byte facts rather than copied into model context; use the access-controlled REST detail endpoints for exact retained definitions.",
        inputSchema: {
          rigId: z4.string().uuid(),
          versionLimit: z4.number().int().positive().optional(),
          changeLimit: z4.number().int().positive().optional(),
        },
      },
      async ({ rigId, versionLimit, changeLimit }) => {
        const rig = await requireRigForApi(deps.db, grant.workspaceId, rigId);
        const [versions, changes] = await Promise.all([
          listRigVersionMonitoringSummaries(
            deps.db,
            grant.workspaceId,
            rig.id,
            boundedRigHistoryLimit(versionLimit),
          ),
          listRigChangeMonitoringSummaries(
            deps.db,
            grant.workspaceId,
            rig.id,
            boundedRigHistoryLimit(changeLimit),
          ),
        ]);
        return json(boundRigDetailMcp(rig, versions, changes));
      },
    );

    server.registerTool(
      "rig_propose_change",
      {
        description:
          "Propose an additive rig setup command for clean verification. Use the exact command that already worked in this sandbox.",
        inputSchema: {
          rigId: z4.string().uuid(),
          command: z4.string().min(1).max(8192),
          note: z4.string().max(2000).optional(),
        },
      },
      async ({ rigId, command, note }) => {
        const rig = await requireRigForApi(deps.db, grant.workspaceId, rigId);
        const change = await proposeRigChangeForApi(
          { db: deps.db },
          grant,
          rig,
          {
            kind: "setup_append",
            payload: { command, ...(note ? { note } : {}) },
          },
          sessionId ? { proposedBy: `session:${sessionId}` } : {},
        );
        const verifying = await beginMcpRigVerificationAttempt(deps, grant.workspaceId, change.id);
        const attempt = verificationAttempt(verifying);
        try {
          await deps.workflowClient.startRigVerification({
            workspaceId: grant.workspaceId,
            changeId: change.id,
            workflowId: `rig-verification-change-${change.id}-attempt-${attempt}`,
          });
        } catch {
          return json(
            mcpMutationReceipt({
              operation: "rig_propose_change",
              committed: true,
              outcome: "partial_failure",
              changed: true,
              resource: {
                type: "rig_change",
                id: verifying.id,
                version: verifying.updatedAt,
                state: verifying.status,
              },
              relatedResources: [{ type: "rig", id: rig.id }],
              timestamp: verifying.updatedAt,
              idempotency: { status: "not_supported" },
              partialFailure: { stage: "verification_workflow_start", retryable: true },
              warnings: [
                "The rig change and verifying transition committed, but verification workflow start failed.",
              ],
              facts: { verificationAttempt: attempt },
              nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
            }),
          );
        }
        return json(
          mcpMutationReceipt({
            operation: "rig_propose_change",
            committed: true,
            outcome: "created",
            changed: true,
            resource: {
              type: "rig_change",
              id: verifying.id,
              version: verifying.updatedAt,
              state: verifying.status,
            },
            relatedResources: [{ type: "rig", id: rig.id }],
            timestamp: verifying.updatedAt,
            idempotency: { status: "not_supported" },
            facts: { verificationStarted: true, verificationAttempt: attempt },
            nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
          }),
        );
      },
    );

    server.registerTool(
      "rig_verify",
      {
        description:
          "Trigger rig verification. Pass changeId for a proposed change, or omit it to re-verify the active version's checks.",
        inputSchema: {
          rigId: z4.string().uuid(),
          changeId: z4.string().uuid().optional(),
        },
      },
      async ({ rigId, changeId }) => {
        const rig = await requireRigForApi(deps.db, grant.workspaceId, rigId);
        if (changeId) {
          const change = await requireRigChangeForApi(deps.db, grant.workspaceId, rig.id, changeId);
          const verifying = await beginMcpRigVerificationAttempt(
            deps,
            grant.workspaceId,
            change.id,
          );
          const attempt = verificationAttempt(verifying);
          try {
            await deps.workflowClient.startRigVerification({
              workspaceId: grant.workspaceId,
              changeId: change.id,
              workflowId: `rig-verification-change-${change.id}-attempt-${attempt}`,
            });
          } catch {
            return json(
              mcpMutationReceipt({
                operation: "rig_verify",
                committed: true,
                outcome: "partial_failure",
                changed: true,
                resource: {
                  type: "rig_change",
                  id: verifying.id,
                  version: verifying.updatedAt,
                  state: verifying.status,
                },
                relatedResources: [{ type: "rig", id: rig.id }],
                timestamp: verifying.updatedAt,
                idempotency: { status: "not_supported" },
                partialFailure: { stage: "verification_workflow_start", retryable: true },
                warnings: [
                  "The verifying transition committed, but verification workflow start failed.",
                ],
                facts: { verificationAttempt: attempt },
                nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
              }),
            );
          }
          return json(
            mcpMutationReceipt({
              operation: "rig_verify",
              committed: true,
              outcome: "accepted",
              changed: true,
              resource: {
                type: "rig_change",
                id: verifying.id,
                version: verifying.updatedAt,
                state: verifying.status,
              },
              relatedResources: [{ type: "rig", id: rig.id }],
              timestamp: verifying.updatedAt,
              idempotency: { status: "not_supported" },
              facts: { verificationStarted: true, verificationAttempt: attempt },
              nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
            }),
          );
        }
        if (!rig.activeVersion) {
          throw new Error("rig has no active version");
        }
        await deps.workflowClient.startRigVerification({
          workspaceId: grant.workspaceId,
          versionId: rig.activeVersion.id,
          workflowId: `rig-verification-version-${rig.activeVersion.id}-${crypto.randomUUID()}`,
        });
        return json(
          mcpMutationReceipt({
            operation: "rig_verify",
            committed: true,
            outcome: "accepted",
            changed: true,
            resource: {
              type: "rig_version",
              id: rig.activeVersion.id,
              version: rig.activeVersion.version,
              state: "verification_started",
            },
            relatedResources: [{ type: "rig", id: rig.id }],
            idempotency: { status: "not_supported" },
            nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
          }),
        );
      },
    );
  }

  if (can("rigs:manage")) {
    server.registerTool(
      "rig_promote",
      {
        description:
          "Promote a verified definition_edit rig change to a new active immutable version. Requires rigs:manage.",
        inputSchema: {
          rigId: z4.string().uuid(),
          changeId: z4.string().uuid(),
        },
      },
      async ({ rigId, changeId }) => {
        const rig = await requireRigForApi(deps.db, grant.workspaceId, rigId);
        const change = await requireRigChangeForApi(deps.db, grant.workspaceId, rig.id, changeId);
        const promoted = await promoteVerifiedDefinitionEditChangeForApi(
          { db: deps.db },
          grant,
          rig,
          change,
        );
        return json(
          mcpMutationReceipt({
            operation: "rig_promote",
            committed: true,
            outcome: "updated",
            changed: true,
            resource: {
              type: "rig_version",
              id: promoted.version.id,
              version: promoted.version.version,
              state: "active",
            },
            relatedResources: [
              { type: "rig_change", id: promoted.change.id, state: promoted.change.status },
              { type: "rig", id: rig.id },
            ],
            timestamp: promoted.version.createdAt,
            idempotency: { status: "not_supported" },
            nextAction: { tool: "rig_get", arguments: { rigId: rig.id } },
          }),
        );
      },
    );
  }
}

// Workspace orchestration for manager-style agents. Session-authenticated
// workers communicate through the typed internal-update plane; only a
// sessionless operator can append a visible prompt through this surface.
function exactAgentCommandContext(
  grant: AccessGrant,
  callerSessionId: string,
  authorizationSurface?: SessionAuthorizationSurface,
): AgentSessionCommandContext {
  const turnId = grant.metadata?.["turnId"];
  const attemptId = grant.metadata?.["attemptId"];
  const executionGeneration = grant.metadata?.["executionGeneration"];
  if (
    typeof turnId !== "string" ||
    typeof attemptId !== "string" ||
    typeof executionGeneration !== "number" ||
    !Number.isSafeInteger(executionGeneration) ||
    executionGeneration < 1
  ) {
    throw new Error("caller_attempt_claims_missing");
  }
  return {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    subjectId: grant.subjectId,
    callerSessionId,
    callerTurnId: turnId,
    callerAttemptId: attemptId,
    callerExecutionGeneration: executionGeneration,
    ...(authorizationSurface ? { authorizationSurface } : {}),
  };
}

function registerWorkspaceOrchestrationTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  callerSessionId: string | null,
  toolspaceMode: boolean,
  json: JsonResult,
): void {
  if (can("sessions:read")) {
    server.registerTool(
      "sessions_list",
      {
        description: `List compact high-level session status in this workspace. Defaults to creation order; use orderBy=updatedAt with decimal activity-revision updatedAfter/updatedThrough tokens for gap-free indexed incremental monitoring independent of application clocks. Cursors are opaque revision-fenced keysets. includeLastMessage is opt-in; its rendered previews share a deterministic ${SESSION_DISCOVERY_PREVIEW_MAX_BYTES}-byte UTF-8 aggregate budget, and omitted previews include a bounded session_events drill-down input (exact message type, direction=before, limit=1, monitoring summary). Use session_get for exact known targets and detailed resources/tools/settings. The list never returns full session objects or history.`,
        inputSchema: {
          limit: z4.number().int().positive().max(100).optional(),
          cursor: z4.string().max(512).optional(),
          includeLastMessage: z4.boolean().optional(),
          orderBy: z4.enum(["createdAt", "updatedAt"]).optional(),
          updatedAfter: z4.string().max(64).optional(),
        },
      },
      async ({ limit, cursor, includeLastMessage, orderBy: requestedOrderBy, updatedAfter }) => {
        const authorizationScope = await requireSessionAuthorizationListScope(
          deps,
          grant,
          "first_party_mcp",
        );
        const decodedCursor = cursor ? decodeSessionDiscoveryCursor(cursor) : undefined;
        const orderBy: SessionDiscoveryOrderBy =
          requestedOrderBy ?? decodedCursor?.orderBy ?? "createdAt";
        if (decodedCursor && decodedCursor.orderBy !== orderBy) {
          throw new Error("sessions_list cursor order does not match orderBy");
        }
        const normalizedUpdatedAfter =
          updatedAfter !== undefined
            ? normalizeSessionDiscoveryRevision(updatedAfter, "updatedAfter")
            : (decodedCursor?.updatedAfter ?? undefined);
        if (normalizedUpdatedAfter !== undefined && orderBy !== "updatedAt") {
          throw new Error("sessions_list updatedAfter requires orderBy=updatedAt");
        }
        if (decodedCursor && decodedCursor.updatedAfter !== (normalizedUpdatedAfter ?? null)) {
          throw new Error("sessions_list cursor does not match updatedAfter");
        }
        const page = await listSessionDiscoverySummaries(deps.db, grant.workspaceId, {
          limit: boundedSessionDiscoveryLimit(limit),
          ...(decodedCursor ? { cursor: decodedCursor } : {}),
          includeLastMessage: includeLastMessage === true,
          orderBy,
          ...(normalizedUpdatedAfter ? { updatedAfter: normalizedUpdatedAfter } : {}),
          ...(authorizationScope ? { authorizationScope } : {}),
        });
        return json(capSessionDiscoveryPage(page, includeLastMessage === true));
      },
    );

    server.registerTool(
      "session_get",
      {
        description:
          "Get another session you are managing: status, goal-bearing metadata, resources, tools, and variableSet attachment (names/ids only, never variable values). Do not call this with your own current session id to reconstruct context; your model-facing conversation history and persistent setting state are already supplied directly. Unbounded agent-set fields are clamped so monitoring another session cannot flood this context.",
        inputSchema: { sessionId: z4.string().uuid() },
      },
      async ({ sessionId }) => {
        const authorization = await authorizeFirstPartySession(
          deps,
          grant,
          sessionId,
          "session.read",
        );
        const session = await getSession(deps.db, grant.workspaceId, sessionId);
        if (!session) {
          throw new Error("session not found");
        }
        const queue = await getSessionQueueSnapshot(deps.db, grant.workspaceId, sessionId);
        const projected = projectSessionForRelatedAccess(
          {
            ...session,
            effectiveControl: queue?.effectiveControl ?? session.effectiveControl,
          },
          authorization?.relatedSessionAccess ?? "root",
        );
        return json(
          boundSessionDetailMcp(
            await withMcpEffectivePolicy(deps, grant.workspaceId, {
              ...projected,
              effectiveControl: queue?.effectiveControl ?? projected.effectiveControl,
            }),
          ),
        );
      },
    );

    server.registerTool(
      "session_events",
      {
        description:
          "Read a compact semantic tail only when session_get status is insufficient. With no cursor, this returns the newest matching events and excludes raw message/reasoning/command/PTY deltas. Use `latest` as an exclusive lookup for the authoritative newest durable sequence in exactly one semantic class; `receipt` is the concise alias for `tool_receipt`, and latest cannot be combined with type or class filters. Add `resultMode=compact` to latest for one bounded result-bearing completion/checkpoint/receipt without another inference. Use nextBefore to page older or explicit after/nextAfter to page forward. Type/class filters run in the RLS-scoped database query. payloadMode none|summary|full controls retained audit payload projection, but every model result is independently byte-capped with explicit truncation and exact covered sequence bounds. Exact retained forensic payloads require the access-controlled REST/SDK events API with mode=forensic&payloadMode=full; generic source bytes never retained by the audit boundary remain unavailable.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          after: z4.number().int().nonnegative().optional(),
          before: z4.number().int().positive().optional(),
          limit: z4.number().int().positive().optional(),
          direction: z4.enum(SessionEventReadDirection.options).optional(),
          mode: z4.enum(SessionEventReadMode.options).optional(),
          payloadMode: z4.enum(SessionEventPayloadMode.options).optional(),
          resultMode: z4.enum(SessionEventResultMode.options).optional(),
          includeTypes: z4.array(z4.enum(SessionEventType.options)).max(100).optional(),
          excludeTypes: z4.array(z4.enum(SessionEventType.options)).max(100).optional(),
          includeClasses: z4
            .array(z4.enum(SessionEventSemanticClass.options))
            .max(SessionEventSemanticClass.options.length)
            .optional(),
          excludeClasses: z4
            .array(z4.enum(SessionEventSemanticClass.options))
            .max(SessionEventSemanticClass.options.length)
            .optional(),
          latest: z4.enum(SessionEventLatestClass.options).optional(),
        },
      },
      async ({
        sessionId,
        after,
        before,
        limit,
        direction: requestedDirection,
        mode: requestedMode,
        payloadMode: requestedPayloadMode,
        resultMode: requestedResultMode,
        includeTypes,
        excludeTypes,
        includeClasses,
        excludeClasses,
        latest,
      }) => {
        await authorizeFirstPartySession(deps, grant, sessionId, "session.events.read");
        const latestClass =
          latest === undefined ? undefined : sessionEventLatestClassToSemanticClass(latest);
        if (requestedResultMode === "compact" && latestClass === undefined) {
          throw new Error("resultMode=compact requires latest");
        }
        await requireSession(deps.db, grant.workspaceId, sessionId);
        if (
          latest &&
          [includeTypes, excludeTypes, includeClasses, excludeClasses].some(
            (filter) => filter !== undefined,
          )
        ) {
          throw new Error("latest cannot be combined with event filters");
        }
        const mode = requestedMode ?? (after !== undefined ? "forensic" : "monitoring");
        const direction = latestClass
          ? "before"
          : (requestedDirection ??
            (before !== undefined ? "before" : after !== undefined ? "after" : "before"));
        const payloadMode =
          requestedResultMode === "compact"
            ? "full"
            : (requestedPayloadMode ?? (mode === "monitoring" ? "summary" : "full"));
        const dbPage = await listSessionEventPage(deps.db, grant.workspaceId, sessionId, {
          after: after ?? 0,
          ...(before !== undefined ? { before } : {}),
          direction,
          limit: latestClass ? 1 : boundedSessionEventMcpLimit(limit),
          payloadMode,
          includeTypes: includeTypes ?? [],
          excludeTypes: excludeTypes ?? [],
          includeClasses: latestClass ? [latestClass] : (includeClasses ?? []),
          excludeClasses: excludeClasses ?? [],
          ...(mode === "monitoring" ? { defaultExcludeTypes: SESSION_EVENT_RAW_DELTA_TYPES } : {}),
          ...(latestClass ? { authoritativeLatest: true } : {}),
          maxBytes: SESSION_EVENT_MCP_MAX_BYTES * 4,
        });
        if (requestedResultMode === "compact") {
          const event = dbPage.events[0];
          return json(
            event
              ? boundSessionEventCompactResult(
                  compactSessionEventResult(
                    event,
                    latestClass!,
                    dbPage.coveredSequence ?? { first: event.sequence, last: event.sequence },
                  ),
                )
              : null,
          );
        }
        return json(
          boundSessionEventMcpPage({
            events: dbPage.events,
            mode,
            payloadMode,
            direction,
            sourceHasMore: dbPage.hasMore,
            sourceTruncatedBy: dbPage.truncatedBy,
            after: after ?? 0,
            before: before ?? null,
          }),
        );
      },
    );
  }

  if (can("sessions:create")) {
    server.registerTool(
      "session_create",
      {
        description:
          "Spawn a new agent session (a worker) with an initial message and optional goal, resources (e.g. repositories from github_repositories_list), tools, and variable set attachment. VariableSet attachment happens at creation only — it cannot be added to a running session — and requires the variable-sets:use permission. When targetSandboxId names a machine, workingDir sets the working directory (cwd) the spawned session runs under on that machine.",
        inputSchema: {
          initialMessage: z4.string().min(1),
          // Per-session agent persona/system instructions for the spawned worker
          // (a per-agent-type prompt). Delivered system-level, composed AFTER the
          // workspace persona; never shown in the worker's timeline. Trimmed,
          // non-empty, max 32768 chars (re-validated by the contracts schema).
          instructions: z4.string().min(1).max(32768).optional(),
          goal: z4.unknown().optional(),
          resources: z4.array(z4.unknown()).optional(),
          tools: z4.array(z4.unknown()).optional(),
          // Per-session third-party MCP servers. Credential header values are
          // accepted only at create and never appear in responses/events.
          mcpServers: z4.array(z4.unknown()).optional(),
          variableSetId: z4.string().uuid().optional(),
          // Deprecated alias of variableSetId (rename back-compat); declared so MCP
          // validation doesn't strip it before createSessionForRequest maps it.
          environmentId: z4.string().uuid().optional(),
          // Bind the spawned session to a rig (freezes its active version);
          // declared so MCP validation doesn't strip it before the domain reads it.
          rigId: z4.string().uuid().optional(),
          model: z4.string().min(1).optional(),
          reasoningEffort: z4.string().optional(),
          latencyMode: z4.enum(["standard", "priority", "fast"]).optional(),
          sandboxBackend: z4.string().optional(),
          // Create-time machine targeting: an enrolled sandbox id (from
          // sandboxes_list) to run the spawned session on. Seeds the active-sandbox
          // pointer at creation so the FIRST turn lands on the chosen machine
          // (race-free). Ownership + liveness are validated in the domain via the
          // same path as sandbox_swap; an unowned/offline/unknown target 422s.
          targetSandboxId: z4.string().uuid().optional(),
          // The working directory (cwd) for a machine target: the path/cwd base the
          // spawned session's agent exec, terminal, and file dock run under. A
          // workspace_root-relative subdir or an absolute machine path. Only valid
          // WITH targetSandboxId (workingDir alone 422s); omitted ⇒ workspace_root.
          workingDir: z4.string().optional(),
          metadata: z4.record(z4.string(), z4.unknown()).optional(),
          // Workspace-scoped CREATE idempotency key: a retried session_create with
          // the same key returns the already-spawned worker instead of a duplicate.
          idempotencyKey: z4.string().min(1).max(200).optional(),
          // Per-session/agent descendant policy. Reductions need only create;
          // increases are authorized server-side with workspace:admin.
          maxNestedAgentDepth: z4.number().int().nonnegative().optional(),
          // First-party MCP token permissions for the spawned session; every
          // permission must be held by this grant (validated in the domain).
          // A goal requires goals:manage in the resulting set; it is never
          // silently added beyond the inherited or explicit authority.
          firstPartyMcpPermissions: z4
            .array(z4.string())
            .optional()
            .describe(
              "Optional first-party capability set for the child. Omit to inherit this session's effective permissions. An explicit set may only narrow capabilities held by this session. A goal-bearing child requires goals:manage in the resulting set; creation fails rather than adding it implicitly.",
            ),
          firstPartyMcpTools: z4
            .array(z4.enum(FIRST_PARTY_MCP_TOOL_NAMES))
            .optional()
            .describe(
              "Exact model-visible first-party tool selection for the child. Omit to inherit this session's effective selection. This does not grant permissions.",
            ),
          // Shared-sandbox placement (addendum 05 §D). OMIT (default) to SHARE the
          // creator's box — one filesystem/repo/desktop, N independent conversations;
          // this is the SAFE DEFAULT. Pass "new" for a fresh isolated box (a different
          // repo set or a genuinely separate filesystem), or {groupId} (a sibling
          // session's `sandboxGroupId` from a prior session_create response) to join
          // that specific sibling's box.
          // Shared state must be compatible: a shared box requires the SAME image
          // (rejected at the lease layer, B3) and — because the box's variable set is
          // fixed at creation under the current mechanics — the SAME workspace
          // VariableSet. The domain layer is env-aware: an inherited default with a
          // different variableSetId silently gets its OWN box (the spawn still works),
          // while an explicit shared/{groupId} with a mismatched variableSet 422s at
          // create. When the VariableSet is eventually evicted from the box manifest
          // (per-exec, like the git token), the env check dissolves on its own.
          // The description below is what the AGENT sees (this comment is invisible to
          // it); keep the two in sync.
          sandbox: z4
            .union([
              z4.literal("shared"),
              z4.literal("new"),
              z4.object({ groupId: z4.string().uuid() }),
            ])
            .describe(
              "Sandbox placement. OMIT (default) to SHARE the creator's box — one filesystem/repo/desktop, N independent conversations; this is the safe default. If the new session attaches a DIFFERENT variableSet than the creator's box, the platform automatically gives it its own box (the box variable set is fixed at creation), so omitting stays safe. Pass 'new' for a fresh isolated box (different repo set or a genuinely separate filesystem). Pass {groupId} to join a specific sibling's box — requires the same variableSet (a mismatch is rejected at create) and the same image (a conflicting image is rejected when the box warms).",
            )
            .optional(),
          // The parent (manager) session is auto-inferred from the caller's
          // worker-signed sessionId claim, so a spawned worker's completion wakes
          // its manager automatically. There is deliberately no caller-supplied
          // parent parameter: it would let a sessions:create grant target an
          // arbitrary session's wake channel without sessions:control on it.
        },
      },
      async (args) => {
        try {
          if (callerSessionId !== null) {
            await authorizeFirstPartySession(deps, grant, callerSessionId, "session.child.create");
          }
          const result = await createSessionForRequestWithOutcome(
            deps,
            grant,
            grant.workspaceId,
            args,
          );
          return json(sessionCreateMutationReceipt(result, Boolean(args.idempotencyKey)));
        } catch (error) {
          if (error instanceof SessionSpawnDeniedError) {
            return {
              ...json(sessionSpawnDenialEnvelope(error)),
              isError: true,
            };
          }
          throw error;
        }
      },
    );
  }

  if (can("sessions:control") && !toolspaceMode) {
    server.registerTool(
      "session_send_message",
      {
        description:
          "Send information to another session. From an OpenGeni worker this becomes a canonical coalescible machine input: it appears in the target's compact incoming queue group, is durably added to model history when claimed, and remains visible in the timeline. A sessionless operator call appends one human/API prompt.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          text: z4.string().min(1),
          idempotencyKey: z4.string().uuid(),
          // Header-value rotation only. URL/name/tool settings are immutable
          // after create; core enforces mcp_servers:attach on this field.
          mcpCredentialUpdates: z4.array(z4.unknown()).optional(),
        },
      },
      async ({ sessionId: targetSessionId, text, idempotencyKey, mcpCredentialUpdates }) => {
        await authorizeFirstPartySession(deps, grant, targetSessionId, "session.append");
        if (callerSessionId !== null) {
          if ((mcpCredentialUpdates?.length ?? 0) > 0) {
            throw new Error("internal session updates cannot change MCP credentials");
          }
          const result = await sendAgentSessionMessage(
            deps,
            exactAgentCommandContext(grant, callerSessionId),
            { targetSessionId, text, idempotencyKey },
          );
          return json(
            mcpMutationReceipt({
              operation: "session_send_message",
              committed: true,
              outcome: result.replay ? "replayed" : "accepted",
              changed: !result.replay,
              resource: {
                type: "session_system_update",
                id: result.updateId,
                state: result.effectiveState,
              },
              relatedResources: [{ type: "session", id: targetSessionId }],
              timestamp: result.receipt.createdAt.toISOString(),
              idempotency: { status: result.replay ? "replayed" : "applied" },
              facts: {
                delivery: "coalesced_internal_update",
                wakeRequested: result.wakeRevision !== null,
                resumeRequired: result.effectiveState === "paused",
              },
              nextAction: { tool: "session_get", arguments: { sessionId: targetSessionId } },
            }),
          );
        }
        const { accepted, turn, replay } = await acceptSessionUserMessageWithOutcome(
          deps,
          grant,
          grant.workspaceId,
          targetSessionId,
          {
            text,
            delivery: "send",
            origin: "operator",
            clientEventId: idempotencyKey,
            mcpCredentialUpdates: (mcpCredentialUpdates ?? []).map((update) =>
              SessionMcpCredentialUpdateInput.parse(update),
            ),
          },
        );
        return json(
          mcpMutationReceipt({
            operation: "session_send_message",
            committed: true,
            outcome: replay ? "replayed" : "accepted",
            changed: !replay,
            resource: {
              type: "session_turn",
              id: turn.id,
              version: turn.version,
              state: turn.status,
            },
            relatedResources: [
              { type: "session", id: targetSessionId },
              { type: "session_event", id: accepted.id, state: accepted.type },
            ],
            timestamp: accepted.occurredAt,
            idempotency: { status: replay ? "replayed" : "applied" },
            nextAction: { tool: "session_get", arguments: { sessionId: targetSessionId } },
          }),
        );
      },
    );

    server.registerTool(
      "session_pause",
      {
        description: "Pause this session. Waiting prompts stay saved and inert until Resume.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          idempotencyKey: z4.string().uuid(),
          reason: z4.string().min(1).max(500).optional(),
        },
      },
      async ({ sessionId, idempotencyKey, reason }) => {
        if (callerSessionId !== null) {
          const controlled = await controlAgentSessionWorkstream(
            deps,
            exactAgentCommandContext(grant, callerSessionId, "first_party_mcp"),
            {
              targetSessionId: sessionId,
              action: "pause",
              idempotencyKey,
              reason: reason ?? "agent_mcp_pause",
            },
          );
          return json({
            receiptId: controlled.receipt.id,
            effectiveControl: projectEffectiveControlForRelatedAccess(
              serializeEffectiveSessionControl(controlled.control),
              sessionId,
              controlled.authorization?.relatedSessionAccess ?? "root",
            ),
            interruptionCount: controlled.interruptionCount,
            replay: controlled.replay,
          });
        }
        const controlled = await controlHumanSessionWorkstream(
          deps,
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId,
            subjectId: grant.subjectId,
            authorizationSurface: "first_party_mcp",
          },
          {
            action: "pause",
            clientEventId: idempotencyKey,
            ...(reason ? { reason } : {}),
          },
        );
        return json(controlled);
      },
    );

    server.registerTool(
      "session_resume",
      {
        description:
          "Resume the selected session workstream through older parent/workspace pauses. This creates no message.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          idempotencyKey: z4.string().uuid(),
          reason: z4.string().min(1).max(500).optional(),
        },
      },
      async ({ sessionId, idempotencyKey, reason }) => {
        if (callerSessionId !== null) {
          const controlled = await controlAgentSessionWorkstream(
            deps,
            exactAgentCommandContext(grant, callerSessionId, "first_party_mcp"),
            {
              targetSessionId: sessionId,
              action: "resume",
              idempotencyKey,
              reason: reason ?? "agent_mcp_resume",
            },
          );
          return json({
            receiptId: controlled.receipt.id,
            effectiveControl: projectEffectiveControlForRelatedAccess(
              serializeEffectiveSessionControl(controlled.control),
              sessionId,
              controlled.authorization?.relatedSessionAccess ?? "root",
            ),
            interruptionCount: controlled.interruptionCount,
            replay: controlled.replay,
          });
        }
        const controlled = await controlHumanSessionWorkstream(
          deps,
          {
            accountId: grant.accountId,
            workspaceId: grant.workspaceId,
            sessionId,
            subjectId: grant.subjectId,
            authorizationSurface: "first_party_mcp",
          },
          {
            action: "resume",
            clientEventId: idempotencyKey,
            ...(reason ? { reason } : {}),
          },
        );
        return json(controlled);
      },
    );

    if (callerSessionId !== null) {
      server.registerTool(
        "session_steer",
        {
          description:
            "Atomically replace another session's current direction and resume it. The Agent Steer is a typed machine input shown in the target queue/timeline and durably retained in model history; it never impersonates a human prompt.",
          inputSchema: {
            sessionId: z4.string().uuid(),
            instruction: z4.string().min(1),
            idempotencyKey: z4.string().uuid(),
          },
        },
        async ({ sessionId, instruction, idempotencyKey }) => {
          const result = await steerAgentSession(
            deps,
            exactAgentCommandContext(grant, callerSessionId, "first_party_mcp"),
            { targetSessionId: sessionId, instruction, idempotencyKey },
          );
          return json(
            mcpMutationReceipt({
              operation: "session_steer",
              committed: true,
              outcome: result.replay ? "replayed" : "updated",
              changed: !result.replay,
              resource: {
                type: "session_system_update",
                id: result.updateId,
                state: result.effectiveState,
              },
              relatedResources: [{ type: "session", id: sessionId }],
              timestamp: result.receipt.createdAt.toISOString(),
              idempotency: { status: result.replay ? "replayed" : "applied" },
              facts: {
                interruptionCount: result.interruptionCount,
                stoppingPreviousAttempt: result.interruptionCount > 0,
              },
              updateId: result.updateId,
              nextAction: { tool: "session_get", arguments: { sessionId } },
            }),
          );
        },
      );
    }

    server.registerTool(
      "set_other_session_title",
      {
        description:
          "Set another session's display title to a concise 3-7 word summary. The target session must belong to this workspace. Replaces an existing title unless a human has manually set it.",
        inputSchema: {
          session_id: z4.string().uuid(),
          title: z4.string().min(1).max(200),
        },
      },
      async ({ session_id, title }) => {
        await authorizeFirstPartySession(deps, grant, session_id, "session.title.write");
        await requireSession(deps.db, grant.workspaceId, session_id);
        const result = await updateSessionTitle(deps, grant, session_id, title, "agent");
        return json({
          ok: true,
          updated: result.updated,
          title: result.title ?? title,
        });
      },
    );
  }
}

// VariableSet management for manager-style agents. v1 deliberately accepts
// variable VALUES in plain tool arguments: the calling model is trusted with
// the secrets it is persisting (see docs/variable-sets.md). Reads stay
// write-only — responses carry names and metadata, never values.
function registerVariableSetTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  json: JsonResult,
): void {
  const registerListTool = (name: string, description: string): void => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: {},
      },
      async () => {
        const variableSets = await listVariableSets(deps.db, grant.workspaceId);
        return json({ variableSets, environments: variableSets });
      },
    );
  };
  const setVariableHandler =
    (operation: "variable_set_set_variable" | "environment_set_variable") =>
    async ({
      variableSetId,
      variableSetName,
      environmentId,
      environmentName,
      name,
      value,
    }: {
      variableSetId?: string | undefined;
      variableSetName?: string | undefined;
      environmentId?: string | undefined;
      environmentName?: string | undefined;
      name: string;
      value: string;
    }) => {
      const key = requireVariableSetEncryption(deps.settings);
      const parsedName = VariableSetVariableName.safeParse(name);
      if (!parsedName.success) {
        throw new Error("variable set/environment variable names must match ^[A-Z][A-Z0-9_]*$");
      }
      assertAllowedVariableSetVariableName(parsedName.data);
      const targetId = variableSetId ?? environmentId;
      const targetName = variableSetName ?? environmentName;
      if ((targetId === undefined) === (targetName === undefined)) {
        throw new Error(
          "provide exactly one of variableSetId or variableSetName; deprecated aliases must provide exactly one of environmentId or environmentName",
        );
      }
      const trimmedVariableSetName = targetName?.trim();
      if (targetName !== undefined && !trimmedVariableSetName) {
        throw new Error("variable set name is required");
      }
      let created = false;
      let variableSet =
        targetId !== undefined
          ? await getVariableSet(deps.db, grant.workspaceId, targetId)
          : await getVariableSetByName(deps.db, grant.workspaceId, trimmedVariableSetName!);
      if (!variableSet && targetId !== undefined) {
        throw new Error("variable set/environment not found");
      }
      if (!variableSet) {
        if (
          (await countVariableSets(deps.db, grant.workspaceId)) >= MAX_ENVIRONMENTS_PER_WORKSPACE
        ) {
          throw new Error(
            `a workspace supports at most ${MAX_ENVIRONMENTS_PER_WORKSPACE} variable sets`,
          );
        }
        variableSet = await createVariableSet(deps.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          name: trimmedVariableSetName!,
        });
        created = true;
        await recordVariableSetAuditEvent(deps.db, {
          grant,
          action: "variable_set.created",
          variableSetId: variableSet.id,
        });
      }
      const exists = variableSet.variables.some((variable) => variable.name === parsedName.data);
      if (!exists && variableSet.variables.length >= MAX_VARIABLES_PER_ENVIRONMENT) {
        throw new Error(
          `a variable set supports at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables`,
        );
      }
      const metadata = await setVariableSetVariable(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        variableSetId: variableSet.id,
        name: parsedName.data,
        valueEncrypted: encryptVariableSetValue(key, value),
      });
      await recordVariableSetAuditEvent(deps.db, {
        grant,
        action: "variable_set.variable.set",
        variableSetId: variableSet.id,
        variableName: parsedName.data,
      });
      return json(
        mcpMutationReceipt({
          operation,
          committed: true,
          outcome: exists ? "updated" : "created",
          changed: true,
          resource: {
            type: "variable_set",
            id: variableSet.id,
            version: metadata.version,
            state: "variable_written",
          },
          timestamp: metadata.updatedAt,
          idempotency: { status: "not_supported" },
          facts: {
            variableCreated: !exists,
            variableSetCreated: created,
            deprecatedAlias: operation === "environment_set_variable",
          },
          nextAction: { tool: "variable_set_list", arguments: {} },
        }),
      );
    };
  const registerSetTool = (
    name: "variable_set_set_variable" | "environment_set_variable",
    description: string,
  ): void => {
    server.registerTool(
      name,
      {
        description,
        inputSchema: {
          variableSetId: z4.string().uuid().optional(),
          variableSetName: z4.string().min(1).optional(),
          environmentId: z4.string().uuid().optional(),
          environmentName: z4.string().min(1).optional(),
          name: z4.string().min(1),
          value: z4.string().min(1).max(32768),
        },
      },
      setVariableHandler(name),
    );
  };
  if (can("variable-sets:use")) {
    registerListTool(
      "variable_set_list",
      "List variable sets with variable names and metadata (versions, timestamps). Values are write-only and never returned.",
    );
    registerListTool(
      "environment_list",
      "(deprecated alias of variable_set_list) List variable sets with variable names and metadata (versions, timestamps). Values are write-only and never returned.",
    );
  }

  if (can("variable-sets:manage")) {
    registerSetTool(
      "variable_set_set_variable",
      "Set or rotate one variable in a variable set. Target by variableSetId, or by variableSetName (created if it does not exist). The value is encrypted at rest and injected into sandboxes of sessions the variable set is attached to; it is never readable back through any API.",
    );
    registerSetTool(
      "environment_set_variable",
      "(deprecated alias of variable_set_set_variable) Set or rotate one variable in a variable set. Target by variableSetId, or by variableSetName (created if it does not exist). The value is encrypted at rest and injected into sandboxes of sessions the variable set is attached to; it is never readable back through any API.",
    );
  }
}

function registerGitHubConnectTool(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  options: McpServerOptions,
  json: JsonResult,
): void {
  server.registerTool(
    "github_connect_link",
    {
      description:
        "Report truthful GitHub App workspace binding status and, for a human grant with github:manage, return the fresh GitHub owner-consent link. Server App configuration alone is never reported as a usable binding.",
      inputSchema: {},
    },
    async () => {
      const { settings } = deps;
      const missing = githubAppMissingSettings(settings);
      const slug = settings.githubAppSlug?.trim() || null;
      const setupMode = settings.productAccessMode === "managed" ? "platform" : "operator";
      if (missing.length > 0 || !slug) {
        return json({
          configured: false,
          status: "disabled",
          setupMode,
          appSlug: setupMode === "operator" ? slug : null,
          installUrl: null,
          linkUrl: null,
          missing: setupMode === "operator" ? missing : [],
        });
      }
      const installations = await listWorkspaceGitHubInstallationBindings(deps, grant.workspaceId);
      const status = githubBindingStatus(true, installations);
      const baseUrl = githubBrowserBaseUrl(settings, options.requestOrigin);
      const state =
        baseUrl && hasPermission(grant.permissions, "github:manage")
          ? createSignedState(deps.githubStateSecret, {
              accountId: grant.accountId,
              workspaceId: grant.workspaceId,
              intent: "installation_authority",
              ...githubBrowserGrantClaims(settings, grant),
            })
          : null;
      const connectUrl = state
        ? `${baseUrl}/v1/workspaces/${grant.workspaceId}/github/connect?state=${encodeURIComponent(state)}`
        : null;
      const installationViews = installations.map((installation) => ({
        ...installation,
        configureUrl:
          state && baseUrl
            ? `${baseUrl}/v1/workspaces/${grant.workspaceId}/github/installations/${installation.installationId}/configure?state=${encodeURIComponent(state)}`
            : null,
      }));
      return json({
        configured: true,
        status,
        setupMode,
        appSlug: setupMode === "operator" ? slug : null,
        installUrl: connectUrl,
        linkUrl: connectUrl,
        installations: installationViews,
        missing: [],
      });
    },
  );
}

// Defense-in-depth for invariant "agents cannot self-attach": the worker's
// first-party delegated token never carries variable-sets:use, so sandboxed
// agents calling these MCP tools cannot attach a variable set.
// Explicit detach (variableSetId: null) is also an attachment change and is
// blocked the same way.
function requireVariableSetsUseForMcpAttachment(
  grant: AccessGrant,
  variableSetId: string | null | undefined,
): void {
  if (variableSetId !== undefined && !hasPermission(grant.permissions, "variable-sets:use")) {
    throw new Error("missing permission: variable-sets:use");
  }
}

function repositoryWithScheduledTaskResource(
  repository: GitHubRepository,
): GitHubRepository & { resource: ResourceRef } {
  const uri = normalizedRepositoryUri(repository.cloneUrl);
  return {
    ...repository,
    resource: {
      kind: "repository",
      uri,
      ref: repository.defaultBranch,
      mountPath: defaultRepositoryMountPath(uri),
      ...(repository.private
        ? {
            githubInstallationId: repository.installationId,
            githubRepositoryId: repository.id,
          }
        : {}),
    },
  };
}

function normalizedRepositoryUri(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return `https://${url.host.toLowerCase()}/${path}.git`;
}

function boundedMcpLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

function boundedRigHistoryLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

function boundedSessionEventMcpLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 40;
  return Math.min(250, Math.max(1, Math.floor(limit)));
}

const SESSION_DISCOVERY_DEFAULT_LIMIT = 20;
const SESSION_DISCOVERY_MAX_LIMIT = 100;
const SESSION_DISCOVERY_TEXT_CHARS = 600;
const SESSION_DISCOVERY_PREVIEW_MAX_BYTES = 16_384;
const SESSION_DISCOVERY_PREVIEW_OMISSION_REASON = "aggregatePreviewBudget" as const;
const SESSION_DISCOVERY_PAGE_MAX_BYTES = 128_000;
const SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_TOOL = "session_events" as const;
const SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_BASE_INPUT = {
  direction: "before",
  limit: 1,
  mode: "monitoring",
  payloadMode: "summary",
} as const;

function sessionDiscoveryPreviewDrillDownInput(sessionId: string, type: SessionEventType) {
  return {
    sessionId,
    includeTypes: [type],
    ...SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_BASE_INPUT,
  };
}

function boundedSessionDiscoveryLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return SESSION_DISCOVERY_DEFAULT_LIMIT;
  return Math.min(SESSION_DISCOVERY_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function encodeSessionDiscoveryCursor(cursor: SessionDiscoveryCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 2,
      orderBy: cursor.orderBy,
      sortRevision: cursor.sortRevision,
      sortAt: cursor.sortAt,
      id: cursor.id,
      snapshotAt: cursor.snapshotAt,
      snapshotRevision: cursor.snapshotRevision,
      updatedAfter: cursor.updatedAfter,
    }),
    "utf8",
  ).toString("base64url");
}

const SESSION_DISCOVERY_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const SESSION_DISCOVERY_REVISION = /^(?:0|[1-9]\d*)$/;
const SESSION_DISCOVERY_REVISION_MAX = 9_223_372_036_854_775_807n;
const SESSION_DISCOVERY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeSessionDiscoveryTimestamp(value: string, label: string): string {
  if (!SESSION_DISCOVERY_TIMESTAMP.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new Error(`sessions_list ${label} must be an ISO UTC date-time`);
  }
  // Preserve up to six fractional digits. Converting through JS Date would
  // discard PostgreSQL microseconds and can skip equal-millisecond rows.
  return value;
}

function normalizeSessionDiscoveryRevision(value: string, label: string): string {
  if (!SESSION_DISCOVERY_REVISION.test(value)) {
    throw new Error(`sessions_list ${label} must be a decimal activity revision`);
  }
  const revision = BigInt(value);
  if (revision > SESSION_DISCOVERY_REVISION_MAX) {
    throw new Error(`sessions_list ${label} exceeds the database activity revision range`);
  }
  return revision.toString();
}

export function decodeSessionDiscoveryCursor(value: string): SessionDiscoveryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      v?: unknown;
      orderBy?: unknown;
      sortRevision?: unknown;
      sortAt?: unknown;
      createdAt?: unknown;
      id?: unknown;
      snapshotAt?: unknown;
      snapshotRevision?: unknown;
      updatedAfter?: unknown;
    };
    if (
      parsed.v === undefined &&
      typeof parsed.createdAt === "string" &&
      typeof parsed.id === "string" &&
      SESSION_DISCOVERY_UUID.test(parsed.id)
    ) {
      const createdAt = normalizeSessionDiscoveryTimestamp(
        parsed.createdAt,
        "legacy cursor createdAt",
      );
      return {
        orderBy: "createdAt",
        sortRevision: "0",
        sortAt: createdAt,
        id: parsed.id,
        snapshotAt: createdAt,
        snapshotRevision: "0",
        updatedAfter: null,
      };
    }
    // The timestamp-fenced v1 format was never safe for updated-order
    // continuation. Preserve rolling compatibility only for creation cursors,
    // whose immutable ordering does not need an activity revision.
    if (
      parsed.v === 1 &&
      parsed.orderBy === "createdAt" &&
      typeof parsed.sortAt === "string" &&
      typeof parsed.snapshotAt === "string" &&
      parsed.updatedAfter === null &&
      typeof parsed.id === "string" &&
      SESSION_DISCOVERY_UUID.test(parsed.id)
    ) {
      return {
        orderBy: "createdAt",
        sortRevision: "0",
        sortAt: normalizeSessionDiscoveryTimestamp(parsed.sortAt, "cursor sortAt"),
        id: parsed.id,
        snapshotAt: normalizeSessionDiscoveryTimestamp(parsed.snapshotAt, "cursor snapshotAt"),
        snapshotRevision: "0",
        updatedAfter: null,
      };
    }
    if (
      parsed.v !== 2 ||
      (parsed.orderBy !== "createdAt" && parsed.orderBy !== "updatedAt") ||
      typeof parsed.sortRevision !== "string" ||
      typeof parsed.sortAt !== "string" ||
      typeof parsed.snapshotAt !== "string" ||
      typeof parsed.snapshotRevision !== "string" ||
      (parsed.updatedAfter !== null && typeof parsed.updatedAfter !== "string") ||
      typeof parsed.id !== "string" ||
      !SESSION_DISCOVERY_UUID.test(parsed.id)
    ) {
      throw new Error("invalid cursor fields");
    }
    const sortAt = normalizeSessionDiscoveryTimestamp(parsed.sortAt, "cursor sortAt");
    const snapshotAt = normalizeSessionDiscoveryTimestamp(parsed.snapshotAt, "cursor snapshotAt");
    const sortRevision = normalizeSessionDiscoveryRevision(
      parsed.sortRevision,
      "cursor sortRevision",
    );
    const snapshotRevision = normalizeSessionDiscoveryRevision(
      parsed.snapshotRevision,
      "cursor snapshotRevision",
    );
    const normalizedUpdatedAfter =
      parsed.updatedAfter === null
        ? null
        : normalizeSessionDiscoveryRevision(parsed.updatedAfter, "cursor updatedAfter");
    if (normalizedUpdatedAfter !== null && parsed.orderBy !== "updatedAt") {
      throw new Error("incremental cursor requires updatedAt order");
    }
    if (parsed.orderBy === "createdAt" && (sortRevision !== "0" || snapshotRevision !== "0")) {
      throw new Error("creation cursor cannot carry activity revisions");
    }
    return {
      orderBy: parsed.orderBy,
      sortRevision,
      sortAt,
      id: parsed.id,
      snapshotAt,
      snapshotRevision,
      updatedAfter: normalizedUpdatedAfter,
    };
  } catch {
    throw new Error("sessions_list cursor is invalid");
  }
}

function capSessionDiscoveryText(
  value: string | null,
  maxChars = SESSION_DISCOVERY_TEXT_CHARS,
  originalChars?: number | null,
) {
  if (value === null) {
    return { text: value, truncated: false };
  }
  const projectedChars = Array.from(value);
  const sourceChars = Math.max(projectedChars.length, originalChars ?? projectedChars.length);
  if (sourceChars <= maxChars) {
    return { text: value, truncated: false };
  }

  // The database supplies only a bounded prefix plus the original character
  // count. Iterate to a stable marker width so the reported omission includes
  // the characters replaced by the marker itself.
  let bodyChars = maxChars;
  let marker = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const omittedChars = Math.max(0, sourceChars - bodyChars);
    marker = `…[${omittedChars} chars truncated]…`;
    const nextBodyChars = Math.max(0, maxChars - Array.from(marker).length);
    if (nextBodyChars === bodyChars) break;
    bodyChars = nextBodyChars;
  }
  return {
    text: `${projectedChars.slice(0, bodyChars).join("")}${marker}`,
    truncated: true,
  };
}

export function capSessionDiscoveryPage(
  page: Awaited<ReturnType<typeof listSessionDiscoverySummaries>>,
  includeLastMessage: boolean,
) {
  const projected = page.sessions.map((session) => {
    const title = capSessionDiscoveryText(session.title, 200, session.titleOriginalChars);
    const goal = session.goal
      ? capSessionDiscoveryText(
          session.goal.text,
          SESSION_DISCOVERY_TEXT_CHARS,
          session.goal.textOriginalChars,
        )
      : null;
    const preview = includeLastMessage
      ? capSessionDiscoveryText(
          session.latestMessage?.preview ?? null,
          SESSION_DISCOVERY_TEXT_CHARS,
          session.latestMessage?.previewOriginalChars,
        )
      : null;
    const blocker = session.effectiveControl.primaryBlocker;
    const blockerDisplayName = blocker
      ? capSessionDiscoveryText(blocker.displayName, 200, blocker.displayNameOriginalChars)
      : null;
    return {
      id: session.id,
      title: title.text,
      titleTruncated: title.truncated,
      parentSessionId: session.parentSessionId,
      isRoot: session.parentSessionId === null,
      status: session.status,
      pause: {
        state: session.effectiveControl.state,
        additionalBlockerCount: session.effectiveControl.additionalBlockerCount,
        source: blocker
          ? {
              kind: blocker.kind,
              ...(blocker.sessionId ? { sessionId: blocker.sessionId } : {}),
              displayName: blockerDisplayName!.text,
              displayNameTruncated: blockerDisplayName!.truncated,
            }
          : null,
      },
      goal: session.goal
        ? {
            status: session.goal.status,
            summary: goal!.text,
            summaryTruncated: goal!.truncated,
          }
        : null,
      queuedPromptCount: session.queuedPromptCount,
      children: session.treeStats,
      ...(includeLastMessage
        ? {
            latestMessage: session.latestMessage
              ? {
                  type: session.latestMessage.type,
                  preview: preview!.text,
                  previewTruncated: preview!.truncated,
                }
              : null,
          }
        : {}),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  });

  // The database order is already the useful discovery order. Spend the
  // separate preview budget in that order so the first page retains previews
  // for the most relevant rows and later rows remain discoverable by status.
  let budgetBytes = 0;
  const budgeted = includeLastMessage
    ? projected.map((session) => {
        const latestMessage = session.latestMessage;
        if (!latestMessage || latestMessage.preview === null) return session;
        const candidateBytes = Buffer.byteLength(latestMessage.preview, "utf8");
        if (budgetBytes + candidateBytes <= SESSION_DISCOVERY_PREVIEW_MAX_BYTES) {
          budgetBytes += candidateBytes;
          return session;
        }
        return {
          ...session,
          latestMessage: {
            ...latestMessage,
            preview: null,
            previewOmitted: true,
            previewOmissionReason: SESSION_DISCOVERY_PREVIEW_OMISSION_REASON,
            previewDrillDownTool: SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_TOOL,
            previewDrillDownInput: sessionDiscoveryPreviewDrillDownInput(
              session.id,
              latestMessage.type,
            ),
          },
        };
      })
    : projected;

  let kept = budgeted;
  const build = () => {
    const previewBytes = includeLastMessage
      ? kept.reduce(
          (total, session) =>
            total +
            (session.latestMessage?.preview === null || !session.latestMessage
              ? 0
              : Buffer.byteLength(session.latestMessage.preview, "utf8")),
          0,
        )
      : 0;
    const previewOmittedCount = includeLastMessage
      ? kept.filter((session) => {
          const latestMessage = session.latestMessage;
          return (
            latestMessage != null &&
            "previewOmitted" in latestMessage &&
            latestMessage.previewOmitted === true
          );
        }).length
      : 0;
    const lastKept = kept.at(-1);
    const droppedForByteCap = kept.length < projected.length;
    const sourceLast = lastKept
      ? page.sessions.find((session) => session.id === lastKept.id)
      : undefined;
    const nextCursor = droppedForByteCap
      ? sourceLast
        ? encodeSessionDiscoveryCursor({
            orderBy: page.orderBy,
            sortRevision: sourceLast.sortRevision,
            sortAt: sourceLast.sortAt,
            id: sourceLast.id,
            snapshotAt: page.snapshotAt,
            snapshotRevision: page.snapshotRevision,
            updatedAfter: page.updatedAfter,
          })
        : null
      : page.nextCursor
        ? encodeSessionDiscoveryCursor(page.nextCursor)
        : null;
    const result = {
      sessions: kept,
      total: page.total,
      hasMore: page.hasMore || droppedForByteCap,
      nextCursor,
      orderBy: page.orderBy,
      snapshotAt: page.snapshotAt,
      snapshotRevision: page.snapshotRevision,
      updatedAfter: page.updatedAfter,
      updatedThrough: page.updatedThrough,
      ...(includeLastMessage
        ? {
            latestMessagePreviewBudget: {
              bytes: previewBytes,
              maxBytes: SESSION_DISCOVERY_PREVIEW_MAX_BYTES,
              omittedCount: previewOmittedCount,
              truncated: previewOmittedCount > 0,
              omissionReason:
                previewOmittedCount > 0 ? SESSION_DISCOVERY_PREVIEW_OMISSION_REASON : null,
              drillDownTool: SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_TOOL,
              drillDownInput: {
                includeTypes: ["user.message", "agent.message.completed"] as const,
                ...SESSION_DISCOVERY_PREVIEW_DRILL_DOWN_BASE_INPUT,
              },
            },
          }
        : {}),
      responseTruncated: droppedForByteCap,
      ...(droppedForByteCap
        ? {
            truncationReason: `response exceeded ${SESSION_DISCOVERY_PAGE_MAX_BYTES} bytes; continue with nextCursor`,
          }
        : {}),
      bytes: 0,
      maxBytes: SESSION_DISCOVERY_PAGE_MAX_BYTES,
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const measured = Buffer.byteLength(JSON.stringify(result, null, 2), "utf8");
      if (result.bytes === measured) break;
      result.bytes = measured;
    }
    return result;
  };

  let result = build();
  while (result.bytes > SESSION_DISCOVERY_PAGE_MAX_BYTES && kept.length > 1) {
    kept = kept.slice(0, -1);
    result = build();
  }
  if (result.bytes > SESSION_DISCOVERY_PAGE_MAX_BYTES) {
    throw new RangeError(
      `sessions_list metadata exceeds its ${SESSION_DISCOVERY_PAGE_MAX_BYTES}-byte envelope`,
    );
  }
  return result;
}

function parseMcpDate(raw: string, label: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return date;
}

async function withMcpEffectivePolicy(
  deps: ApiRouteDeps,
  workspaceId: string,
  session: Session,
): Promise<Session> {
  const [workspaceServerIds, workspaceDefaultServerIds] = await Promise.all([
    workspaceSessionToolPolicyServerIds(deps.db, workspaceId, deps.settings),
    workspaceSessionToolPolicyDefaultServerIds(deps.db, workspaceId, deps.settings),
  ]);
  return sessionWithEffectiveToolPolicy(session, workspaceServerIds, workspaceDefaultServerIds);
}
