import {
  CreateScheduledTaskRequest,
  type GitHubRepository,
  type ResourceRef,
  UpdateScheduledTaskRequest,
} from "@opengeni/contracts";
import {
  deleteScheduledTask,
  listScheduledTaskRuns,
  listScheduledTasks,
  listSocialConnections,
  listSocialPosts,
  requireFile,
  requireScheduledTask,
  updateScheduledTask,
} from "@opengeni/db";
import {
  GitHubAppConfigurationError,
  listGitHubAppRepositories,
} from "@opengeni/github";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z4 from "zod/v4";
import type { ApiRouteDeps } from "../dependencies";
import {
  createValidatedScheduledTask,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validatedScheduledTaskUpdate,
} from "../domain/scheduled-tasks";

export function buildOpenGeniMcpServer(deps: ApiRouteDeps): McpServer {
  const server = new McpServer({
    name: "opengeni",
    version: "1.0.0",
  });
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

  server.registerTool("files_get_download_url", {
    description: "Create a short-lived download URL for a ready file asset.",
    inputSchema: { fileId: z4.string().uuid() },
  }, async ({ fileId }) => {
    if (!deps.objectStorage) {
      throw new Error("object storage is not configured");
    }
    const file = await requireFile(deps.db, fileId);
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
      const repositories = await listGitHubAppRepositories(deps.settings);
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
  }, async ({ limit }) => json({ connections: await listSocialConnections(deps.db, boundedMcpLimit(limit)) }));

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
    const allConnections = await listSocialConnections(deps.db, 500);
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
  }, async ({ limit }) => json({ tasks: await listScheduledTasks(deps.db, limit ?? 100) }));

  server.registerTool("scheduled_tasks_get", {
    description: "Get one scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => json(await requireScheduledTask(deps.db, id)));

  server.registerTool("scheduled_tasks_create", {
    description: "Create a scheduled task.",
    inputSchema: {
      name: z4.string(),
      schedule: z4.unknown(),
      runMode: z4.string().optional(),
      overlapPolicy: z4.string().optional(),
      agentConfig: z4.unknown(),
      status: z4.string().optional(),
      metadata: z4.record(z4.string(), z4.unknown()).optional(),
    },
  }, async (args) => {
    const payload = CreateScheduledTaskRequest.parse(args);
    const task = await createValidatedScheduledTask({ settings: deps.settings, db: deps.db, objectStorage: deps.objectStorage, payload });
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
      metadata: z4.record(z4.string(), z4.unknown()).optional(),
    },
  }, async ({ id, ...raw }) => {
    const existing = await requireScheduledTask(deps.db, id);
    const payload = UpdateScheduledTaskRequest.parse(raw);
    const update = await validatedScheduledTaskUpdate({ settings: deps.settings, db: deps.db, objectStorage: deps.objectStorage, existing, payload });
    const task = await updateScheduledTask(deps.db, id, update);
    await syncUpdatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, previous: existing, task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_pause", {
    description: "Pause a scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const existing = await requireScheduledTask(deps.db, id);
    const task = await updateScheduledTask(deps.db, id, { status: "paused" });
    await syncUpdatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, previous: existing, task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_resume", {
    description: "Resume a scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const existing = await requireScheduledTask(deps.db, id);
    const task = await updateScheduledTask(deps.db, id, { status: "active" });
    await syncUpdatedScheduledTask({ db: deps.db, workflowClient: deps.workflowClient, previous: existing, task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_trigger", {
    description: "Trigger a scheduled task immediately.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const task = await requireScheduledTask(deps.db, id);
    await deps.workflowClient.triggerScheduledTask({ taskId: id });
    return json(task);
  });

  server.registerTool("scheduled_tasks_delete", {
    description: "Delete a scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const task = await requireScheduledTask(deps.db, id);
    await deps.workflowClient.deleteScheduledTaskSchedule({ temporalScheduleId: task.temporalScheduleId });
    await deleteScheduledTask(deps.db, id);
    return json({ ok: true });
  });

  server.registerTool("scheduled_task_runs_list", {
    description: "List runs for a scheduled task.",
    inputSchema: { taskId: z4.string().uuid(), limit: z4.number().int().positive().optional() },
  }, async ({ taskId, limit }) => json({ runs: await listScheduledTaskRuns(deps.db, taskId, limit ?? 100) }));

  return server;
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
      githubInstallationId: repository.installationId,
      githubRepositoryId: repository.id,
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
