import {
  CreateScheduledTaskRequest,
  SessionMcpCredentialUpdateInput,
  VariableSetVariableName,
  type AccessGrant,
  type GitHubRepository,
  type Permission,
  type ResourceRef,
  UpdateScheduledTaskRequest,
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
  getSessionTurn,
  getVariableSet,
  getVariableSetByName,
  listGitHubInstallationIdsForWorkspace,
  listScheduledTaskRuns,
  listScheduledTasks,
  listSessionEvents,
  listSessions,
  listRigs,
  listSocialConnections,
  listSocialPosts,
  listVariableSets,
  MEMORY_CORRECT_TOOL_DESCRIPTION,
  MEMORY_SAVE_TOOL_DESCRIPTION,
  MEMORY_SEARCH_TOOL_DESCRIPTION,
  requireFile,
  requireScheduledTask,
  requireSession,
  saveWorkspaceMemory,
  searchWorkspaceMemories,
  setSessionChildNotificationsMode,
  setSessionGoalStatus,
  setVariableSetVariable,
  updateScheduledTask,
  updateSessionGoal,
  upsertSessionGoal,
  RigChangeAlreadyVerifyingError,
  RigChangeTransitionError,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  createGitHubAppInstallationToken,
  createSignedState,
  GitHubAppConfigurationError,
  githubAppMissingSettings,
  listGitHubAppRepositories,
  stateMaxAgeSeconds,
} from "@opengeni/github";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z4 from "zod/v4";
import { hasPermission } from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  listRigChangesForApi,
  listRigVersionsForApi,
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
  createValidatedScheduledTask,
  manualScheduledTaskTriggerUsageKey,
  manualScheduledTaskTriggerWorkflowId,
  scheduledTaskToolsProvided,
  scheduledTaskTriggerToken,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validatedScheduledTaskUpdate,
} from "@opengeni/core";
import {
  acceptSessionUserMessage,
  createSessionForRequest,
  updateSessionTitle,
  workflowIdForSession,
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
import { capEventPage, capSessionDetail } from "./session-view";
import type { ToolspaceMcpSurface } from "./toolspace";

export type McpServerOptions = {
  // Origin of the HTTP request that reached the MCP route; last-resort base
  // for links the server mints (github_connect_link) when neither
  // OPENGENI_PUBLIC_BASE_URL nor the manifest base URL is configured.
  requestOrigin?: string | null;
  toolspace?: ToolspaceMcpSurface | null;
  workspaceMemoryEnabled?: boolean | undefined;
};

export function buildOpenGeniMcpServer(
  deps: ApiRouteDeps,
  grant: AccessGrant,
  options: McpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "opengeni",
    version: "1.0.0",
  });
  const json = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });
  const can = (permission: Permission) => hasPermission(grant.permissions, permission);
  const toolspaceMode = options.toolspace != null;

  // Session-scoped tools key off the worker-asserted sessionId claim (signed
  // into the delegated token by the worker, never agent-controlled).
  const sessionId =
    typeof grant.metadata?.["sessionId"] === "string"
      ? (grant.metadata["sessionId"] as string)
      : null;
  // set_session_title names the agent's OWN session — pure session metadata,
  // not a goal operation — so it is available on every session, gated only on
  // the signed sessionId (NOT goals:manage, and NOT on a goal existing).
  if (sessionId !== null && (!toolspaceMode || can("sessions:control"))) {
    server.registerTool(
      "set_session_title",
      {
        description:
          "Set this session's display title to a concise 3-7 word summary. Call once early to name the session; calling again replaces it unless a human has manually set the title.",
        inputSchema: { title: z4.string().min(1).max(200) },
      },
      async ({ title }) => {
        const result = await updateSessionTitle(deps, grant.workspaceId, sessionId, title, "agent");
        return json({ ok: true, updated: result.updated, title: result.title ?? title });
      },
    );
    server.registerTool(
      "set_child_notifications_mode",
      {
        description:
          "Control how workers you spawn report back when they finish. 'digest' (default): their completions arrive as a coalesced turn you process. 'passive': their completions appear only as quiet cards in your timeline and never queue a turn or a model run — use this when spawned-session completions are flooding your chat and you want them out of the way.",
        inputSchema: { mode: z4.enum(["digest", "passive"]) },
      },
      async ({ mode }) => {
        await setSessionChildNotificationsMode(deps.db, grant.workspaceId, sessionId, mode);
        return json({ ok: true, mode });
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
  }

  // Orchestration, variableSet, and GitHub-connect tools are permission-gated
  // at registration: a grant without the permission does not see the tool.
  // Sandboxed workers reach this server with the first-party delegated
  // permission set (firstPartyMcpPermissions in @opengeni/runtime), which is
  // POWERFUL BY DEFAULT — it carries sessions:*, variable sets:*, and github:use,
  // so agents can spawn/read sessions, manage variable set variables,
  // and mint GitHub install links out of the box. A user DEMOTES a specific
  // session by setting a narrower session.firstPartyMcpPermissions (capped to
  // the creator's own grant); operators still cap what any session can be given.
  registerWorkspaceOrchestrationTools(server, deps, grant, can, json);
  registerVariableSetTools(server, deps, grant, can, json);
  if (can("github:use")) {
    registerGitHubConnectTool(server, deps, grant, options, json);
    // TOKEN-BROKER (B1): the agent-refreshable git token. Session-scoped (keys off the
    // worker-signed sessionId claim so it mints for THIS session's repos), gated on
    // the same github:use capability as github_connect_link.
    if (sessionId !== null) {
      registerGitHubTokenTool(server, deps, grant, sessionId, json);
    }
  }

  if (!toolspaceMode || can("files:read")) {
    server.registerTool(
      "files_get_download_url",
      {
        description: "Create a short-lived download URL for a ready file asset.",
        inputSchema: { fileId: z4.string().uuid() },
      },
      async ({ fileId }) => {
        if (!deps.objectStorage) {
          throw new Error("object storage is not configured");
        }
        const file = await requireFile(deps.db, grant.workspaceId, fileId);
        if (file.status !== "ready") {
          throw new Error(`file is ${file.status}`);
        }
        const signed = await deps.objectStorage.createGetUrl({ key: file.objectKey });
        return json({
          file: {
            id: file.id,
            filename: file.filename,
            safeFilename: file.safeFilename,
            contentType: file.contentType,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
            status: file.status,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt,
          },
          downloadUrl: {
            url: signed.url,
            expiresAt: signed.expiresAt.toISOString(),
          },
        });
      },
    );
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
          const installationIds = await listGitHubInstallationIdsForWorkspace(
            deps.db,
            grant.workspaceId,
          );
          const repositories = await listGitHubAppRepositories(deps.settings, { installationIds });
          const visible = typeof limit === "number" ? repositories.slice(0, limit) : repositories;
          return json({
            repositories: visible.map((repository) =>
              repositoryWithScheduledTaskResource(repository),
            ),
          });
        } catch (error) {
          if (error instanceof GitHubAppConfigurationError) {
            throw new Error(`GitHub App is not configured: ${error.missing.join(", ")}`);
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
          connections: await listSocialConnections(
            deps.db,
            grant.workspaceId,
            boundedMcpLimit(limit),
          ),
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
        const sinceDate = since
          ? parseMcpDate(since, "since")
          : new Date(Date.now() - (windowHours ?? 24) * 60 * 60 * 1000);
        return json({
          since: sinceDate.toISOString(),
          posts: await listSocialPosts(deps.db, {
            workspaceId: grant.workspaceId,
            ...(connectionIds?.length ? { connectionIds } : {}),
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
        const allConnections = await listSocialConnections(deps.db, grant.workspaceId, 500);
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
  }

  if (!toolspaceMode || can("scheduled_tasks:manage") || can("scheduled_tasks:run")) {
    server.registerTool(
      "scheduled_tasks_list",
      {
        description: "List scheduled tasks.",
        inputSchema: { limit: z4.number().int().positive().optional() },
      },
      async ({ limit }) =>
        json({ tasks: await listScheduledTasks(deps.db, grant.workspaceId, limit ?? 100) }),
    );

    server.registerTool(
      "scheduled_tasks_get",
      {
        description: "Get one scheduled task.",
        inputSchema: { id: z4.string().uuid() },
      },
      async ({ id }) => json(await requireScheduledTask(deps.db, grant.workspaceId, id)),
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
        await syncCreatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, task });
        return json(task);
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
          previous: existing,
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
        const task = await updateScheduledTask(deps.db, grant.workspaceId, id, {
          status: "paused",
        });
        await syncUpdatedScheduledTask({
          db: deps.db,
          workflowClient: deps.workflowClient,
          previous: existing,
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
        const task = await updateScheduledTask(deps.db, grant.workspaceId, id, {
          status: "active",
        });
        await syncUpdatedScheduledTask({
          db: deps.db,
          workflowClient: deps.workflowClient,
          previous: existing,
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
        inputSchema: { id: z4.string().uuid(), triggerId: z4.string().min(1).max(128).optional() },
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
        });
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
        return json(task);
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
        await deleteScheduledTask(deps.db, grant.workspaceId, id);
        return json({ ok: true });
      },
    );

    server.registerTool(
      "scheduled_task_runs_list",
      {
        description: "List runs for a scheduled task.",
        inputSchema: { taskId: z4.string().uuid(), limit: z4.number().int().positive().optional() },
      },
      async ({ taskId, limit }) =>
        json({
          runs: await listScheduledTaskRuns(deps.db, grant.workspaceId, taskId, limit ?? 100),
        }),
    );
  }

  registerToolspaceProxyTools(server, options.toolspace ?? null);

  return server;
}

function registerToolspaceProxyTools(server: McpServer, surface: ToolspaceMcpSurface | null): void {
  if (!surface) {
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

/**
 * A turn injected by the machine to notify a manager that a spawned worker
 * reached a terminal state — either a coalesced child-notification digest turn
 * (source 'child_notification') or a legacy per-child wake (source 'user' with
 * a `childCompletion` marker). NOT a genuine human message.
 */
export function isMachineChildNotificationTurn(turn: {
  source: string;
  metadata: Record<string, unknown> | null;
}): boolean {
  if (turn.source === "child_notification") {
    return true;
  }
  return Boolean(turn.metadata && "childCompletion" in turn.metadata);
}

/**
 * Sacred user pause: a goal a human stopped (pausedReason 'user_interrupt') must
 * never be resurrected by a MACHINE turn. Child-completion notification turns
 * carry a "resume it now" nudge; without this guard the agent processing one of
 * them would call goal_set and re-arm the exact autonomous loop the user just
 * stopped (the runaway that made "stop" feel broken). A genuine user message
 * still redirects freely (it is not a child-notification turn), and the
 * human-driven API resume path (PATCH /goal) is unaffected.
 */
export async function assertGoalReactivationAllowed(
  deps: ApiRouteDeps,
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  const goal = await getSessionGoal(deps.db, workspaceId, sessionId);
  if (!goal || goal.status !== "paused" || goal.pausedReason !== "user_interrupt") {
    return;
  }
  const session = await getSession(deps.db, workspaceId, sessionId);
  const activeTurnId = session?.activeTurnId ?? null;
  if (!activeTurnId) {
    return;
  }
  const turn = await getSessionTurn(deps.db, workspaceId, activeTurnId);
  if (turn && isMachineChildNotificationTurn(turn)) {
    throw new Error(
      "This session was paused by the user (stop). A worker-completion turn cannot resume or replace the goal — only the user can. Report your findings for the user and stop; do not call goal_set.",
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
      await requireSession(deps.db, grant.workspaceId, sessionId);
      await assertGoalReactivationAllowed(deps, grant.workspaceId, sessionId);
      const { goal, replaced } = await upsertSessionGoal(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        sessionId,
        text,
        successCriteria: successCriteria ?? null,
        maxAutoContinuations: maxAutoContinuations ?? null,
        createdBy: "agent",
      });
      await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [
        {
          type: "goal.set",
          payload: {
            goalId: goal.id,
            text: goal.text,
            ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
            version: goal.version,
            actor: "agent",
            replaced,
          },
        },
      ]);
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
      },
    },
    async ({ text, successCriteria, progressNote }) => {
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (!existing) {
        throw new Error("this session has no goal; use goal_set first");
      }
      if (existing.status === "completed") {
        throw new Error("session goal is completed; use goal_set to start a new goal");
      }
      const goal = await updateSessionGoal(deps.db, grant.workspaceId, sessionId, {
        ...(text !== undefined ? { text } : {}),
        ...(successCriteria !== undefined ? { successCriteria } : {}),
      });
      await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [
        {
          type: "goal.updated",
          payload: {
            goalId: goal.id,
            text: goal.text,
            ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
            ...(progressNote ? { progressNote } : {}),
            version: goal.version,
            actor: "agent",
          },
        },
      ]);
      return json(goal);
    },
  );

  server.registerTool(
    "goal_complete",
    {
      description:
        "Mark the session goal as completed. Requires concrete evidence (what was done and how it satisfies the success criteria). This is the explicit stop signal: no further continuation turns are synthesized.",
      inputSchema: { evidence: z4.string().min(1) },
    },
    async ({ evidence }) => {
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (!existing) {
        throw new Error("this session has no goal; use goal_set first");
      }
      const { goal, changed } = await setSessionGoalStatus(deps.db, grant.workspaceId, sessionId, {
        status: "completed",
        evidence,
      });
      if (changed) {
        await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [
          {
            type: "goal.completed",
            payload: { goalId: goal.id, evidence, version: goal.version },
          },
        ]);
      }
      return json(goal);
    },
  );

  server.registerTool(
    "goal_pause",
    {
      description:
        "Pause the session goal with a rationale (blocked, not productive, needs human input). This is the explicit stop signal: no further continuation turns are synthesized until the goal is resumed or replaced.",
      inputSchema: { rationale: z4.string().min(1) },
    },
    async ({ rationale }) => {
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const existing = await getSessionGoal(deps.db, grant.workspaceId, sessionId);
      if (!existing) {
        throw new Error("this session has no goal; use goal_set first");
      }
      const { goal, changed } = await setSessionGoalStatus(deps.db, grant.workspaceId, sessionId, {
        status: "paused",
        rationale,
        pausedReason: "agent",
      });
      if (changed) {
        await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [
          {
            type: "goal.paused",
            payload: {
              goalId: goal.id,
              actor: "agent",
              reason: "agent",
              rationale,
              autoContinuations: goal.autoContinuations,
              noProgressStreak: goal.noProgressStreak,
            },
          },
        ]);
      }
      return json(goal);
    },
  );
}

type JsonResult = (value: unknown) => { content: Array<{ type: "text"; text: string }> };

const MemoryKindSchema = z4.enum(["preference", "semantic", "procedural", "decision", "episodic"]);

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
      return json(result);
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
      return json(result);
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
  const services: FleetServices = { db: deps.db, settings: deps.settings, bus: deps.bus };

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
        "List the sandboxes this session can run on: its own session sandbox (the Modal box) PLUS the workspace's enrolled selfhosted machines, each with liveness (online/reconnecting/offline) and an `active` marker for the currently-routed one. Use before sandbox_attach/sandbox_swap to pick a target. The `id` of any entry is the `target` for attach/swap/run_on.",
      inputSchema: {},
    },
    async () => json(await listFleet(services, await fleetContext())),
  );

  server.registerTool(
    "sandbox_attach",
    {
      description:
        'Attach this session to a sandbox (make it the active sandbox the agent\'s next tool calls run on). Heterogeneous: a Modal box or an enrolled selfhosted machine. Validates the target is owned by this workspace and online, then repoints under an epoch fence. Identical mechanic to sandbox_swap; use `target` = a sandboxes_list `id`, or "session"/"default" for this session\'s own box.',
      inputSchema: { target: z4.string().min(1) },
    },
    async ({ target }) => json(await swapActiveSandbox(services, await fleetContext(), target)),
  );

  server.registerTool(
    "sandbox_swap",
    {
      description:
        'Swap the active sandbox for this session mid-conversation (the next tool call runs on the new box). Heterogeneous Modal<->selfhosted<->selfhosted, single active at a time, flippable as many times as you like. Validates ownership + liveness, then bumps the active epoch (fencing any in-flight op, which retries against the new box). `target` = a sandboxes_list `id`, or "session"/"default" to swap back to this session\'s own box.',
      inputSchema: { target: z4.string().min(1) },
    },
    async ({ target }) => json(await swapActiveSandbox(services, await fleetContext(), target)),
  );

  server.registerTool(
    "run_on",
    {
      description:
        "Run a ONE-OFF op on a SPECIFIC enrolled selfhosted machine WITHOUT changing this session's active sandbox (a side-channel to another machine). Ops: exec (run a command), read (read a file), write (write a file). `target` = a selfhosted sandboxes_list `id`. To make a machine the active sandbox instead, use sandbox_swap.",
      inputSchema: {
        target: z4.string().min(1),
        op: z4.discriminatedUnion("kind", [
          z4.object({
            kind: z4.literal("exec"),
            cmd: z4.string().min(1),
            workdir: z4.string().optional(),
          }),
          z4.object({ kind: z4.literal("read"), path: z4.string().min(1) }),
          z4.object({ kind: z4.literal("write"), path: z4.string().min(1), content: z4.string() }),
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
        await provisionSandbox(services, await fleetContext(), { kind, ...(name ? { name } : {}) }),
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
      throw new Error(error.message);
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
        description: "Get a rig, its versions, and recent changes.",
        inputSchema: {
          rigId: z4.string().uuid(),
          changeLimit: z4.number().int().positive().optional(),
        },
      },
      async ({ rigId, changeLimit }) => {
        const rig = await requireRigForApi(deps.db, grant.workspaceId, rigId);
        return json({
          rig,
          versions: await listRigVersionsForApi({ db: deps.db }, grant.workspaceId, rig.id),
          changes: await listRigChangesForApi(
            { db: deps.db },
            grant.workspaceId,
            rig.id,
            boundedMcpLimit(changeLimit),
          ),
        });
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
        await deps.workflowClient.startRigVerification({
          workspaceId: grant.workspaceId,
          changeId: change.id,
          workflowId: `rig-verification-change-${change.id}-attempt-${verificationAttempt(verifying)}`,
        });
        return json({ change: verifying, verificationStarted: true });
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
          await deps.workflowClient.startRigVerification({
            workspaceId: grant.workspaceId,
            changeId: change.id,
            workflowId: `rig-verification-change-${change.id}-attempt-${verificationAttempt(verifying)}`,
          });
          return json({ ok: true, changeId: change.id });
        }
        if (!rig.activeVersion) {
          throw new Error("rig has no active version");
        }
        await deps.workflowClient.startRigVerification({
          workspaceId: grant.workspaceId,
          versionId: rig.activeVersion.id,
          workflowId: `rig-verification-version-${rig.activeVersion.id}-${crypto.randomUUID()}`,
        });
        return json({ ok: true, versionId: rig.activeVersion.id });
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
        return json(
          await promoteVerifiedDefinitionEditChangeForApi({ db: deps.db }, grant, rig, change),
        );
      },
    );
  }
}

