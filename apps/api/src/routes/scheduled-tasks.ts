import { CreateScheduledTaskRequest, UpdateScheduledTaskRequest } from "@infra-agents/contracts";
import {
  deleteScheduledTask,
  listScheduledTaskRuns,
  listScheduledTasks,
  updateScheduledTask,
} from "@infra-agents/db";
import type { Hono } from "hono";
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

  app.post("/v1/scheduled-tasks", async (c) => {
    const payload = CreateScheduledTaskRequest.parse(await c.req.json());
    const task = await createValidatedScheduledTask({ settings, db, objectStorage, payload });
    await syncCreatedScheduledTask({ db, workflowClient, task });
    return c.json(task, 201);
  });

  app.get("/v1/scheduled-tasks", async (c) => {
    return c.json(await listScheduledTasks(db, boundedLimit(c.req.query("limit"))));
  });

  app.get("/v1/scheduled-tasks/:taskId", async (c) => {
    return c.json(await requireScheduledTaskForApi(db, c.req.param("taskId")));
  });

  app.patch("/v1/scheduled-tasks/:taskId", async (c) => {
    const taskId = c.req.param("taskId");
    const existing = await requireScheduledTaskForApi(db, taskId);
    const payload = UpdateScheduledTaskRequest.parse(await c.req.json());
    const update = await validatedScheduledTaskUpdate({ settings, db, objectStorage, existing, payload });
    const task = await updateScheduledTask(db, taskId, update);
    await syncUpdatedScheduledTask({ db, workflowClient, previous: existing, task });
    return c.json(task);
  });

  app.post("/v1/scheduled-tasks/:taskId/pause", async (c) => {
    const existing = await requireScheduledTaskForApi(db, c.req.param("taskId"));
    const task = await updateScheduledTask(db, existing.id, { status: "paused" });
    await syncUpdatedScheduledTask({ db, workflowClient, previous: existing, task });
    return c.json(task);
  });

  app.post("/v1/scheduled-tasks/:taskId/resume", async (c) => {
    const existing = await requireScheduledTaskForApi(db, c.req.param("taskId"));
    const task = await updateScheduledTask(db, existing.id, { status: "active" });
    await syncUpdatedScheduledTask({ db, workflowClient, previous: existing, task });
    return c.json(task);
  });

  app.post("/v1/scheduled-tasks/:taskId/trigger", async (c) => {
    const task = await requireScheduledTaskForApi(db, c.req.param("taskId"));
    await workflowClient.triggerScheduledTask({ taskId: task.id });
    return c.json(task, 202);
  });

  app.delete("/v1/scheduled-tasks/:taskId", async (c) => {
    const task = await requireScheduledTaskForApi(db, c.req.param("taskId"));
    await workflowClient.deleteScheduledTaskSchedule({ temporalScheduleId: task.temporalScheduleId });
    await deleteScheduledTask(db, task.id);
    return c.json({ ok: true });
  });

  app.get("/v1/scheduled-tasks/:taskId/runs", async (c) => {
    const task = await requireScheduledTaskForApi(db, c.req.param("taskId"));
    return c.json(await listScheduledTaskRuns(db, task.id, boundedLimit(c.req.query("limit"))));
  });
}
