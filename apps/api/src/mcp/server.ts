import {
  CreateScheduledTaskRequest,
  WorkspaceEnvironmentVariableName,
  type AccessGrant,
  type GitHubRepository,
  type Permission,
  type ResourceRef,
  UpdateScheduledTaskRequest,
} from "@opengeni/contracts";
import {
  countWorkspaceEnvironments,
  createWorkspaceEnvironment,
  deleteScheduledTask,
  encryptEnvironmentValue,
  getSession,
  getSessionGoal,
  getWorkspaceEnvironment,
  getWorkspaceEnvironmentByName,
  listGitHubInstallationIdsForWorkspace,
  listScheduledTaskRuns,
  listScheduledTasks,
  listSessionEvents,
  listSessions,
  listSocialConnections,
  listSocialPosts,
  listWorkspaceEnvironments,
  requireFile,
  requireScheduledTask,
  requireSession,
  setSessionGoalStatus,
  setWorkspaceEnvironmentVariable,
  updateScheduledTask,
  updateSessionGoal,
  upsertSessionGoal,
} from "@opengeni/db";
import { appendAndPublishEvents } from "@opengeni/events";
import {
  createSignedState,
  GitHubAppConfigurationError,
  githubAppMissingSettings,
  listGitHubAppRepositories,
  stateMaxAgeSeconds,
} from "@opengeni/github";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z4 from "zod/v4";
import { hasPermission } from "../access";
import { recordWorkspaceUsage, requireLimit } from "../billing/limits";
import type { ApiRouteDeps } from "../dependencies";
import {
  assertAllowedEnvironmentVariableName,
  MAX_ENVIRONMENTS_PER_WORKSPACE,
  MAX_VARIABLES_PER_ENVIRONMENT,
  recordEnvironmentAuditEvent,
  requireEnvironmentEncryption,
} from "../domain/environments";
import {
  createValidatedScheduledTask,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validatedScheduledTaskUpdate,
} from "../domain/scheduled-tasks";
import { acceptSessionUserMessage, createSessionForRequest } from "../domain/sessions";

export type McpServerOptions = {
  // Origin of the HTTP request that reached the MCP route; last-resort base
  // for links the server mints (github_connect_link) when neither
  // OPENGENI_PUBLIC_BASE_URL nor the manifest base URL is configured.
  requestOrigin?: string | null;
};