// Workspace orchestration for manager-style agents: sessions are listed,
// inspected, spawned, and steered with the same domain functions the REST
// routes use, so limits, validation, and usage metering cannot drift.
function registerWorkspaceOrchestrationTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  json: JsonResult,
): void {
  if (can("sessions:read")) {
    server.registerTool(
      "sessions_list",
      {
        description: "List sessions in this workspace, newest first.",
        inputSchema: { limit: z4.number().int().positive().optional() },
      },
      async ({ limit }) =>
        json({ sessions: await listSessions(deps.db, grant.workspaceId, boundedMcpLimit(limit)) }),
    );

    server.registerTool(
      "session_get",
      {
        description:
          "Get one session: status, goal-bearing metadata, resources, tools, and variableSet attachment (names/ids only, never variable values). Unbounded agent-set fields (metadata, initial message) are clamped so monitoring another session cannot flood this context.",
        inputSchema: { sessionId: z4.string().uuid() },
      },
      async ({ sessionId }) => {
        const session = await getSession(deps.db, grant.workspaceId, sessionId);
        if (!session) {
          throw new Error("session not found");
        }
        return json(capSessionDetail(session));
      },
    );

    server.registerTool(
      "session_events",
      {
        description:
          "Read a session's event timeline (oldest first), to monitor another session's progress. Pass `after` = the highest event `sequence` already seen to page forward; the response's `nextAfter` is that cursor. The response is BYTE-CAPPED for a monitoring glance: fat per-event payloads (a worker's verbatim tool outputs, message/reasoning bodies) are clamped, and an over-budget page is reduced to its head + tail with a marker — page the gap with `after`/`limit`, or read the worker's session notebook, if you need omitted content verbatim. `nextAfter` always advances past every event the page covered, so paging never skips real events.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          after: z4.number().int().nonnegative().optional(),
          limit: z4.number().int().positive().optional(),
        },
      },
      async ({ sessionId, after, limit }) => {
        await requireSession(deps.db, grant.workspaceId, sessionId);
        const events = await listSessionEvents(
          deps.db,
          grant.workspaceId,
          sessionId,
          after ?? 0,
          boundedMcpLimit(limit),
        );
        const capped = capEventPage(events);
        return json({
          events: capped.events,
          nextAfter: capped.nextAfter ?? after ?? 0,
          ...(capped.truncated ? { truncated: true } : {}),
        });
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
          // First-party MCP token permissions for the spawned session; every
          // permission must be held by this grant (validated in the domain).
          firstPartyMcpPermissions: z4.array(z4.string()).optional(),
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
      async (args) => json(await createSessionForRequest(deps, grant, grant.workspaceId, args)),
    );
  }

  if (can("sessions:control")) {
    server.registerTool(
      "session_send_message",
      {
        description:
          "Post a user message into an existing session; the session queues a turn and resumes if idle.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          text: z4.string().min(1),
          // Header-value rotation only. URL/name/tool settings are immutable
          // after create; core enforces mcp_servers:attach on this field.
          mcpCredentialUpdates: z4.array(z4.unknown()).optional(),
        },
      },
      async ({ sessionId, text, mcpCredentialUpdates }) => {
        const { accepted, turn } = await acceptSessionUserMessage(
          deps,
          grant,
          grant.workspaceId,
          sessionId,
          {
            text,
            toolsProvided: false,
            mcpCredentialUpdates: (mcpCredentialUpdates ?? []).map((update) =>
              SessionMcpCredentialUpdateInput.parse(update),
            ),
          },
        );
        return json({ event: accepted, turnId: turn.id });
      },
    );

    server.registerTool(
      "session_interrupt",
      {
        description:
          "Interrupt a session in this workspace. mode='stop' (default) cancels the current turn AND pauses the session's active goal so it halts. mode='steer' cancels the current turn WITHOUT pausing the goal, so the session picks up its next queued turn (or, if nothing is queued, continues toward its active goal) — pair it with a preceding session_send_message to redirect a running session. Works whether the target is mid-turn or idle.",
        inputSchema: {
          sessionId: z4.string().uuid(),
          mode: z4.enum(["stop", "steer"]).optional(),
        },
      },
      async ({ sessionId, mode }) => {
        await requireSession(deps.db, grant.workspaceId, sessionId);
        const appended = await appendAndPublishEvents(
          deps.db,
          deps.bus,
          grant.workspaceId,
          sessionId,
          [
            {
              type: "user.interrupt",
              payload: mode === "steer" ? { reason: "steer" } : {},
            },
          ],
        );
        const accepted = appended[0];
        if (!accepted) {
          throw new Error("failed to append interrupt event");
        }
        await deps.workflowClient.signalInterrupt({
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          sessionId,
          eventId: accepted.id,
          workflowId: workflowIdForSession(sessionId),
        });
        return json({ event: accepted });
      },
    );

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
        await requireSession(deps.db, grant.workspaceId, session_id);
        const result = await updateSessionTitle(
          deps,
          grant.workspaceId,
          session_id,
          title,
          "agent",
        );
        return json({ ok: true, updated: result.updated, title: result.title ?? title });
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
  const setVariableHandler = async ({
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
      if ((await countVariableSets(deps.db, grant.workspaceId)) >= MAX_ENVIRONMENTS_PER_WORKSPACE) {
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
      throw new Error(`a variable set supports at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables`);
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
    const responseVariableSet = { id: variableSet.id, name: variableSet.name, created };
    return json({
      variableSet: responseVariableSet,
      environment: responseVariableSet,
      variable: metadata,
    });
  };
  const registerSetTool = (name: string, description: string): void => {
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
      setVariableHandler,
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

// GitHub connect link for manager-style agents: mirrors GET .../github/app but
// returns a browser entry URL (.../github/connect) that plants the CSRF state
// cookie before forwarding to GitHub, because an MCP-issued link is opened in
// a browser that never called the API directly.
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
        "Create a workspace-bound GitHub App install link to share with a human. Opening it redirects to GitHub to install the app and select repositories for this workspace; completing the connection requires the person to be signed in to this OpenGeni deployment with github:manage. The link expires.",
      inputSchema: {},
    },
    async () => {
      const { settings } = deps;
      const missing = githubAppMissingSettings(settings);
      const slug = settings.githubAppSlug?.trim() || null;
      if (missing.length > 0 || !slug) {
        return json({ configured: false, appSlug: slug, installUrl: null, missing });
      }
      const base = (
        settings.publicBaseUrl ??
        settings.githubAppManifestBaseUrl ??
        options.requestOrigin ??
        ""
      ).replace(/\/+$/, "");
      if (!base) {
        throw new Error(
          "github_connect_link requires OPENGENI_PUBLIC_BASE_URL (or OPENGENI_GITHUB_APP_MANIFEST_BASE_URL) so the install link can route through this deployment",
        );
      }
      const state = createSignedState(deps.githubStateSecret, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
      });
      return json({
        configured: true,
        appSlug: slug,
        installUrl: `${base}/v1/workspaces/${grant.workspaceId}/github/connect?state=${encodeURIComponent(state)}`,
        expiresInSeconds: stateMaxAgeSeconds,
        missing: [],
      });
    },
  );
}

