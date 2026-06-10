import { CreateScheduledTaskRequest, UpdateScheduledTaskRequest } from "@opengeni/contracts";
import {
  deleteScheduledTask,
  listScheduledTaskRuns,
  listScheduledTasks,
  updateScheduledTask,
} from "@opengeni/db";
import type { Hono } from "hono";
import { requireAccessGrant } from "../access";
import { recordWorkspaceUsage, requireLimit } from "../billing/limits";
import type { ApiRouteDeps } from "../dependencies";
import {
  createValidatedScheduledTask,
  requireScheduledTaskForApi,
  syncCreatedScheduledTask,
  syncUpdatedScheduledTask,
  validatedScheduledTaskUpdate,
} from "../domain/scheduled-tasks";
import { boundedLimit } from "../http/common";

export function registerScheduledTaskRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { settings, db, workflowClient, objectStorage } = deps;

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const payload = CreateScheduledTaskRequest.parse(await c.req.json());
    await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "schedule:create", quantity: 1 });
    const task = await createValidatedScheduledTask({ settings, db, objectStorage, grant, payload });
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
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const taskId = c.req.param("taskId");
    const existing = await requireScheduledTaskForApi(db, workspaceId, taskId);
    const payload = UpdateScheduledTaskRequest.parse(await c.req.json());
    const update = await validatedScheduledTaskUpdate({ settings, db, objectStorage, existing, payload });
    const task = await updateScheduledTask(db, workspaceId, taskId, update);
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
	    await requireLimit(deps, { accountId: grant.accountId, workspaceId, action: "agent_run:create", quantity: 1 });
	    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
	    await recordWorkspaceUsage(deps, {
	      accountId: grant.accountId,
	      workspaceId,
	      subjectId: grant.subjectId,
	      eventType: "agent_run.created",
	      quantity: 1,
	      unit: "run",
	      sourceResourceType: "scheduled_task",
	      sourceResourceId: task.id,
	      idempotencyKey: `agent_run.created:scheduled-trigger:${workspaceId}:${task.id}:${crypto.randomUUID()}`,
	    });
	    await workflowClient.triggerScheduledTask({ task });
	    return c.json(task, 202);
	  });

  app.delete("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    await workflowClient.deleteScheduledTaskSchedule({ temporalScheduleId: task.temporalScheduleId });
    await deleteScheduledTask(db, workspaceId, task.id);
    return c.json({ ok: true });
  });

  app.get("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/runs", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    return c.json(await listScheduledTaskRuns(db, workspaceId, task.id, boundedLimit(c.req.query("limit"))));
  });
}