export function buildOpenGeniMcpServer(deps: ApiRouteDeps, grant: AccessGrant, options: McpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "opengeni",
    version: "1.0.0",
  });
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const can = (permission: Permission) => hasPermission(grant.permissions, permission);

  // Goal tools are session-scoped: they are only registered when the grant
  // carries the worker-asserted sessionId claim (signed into the delegated
  // token by the worker, never agent-controlled) plus goals:manage.
  const goalSessionId = typeof grant.metadata?.["sessionId"] === "string" ? grant.metadata["sessionId"] as string : null;
  if (goalSessionId !== null && can("goals:manage")) {
    registerGoalTools(server, deps, grant, goalSessionId, json);
  }

  // Orchestration, environment, and GitHub-connect tools are permission-gated
  // at registration: a grant without the permission does not see the tool.
  // Sandboxed workers reach this server with the fixed first-party delegated
  // permission set (firstPartyMcpPermissions in @opengeni/runtime), which
  // carries none of sessions:*, environments:*, or github:use — so agents
  // cannot spawn or read sessions, touch workspace secrets, or mint GitHub
  // install links unless the operator hands them a grant that says so.
  registerWorkspaceOrchestrationTools(server, deps, grant, can, json);
  registerEnvironmentTools(server, deps, grant, can, json);
  if (can("github:use")) {
    registerGitHubConnectTool(server, deps, grant, options, json);
  }

  server.registerTool("files_get_download_url", {
    description: "Create a short-lived download URL for a ready file asset.",
    inputSchema: { fileId: z4.string().uuid() },
  }, async ({ fileId }) => {
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
  });

  server.registerTool("github_repositories_list", {
    description: "List GitHub App repositories available as scheduled task repository resources. Use the returned resource object in scheduled task agentConfig.resources.",
    inputSchema: { limit: z4.number().int().positive().optional() },
  }, async ({ limit }) => {
    try {
      const installationIds = await listGitHubInstallationIdsForWorkspace(deps.db, grant.workspaceId);
      const repositories = await listGitHubAppRepositories(deps.settings, { installationIds });
      const visible = typeof limit === "number" ? repositories.slice(0, limit) : repositories;
      return json({ repositories: visible.map((repository) => repositoryWithScheduledTaskResource(repository)) });
    } catch (error) {
      if (error instanceof GitHubAppConfigurationError) {
        throw new Error(`GitHub App is not configured: ${error.missing.join(", ")}`);
      }
      throw error;
    }
  });

  server.registerTool("social_connections_list", {
    description: "List connected social media accounts available to social media analysis packs.",
    inputSchema: { limit: z4.number().int().positive().optional() },
  }, async ({ limit }) => json({ connections: await listSocialConnections(deps.db, grant.workspaceId, boundedMcpLimit(limit)) }));

  server.registerTool("social_posts_recent", {
    description: "List recent social media posts imported or synced into OpenGeni.",
    inputSchema: {
      connectionIds: z4.array(z4.string().uuid()).optional(),
      since: z4.string().optional(),
      windowHours: z4.number().int().positive().optional(),
      limit: z4.number().int().positive().optional(),
    },
  }, async ({ connectionIds, since, windowHours, limit }) => {
    const sinceDate = since ? parseMcpDate(since, "since") : new Date(Date.now() - (windowHours ?? 24) * 60 * 60 * 1000);
    return json({
      since: sinceDate.toISOString(),
      posts: await listSocialPosts(deps.db, {
        workspaceId: grant.workspaceId,
        ...(connectionIds?.length ? { connectionIds } : {}),
        since: sinceDate,
        limit: boundedMcpLimit(limit),
      }),
    });
  });

  server.registerTool("social_daily_analysis_context", {
    description: "Collect social account and recent post context for a daily marketing analysis run.",
    inputSchema: {
      connectionIds: z4.array(z4.string().uuid()).optional(),
      documentBaseIds: z4.array(z4.string().uuid()).optional(),
      since: z4.string().optional(),
      windowHours: z4.number().int().positive().optional(),
      limit: z4.number().int().positive().optional(),
    },
  }, async ({ connectionIds, documentBaseIds, since, windowHours, limit }) => {
    const allConnections = await listSocialConnections(deps.db, grant.workspaceId, 500);
    const selectedIds = connectionIds && connectionIds.length > 0 ? new Set(connectionIds) : null;
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
    const sinceDate = since ? parseMcpDate(since, "since") : new Date(Date.now() - (windowHours ?? 24) * 60 * 60 * 1000);
    const posts = connections.length > 0
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
  });

  server.registerTool("scheduled_tasks_list", {
    description: "List scheduled tasks.",
    inputSchema: { limit: z4.number().int().positive().optional() },
  }, async ({ limit }) => json({ tasks: await listScheduledTasks(deps.db, grant.workspaceId, limit ?? 100) }));

  server.registerTool("scheduled_tasks_get", {
    description: "Get one scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => json(await requireScheduledTask(deps.db, grant.workspaceId, id)));

  server.registerTool("scheduled_tasks_create", {
    description: "Create a scheduled task.",
    inputSchema: {
      name: z4.string(),
      schedule: z4.unknown(),
      runMode: z4.string().optional(),
      overlapPolicy: z4.string().optional(),
      agentConfig: z4.unknown(),
      status: z4.string().optional(),
      environmentId: z4.string().uuid().optional(),
      metadata: z4.record(z4.string(), z4.unknown()).optional(),
    },
  }, async (args) => {
    const payload = CreateScheduledTaskRequest.parse(args);
    requireEnvironmentsUseForMcpAttachment(grant, payload.environmentId);
    await requireLimit(deps, { accountId: grant.accountId, workspaceId: grant.workspaceId, action: "schedule:create", quantity: 1 });
    const task = await createValidatedScheduledTask({ settings: deps.settings, db: deps.db, objectStorage: deps.objectStorage, grant, payload });
    await syncCreatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_update", {
    description: "Update a scheduled task.",
    inputSchema: {
      id: z4.string().uuid(),
      name: z4.string().optional(),
      schedule: z4.unknown().optional(),
      runMode: z4.string().optional(),
      overlapPolicy: z4.string().optional(),
      agentConfig: z4.unknown().optional(),
      status: z4.string().optional(),
      environmentId: z4.string().uuid().nullable().optional(),
      metadata: z4.record(z4.string(), z4.unknown()).optional(),
    },
  }, async ({ id, ...raw }) => {
    const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
    const payload = UpdateScheduledTaskRequest.parse(raw);
    requireEnvironmentsUseForMcpAttachment(grant, payload.environmentId);
    const update = await validatedScheduledTaskUpdate({ settings: deps.settings, db: deps.db, objectStorage: deps.objectStorage, grant, existing, payload });
    const task = await updateScheduledTask(deps.db, grant.workspaceId, id, update);
    await syncUpdatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, previous: existing, task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_pause", {
    description: "Pause a scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
    const task = await updateScheduledTask(deps.db, grant.workspaceId, id, { status: "paused" });
    await syncUpdatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, previous: existing, task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_resume", {
    description: "Resume a scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const existing = await requireScheduledTask(deps.db, grant.workspaceId, id);
    const task = await updateScheduledTask(deps.db, grant.workspaceId, id, { status: "active" });
    await syncUpdatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, previous: existing, task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_trigger", {
    description: "Trigger a scheduled task immediately.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const task = await requireScheduledTask(deps.db, grant.workspaceId, id);
    await requireLimit(deps, { accountId: grant.accountId, workspaceId: grant.workspaceId, action: "agent_run:create", quantity: 1 });
    const agentRunUsageIdempotencyKey = `agent_run.created:scheduled-trigger:${grant.workspaceId}:${task.id}:${crypto.randomUUID()}`;
    await deps.workflowClient.triggerScheduledTask({ task, agentRunUsageIdempotencyKey });
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
  });

  server.registerTool("scheduled_tasks_delete", {
    description: "Delete a scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const task = await requireScheduledTask(deps.db, grant.workspaceId, id);
    await deps.workflowClient.deleteScheduledTaskSchedule({ temporalScheduleId: task.temporalScheduleId });
    await deleteScheduledTask(deps.db, grant.workspaceId, id);
    return json({ ok: true });
  });

  server.registerTool("scheduled_task_runs_list", {
    description: "List runs for a scheduled task.",
    inputSchema: { taskId: z4.string().uuid(), limit: z4.number().int().positive().optional() },
  }, async ({ taskId, limit }) => json({ runs: await listScheduledTaskRuns(deps.db, grant.workspaceId, taskId, limit ?? 100) }));

  return server;
}

function registerGoalTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  sessionId: string,
  json: (value: unknown) => { content: Array<{ type: "text"; text: string }> },
): void {
  server.registerTool("goal_set", {
    description: "Set or replace this session's goal. While a goal is active the session keeps working: idle moments synthesize continuation turns until goal_complete or goal_pause is called. Replacing a goal reactivates it and resets the continuation budget.",
    inputSchema: {
      text: z4.string().min(1),
      successCriteria: z4.string().min(1).optional(),
      maxAutoContinuations: z4.number().int().positive().optional(),
    },
  }, async ({ text, successCriteria, maxAutoContinuations }) => {
    await requireSession(deps.db, grant.workspaceId, sessionId);
    const { goal, replaced } = await upsertSessionGoal(deps.db, {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      sessionId,
      text,
      successCriteria: successCriteria ?? null,
      maxAutoContinuations: maxAutoContinuations ?? null,
      createdBy: "agent",
    });
    await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [{
      type: "goal.set",
      payload: {
        goalId: goal.id,
        text: goal.text,
        ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
        version: goal.version,
        actor: "agent",
        replaced,
      },
    }]);
    return json(goal);
  });

  server.registerTool("goal_update", {
    description: "Revise the session goal's text or success criteria, or record a progress note. Counts as progress for the no-progress detector; the goal stays active.",
    inputSchema: {
      text: z4.string().min(1).optional(),
      successCriteria: z4.string().min(1).optional(),
      progressNote: z4.string().min(1).optional(),
    },
  }, async ({ text, successCriteria, progressNote }) => {
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
    await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [{
      type: "goal.updated",
      payload: {
        goalId: goal.id,
        text: goal.text,
        ...(goal.successCriteria ? { successCriteria: goal.successCriteria } : {}),
        ...(progressNote ? { progressNote } : {}),
        version: goal.version,
        actor: "agent",
      },
    }]);
    return json(goal);
  });

  server.registerTool("goal_complete", {
    description: "Mark the session goal as completed. Requires concrete evidence (what was done and how it satisfies the success criteria). This is the explicit stop signal: no further continuation turns are synthesized.",
    inputSchema: { evidence: z4.string().min(1) },
  }, async ({ evidence }) => {
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
      await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [{
        type: "goal.completed",
        payload: { goalId: goal.id, evidence, version: goal.version },
      }]);
    }
    return json(goal);
  });

  server.registerTool("goal_pause", {
    description: "Pause the session goal with a rationale (blocked, not productive, needs human input). This is the explicit stop signal: no further continuation turns are synthesized until the goal is resumed or replaced.",
    inputSchema: { rationale: z4.string().min(1) },
  }, async ({ rationale }) => {
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
      await appendAndPublishEvents(deps.db, deps.bus, grant.workspaceId, sessionId, [{
        type: "goal.paused",
        payload: {
          goalId: goal.id,
          actor: "agent",
          reason: "agent",
          rationale,
          autoContinuations: goal.autoContinuations,
          noProgressStreak: goal.noProgressStreak,
        },
      }]);
    }
    return json(goal);
  });
}