// TOKEN-BROKER (B1): mint a FRESH short-lived GitHub App installation token for the
// session's repository resources. The agent calls this to refresh git auth before
// the current token expires. The MCP server CANNOT write the box, so the tool RETURNS
// the token as JSON; the agent writes it to the token file (via exec) to refresh
// GIT_ASKPASS. Same github:use capability gate as github_connect_link.
function registerGitHubTokenTool(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: JsonResult,
): void {
  server.registerTool(
    "github_token",
    {
      description:
        "Mint a fresh short-lived GitHub token for this session's repositories. Write it to $OPENGENI_GIT_TOKEN_FILE (default $HOME/.opengeni/git-token) to refresh git auth before the current token expires.",
      inputSchema: {},
    },
    async () => {
      const session = await requireSession(deps.db, grant.workspaceId, sessionId);
      // Resolve the run-scoped installation + repository ids from THIS session's
      // repository resources (same shape sandboxEnvironmentForRun mints against). Only
      // private GitHub-App repos carry the installation/repository ids.
      const selected = (session.resources ?? []).flatMap((resource) => {
        if (resource.kind !== "repository") {
          return [];
        }
        const installationId = resource.githubInstallationId;
        const repositoryId = resource.githubRepositoryId;
        return typeof installationId === "number" &&
          installationId > 0 &&
          typeof repositoryId === "number" &&
          repositoryId > 0
          ? [{ installationId, repositoryId }]
          : [];
      });
      if (selected.length === 0) {
        throw new Error("this session has no GitHub App repository resources to mint a token for");
      }
      const installationId = selected[0]!.installationId;
      if (selected.some((item) => item.installationId !== installationId)) {
        throw new Error("GitHub App repository resources must belong to one installation");
      }
      const token = await createGitHubAppInstallationToken(deps.settings, {
        installationId,
        repositoryIds: selected.map((item) => item.repositoryId),
      });
      return json({
        token,
        tokenFile: "$OPENGENI_GIT_TOKEN_FILE (default $HOME/.opengeni/git-token)",
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
      mountPath: repositoryMountPath(uri),
      ...(repository.private
        ? { githubInstallationId: repository.installationId, githubRepositoryId: repository.id }
        : {}),
    },
  };
}

function normalizedRepositoryUri(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return `https://${url.hostname.toLowerCase()}/${path}.git`;
}

function repositoryMountPath(uri: string): string {
  const url = new URL(uri);
  return `repos/${url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")}`;
}

function boundedMcpLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) {
    return 100;
  }
  return Math.min(500, Math.max(1, Math.floor(limit)));
}

function parseMcpDate(raw: string, label: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return date;
}
