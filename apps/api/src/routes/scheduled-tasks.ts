import {
  CreateScheduledTaskRequest,
  TriggerScheduledTaskRequest,
  UpdateScheduledTaskRequest,
} from "@opengeni/contracts";
import {
  deleteScheduledTask,
  listScheduledTaskRuns,
  listScheduledTasks,
  updateScheduledTask,
} from "@opengeni/db";
import type { Hono } from "hono";
import { requireAccessGrant } from "@opengeni/core";
import { recordWorkspaceUsage, requireLimit } from "@opengeni/core";
import type { ApiRouteDeps } from "@opengeni/core";
import {
  captureScheduledTaskRestoreState,
  createValidatedScheduledTask,
  manualScheduledTaskTriggerUsageKey,
  manualScheduledTaskTriggerWorkflowId,
  scheduledTaskToolsProvided,
  scheduledTaskForGrant,
  scheduledTaskRunForGrant,
  scheduledTaskTriggerToken,
  requireScheduledTaskForApi,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validateScheduledTaskTarget,
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
      sessionAuthorization: deps.sessionAuthorization,
      authorizationSurface: "http",
    });
    await syncCreatedScheduledTask({ db, workflowClient, task });
    return c.json(scheduledTaskForGrant(task, grant), 201);
  });

  app.get("/v1/workspaces/:workspaceId/scheduled-tasks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    const tasks = await listScheduledTasks(db, workspaceId, boundedLimit(c.req.query("limit")));
    return c.json(tasks.map((task) => scheduledTaskForGrant(task, grant)));
  });

  app.get("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    return c.json(scheduledTaskForGrant(task, grant));
  });

  app.patch("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const taskId = c.req.param("taskId");
    const existing = await requireScheduledTaskForApi(db, workspaceId, taskId);
    const previous = await captureScheduledTaskRestoreState(db, existing);
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
      sessionAuthorization: deps.sessionAuthorization,
      authorizationSurface: "http",
    });
    const task = await updateScheduledTask(db, workspaceId, taskId, update);
    await syncUpdatedScheduledTask({ db, workflowClient, previous, task });
    return c.json(scheduledTaskForGrant(task, grant));
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/pause", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const existing = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    const previous = await captureScheduledTaskRestoreState(db, existing);
    const task = await updateScheduledTask(db, workspaceId, existing.id, { status: "paused" });
    await syncUpdatedScheduledTask({ db, workflowClient, previous, task });
    return c.json(scheduledTaskForGrant(task, grant));
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/resume", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const existing = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    const previous = await captureScheduledTaskRestoreState(db, existing);
    const task = await updateScheduledTask(db, workspaceId, existing.id, { status: "active" });
    await syncUpdatedScheduledTask({ db, workflowClient, previous, task });
    return c.json(scheduledTaskForGrant(task, grant));
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/trigger", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    // Load the task before the gate so a codex-model scheduled task can be
    // recognised as codex-billed and skip the credit/cost gates at the edge.
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    await validateScheduledTaskTarget({
      db,
      sessionAuthorization: deps.sessionAuthorization,
      authorizationSurface: "http",
      grant,
      targetSessionId: task.targetSessionId,
      runMode: task.runMode,
      variableSetId: task.variableSetId,
      rigId: task.rigId,
      agentConfig: task.agentConfig,
      missingTargetStatus: 404,
    });
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
      initiator: { kind: "subject", subjectId: grant.subjectId },
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
    return c.json(scheduledTaskForGrant(task, grant), 202);
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
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    const taskRuns = await listScheduledTaskRuns(
      db,
      workspaceId,
      task.id,
      boundedLimit(c.req.query("limit")),
    );
    return c.json(taskRuns.map((run) => scheduledTaskRunForGrant(run, grant)));
  });
}