type JsonResult = (value: unknown) => { content: Array<{ type: "text"; text: string }> };

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
    server.registerTool("sessions_list", {
      description: "List sessions in this workspace, newest first.",
      inputSchema: { limit: z4.number().int().positive().optional() },
    }, async ({ limit }) => json({ sessions: await listSessions(deps.db, grant.workspaceId, boundedMcpLimit(limit)) }));

    server.registerTool("session_get", {
      description: "Get one session: status, goal-bearing metadata, resources, tools, and environment attachment (names/ids only, never variable values).",
      inputSchema: { sessionId: z4.string().uuid() },
    }, async ({ sessionId }) => {
      const session = await getSession(deps.db, grant.workspaceId, sessionId);
      if (!session) {
        throw new Error("session not found");
      }
      return json(session);
    });

    server.registerTool("session_events", {
      description: "Read a session's event timeline (oldest first). Pass `after` = the highest event `sequence` already seen to page forward; the response's `nextAfter` is that cursor. Use it to monitor another session's progress.",
      inputSchema: {
        sessionId: z4.string().uuid(),
        after: z4.number().int().nonnegative().optional(),
        limit: z4.number().int().positive().optional(),
      },
    }, async ({ sessionId, after, limit }) => {
      await requireSession(deps.db, grant.workspaceId, sessionId);
      const events = await listSessionEvents(deps.db, grant.workspaceId, sessionId, after ?? 0, boundedMcpLimit(limit));
      const last = events[events.length - 1];
      return json({ events, nextAfter: last ? last.sequence : after ?? 0 });
    });
  }

  if (can("sessions:create")) {
    server.registerTool("session_create", {
      description: "Spawn a new agent session (a worker) with an initial message and optional goal, resources (e.g. repositories from github_repositories_list), tools, and workspace environment attachment. Environment attachment happens at creation only — it cannot be added to a running session — and requires the environments:use permission.",
      inputSchema: {
        initialMessage: z4.string().min(1),
        goal: z4.unknown().optional(),
        resources: z4.array(z4.unknown()).optional(),
        tools: z4.array(z4.unknown()).optional(),
        environmentId: z4.string().uuid().optional(),
        model: z4.string().min(1).optional(),
        reasoningEffort: z4.string().optional(),
        sandboxBackend: z4.string().optional(),
        metadata: z4.record(z4.string(), z4.unknown()).optional(),
        // First-party MCP token permissions for the spawned session; every
        // permission must be held by this grant (validated in the domain).
        firstPartyMcpPermissions: z4.array(z4.string()).optional(),
      },
    }, async (args) => json(await createSessionForRequest(deps, grant, grant.workspaceId, args)));
  }

  if (can("sessions:control")) {
    server.registerTool("session_send_message", {
      description: "Post a user message into an existing session; the session queues a turn and resumes if idle.",
      inputSchema: {
        sessionId: z4.string().uuid(),
        text: z4.string().min(1),
      },
    }, async ({ sessionId, text }) => {
      const { accepted, turn } = await acceptSessionUserMessage(deps, grant, grant.workspaceId, sessionId, {
        text,
        toolsProvided: false,
      });
      return json({ event: accepted, turnId: turn.id });
    });
  }
}

