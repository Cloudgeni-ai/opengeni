import {
  CreateScheduledTaskRequest,
  TriggerScheduledTaskRequest,
  UpdateScheduledTaskRequest,
} from "@opengeni/contracts";
import {
  deleteScheduledTask,
  listScheduledTaskRuns,
  listScheduledTasks,
  ScheduledTaskConflictError,
  updateScheduledTask,
} from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requireAccessGrant } from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  createValidatedScheduledTask,
  manualScheduledTaskTriggerUsageKey,
  manualScheduledTaskTriggerWorkflowId,
  scheduledTaskToolsProvided,
  scheduledTaskTriggerToken,
  requireScheduledTaskForApi,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validatedScheduledTaskUpdate,
} from "@opengeni/core";
import { boundedLimit } from "../http/common";

export function registerScheduledTaskRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db, workflowClient, objectStorage } = deps;

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const rawPayload = await c.req.json();
    const payload = CreateScheduledTaskRequest.parse(rawPayload);
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "schedule:create",
      quantity: 1,
    });
    const task = await createValidatedScheduledTask({
      settings,
      db,
      objectStorage,
      grant,
      payload,
      toolsProvided: scheduledTaskToolsProvided(rawPayload),
    });
    await syncCreatedScheduledTask({ db, workflowClient, task });
    return c.json(task, 201);
  });

  app.get("/v1/workspaces/:workspaceId/scheduled-tasks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    return c.json(await listScheduledTasks(db, workspaceId, boundedLimit(c.req.query("limit"))));
  });

  app.get("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    return c.json(await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId")));
  });

  app.patch("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const taskId = c.req.param("taskId");
    const existing = await requireScheduledTaskForApi(db, workspaceId, taskId);
    const rawPayload = await c.req.json();
    const payload = UpdateScheduledTaskRequest.parse(rawPayload);
    const update = await validatedScheduledTaskUpdate({
      settings,
      db,
      objectStorage,
      grant,
      existing,
      payload,
      toolsProvided: scheduledTaskToolsProvided(rawPayload),
    });
    let task;
    try {
      task = await updateScheduledTask(db, workspaceId, taskId, update);
    } catch (error) {
      if (error instanceof ScheduledTaskConflictError) {
        throw new HTTPException(409, { message: error.message });
      }
      throw error;
    }
    await syncUpdatedScheduledTask({ db, workflowClient, previous: existing, task });
    return c.json(task);
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/pause", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const existing = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    const task = await updateScheduledTask(db, workspaceId, existing.id, { status: "paused" });
    await syncUpdatedScheduledTask({ db, workflowClient, previous: existing, task });
    return c.json(task);
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/resume", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const existing = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    const task = await updateScheduledTask(db, workspaceId, existing.id, { status: "active" });
    await syncUpdatedScheduledTask({ db, workflowClient, previous: existing, task });
    return c.json(task);
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/trigger", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    // Load the task before the gate so a codex-model scheduled task can be
    // recognised as codex-billed and skip the credit/cost gates at the edge.
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "agent_run:create",
      quantity: 1,
      model: task.agentConfig.model ?? deps.settings.openaiModel,
    });
    // Body is optional (a bare POST is still a valid trigger); only a present,
    // non-empty body must parse against the contract.
    const body = await c.req.json().catch(() => ({}));
    const { triggerId } = TriggerScheduledTaskRequest.parse(body ?? {});
    const triggerToken = scheduledTaskTriggerToken(triggerId);
    const agentRunUsageIdempotencyKey = manualScheduledTaskTriggerUsageKey(
      workspaceId,
      task.id,
      triggerToken,
    );
    const triggerWorkflowId = manualScheduledTaskTriggerWorkflowId(task.id, triggerToken);
    await workflowClient.triggerScheduledTask({
      task,
      agentRunUsageIdempotencyKey,
      triggerWorkflowId,
    });
    await recordWorkspaceUsage(deps, {
      accountId: grant.accountId,
      workspaceId,
      subjectId: grant.subjectId,
      eventType: "agent_run.created",
      quantity: 1,
      unit: "run",
      sourceResourceType: "scheduled_task",
      sourceResourceId: task.id,
      idempotencyKey: agentRunUsageIdempotencyKey,
    });
    return c.json(task, 202);
  });

  app.delete("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    await workflowClient.deleteScheduledTaskSchedule({
      temporalScheduleId: task.temporalScheduleId,
    });
    await deleteScheduledTask(db, workspaceId, task.id);
    return c.json({ ok: true });
  });

  app.get("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/runs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    return c.json(
      await listScheduledTaskRuns(db, workspaceId, task.id, boundedLimit(c.req.query("limit"))),
    );
  });
}
