import {
  CreateScheduledTaskRequest,
  UpdateScheduledTaskRequest,
} from "@infra-agents/contracts";
import {
  deleteScheduledTask,
  listScheduledTaskRuns,
  listScheduledTasks,
  requireScheduledTask,
  updateScheduledTask,
} from "@infra-agents/db";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z4 from "zod/v4";
import type { ApiRouteDeps } from "../dependencies";
import {
  createValidatedScheduledTask,
  validatedScheduledTaskUpdate,
} from "../domain/scheduled-tasks";

export function buildInfraAgentsMcpServer(deps: ApiRouteDeps): McpServer {
  const server = new McpServer({
    name: "infra-agents",
    version: "1.0.0",
  });
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

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
    await deps.workflowClient.syncScheduledTask({ task });
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
    await deps.workflowClient.syncScheduledTask({ task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_pause", {
    description: "Pause a scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const task = await updateScheduledTask(deps.db, id, { status: "paused" });
    await deps.workflowClient.syncScheduledTask({ task });
    return json(task);
  });

  server.registerTool("scheduled_tasks_resume", {
    description: "Resume a scheduled task.",
    inputSchema: { id: z4.string().uuid() },
  }, async ({ id }) => {
    const task = await updateScheduledTask(deps.db, id, { status: "active" });
    await deps.workflowClient.syncScheduledTask({ task });
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