// Environment management for manager-style agents. v1 deliberately accepts
// variable VALUES in plain tool arguments: the calling model is trusted with
// the secrets it is persisting (see docs/environments.md). Reads stay
// write-only — responses carry names and metadata, never values.
function registerEnvironmentTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  can: (permission: Permission) => boolean,
  json: JsonResult,
): void {
  if (can("environments:use")) {
    server.registerTool("environment_list", {
      description: "List workspace environments with variable names and metadata (versions, timestamps). Values are write-only and never returned.",
      inputSchema: {},
    }, async () => json({ environments: await listWorkspaceEnvironments(deps.db, grant.workspaceId) }));
  }

  if (can("environments:manage")) {
    server.registerTool("environment_set_variable", {
      description: "Set or rotate one variable in a workspace environment. Target by environmentId, or by environmentName (created if it does not exist). The value is encrypted at rest and injected into sandboxes of sessions the environment is attached to; it is never readable back through any API.",
      inputSchema: {
        environmentId: z4.string().uuid().optional(),
        environmentName: z4.string().min(1).optional(),
        name: z4.string().min(1),
        value: z4.string().min(1).max(32768),
      },
    }, async ({ environmentId, environmentName, name, value }) => {
      const key = requireEnvironmentEncryption(deps.settings);
      const parsedName = WorkspaceEnvironmentVariableName.safeParse(name);
      if (!parsedName.success) {
        throw new Error("environment variable names must match ^[A-Z][A-Z0-9_]*$");
      }
      assertAllowedEnvironmentVariableName(parsedName.data);
      if ((environmentId === undefined) === (environmentName === undefined)) {
        throw new Error("provide exactly one of environmentId or environmentName");
      }
      const trimmedEnvironmentName = environmentName?.trim();
      if (environmentName !== undefined && !trimmedEnvironmentName) {
        throw new Error("environment name is required");
      }
      let created = false;
      let environment = environmentId !== undefined
        ? await getWorkspaceEnvironment(deps.db, grant.workspaceId, environmentId)
        : await getWorkspaceEnvironmentByName(deps.db, grant.workspaceId, trimmedEnvironmentName!);
      if (!environment && environmentId !== undefined) {
        throw new Error("environment not found");
      }
      if (!environment) {
        if (await countWorkspaceEnvironments(deps.db, grant.workspaceId) >= MAX_ENVIRONMENTS_PER_WORKSPACE) {
          throw new Error(`a workspace supports at most ${MAX_ENVIRONMENTS_PER_WORKSPACE} environments`);
        }
        environment = await createWorkspaceEnvironment(deps.db, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          name: trimmedEnvironmentName!,
        });
        created = true;
        await recordEnvironmentAuditEvent(deps.db, { grant, action: "environment.created", environmentId: environment.id });
      }
      const exists = environment.variables.some((variable) => variable.name === parsedName.data);
      if (!exists && environment.variables.length >= MAX_VARIABLES_PER_ENVIRONMENT) {
        throw new Error(`an environment supports at most ${MAX_VARIABLES_PER_ENVIRONMENT} variables`);
      }
      const metadata = await setWorkspaceEnvironmentVariable(deps.db, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        environmentId: environment.id,
        name: parsedName.data,
        valueEncrypted: encryptEnvironmentValue(key, value),
      });
      await recordEnvironmentAuditEvent(deps.db, { grant, action: "environment.variable.set", environmentId: environment.id, variableName: parsedName.data });
      return json({
        environment: { id: environment.id, name: environment.name, created },
        variable: metadata,
      });
    });
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
  server.registerTool("github_connect_link", {
    description: "Create a workspace-bound GitHub App install link to share with a human. Opening it redirects to GitHub to install the app and select repositories for this workspace; completing the connection requires the person to be signed in to this OpenGeni deployment with github:manage. The link expires.",
    inputSchema: {},
  }, async () => {
    const { settings } = deps;
    const missing = githubAppMissingSettings(settings);
    const slug = settings.githubAppSlug?.trim() || null;
    if (missing.length > 0 || !slug) {
      return json({ configured: false, appSlug: slug, installUrl: null, missing });
    }
    const base = (settings.publicBaseUrl ?? settings.githubAppManifestBaseUrl ?? options.requestOrigin ?? "").replace(/\/+$/, "");
    if (!base) {
      throw new Error("github_connect_link requires OPENGENI_PUBLIC_BASE_URL (or OPENGENI_GITHUB_APP_MANIFEST_BASE_URL) so the install link can route through this deployment");
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
  });
}

// Defense-in-depth for invariant "agents cannot self-attach": the worker's
// first-party delegated token never carries environments:use, so sandboxed
// agents calling these MCP tools cannot attach a workspace environment.
// Explicit detach (environmentId: null) is also an attachment change and is
// blocked the same way.
function requireEnvironmentsUseForMcpAttachment(grant: AccessGrant, environmentId: string | null | undefined): void {
  if (environmentId !== undefined && !hasPermission(grant.permissions, "environments:use")) {
    throw new Error("missing permission: environments:use");
  }
}

function repositoryWithScheduledTaskResource(repository: GitHubRepository): GitHubRepository & { resource: ResourceRef } {
  const uri = normalizedRepositoryUri(repository.cloneUrl);
  return {
    ...repository,
    resource: {
      kind: "repository",
      uri,
      ref: repository.defaultBranch,
      mountPath: repositoryMountPath(uri),
      ...(repository.private ? { githubInstallationId: repository.installationId, githubRepositoryId: repository.id } : {}),
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
