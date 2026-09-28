import { z } from "zod";
import {
  CreateScheduledTaskRequest,
  RefreshScheduledTaskAccessRequest,
  TriggerScheduledTaskRequest,
  UpdateScheduledTaskRequest,
} from "@opengeni/contracts";
import { listScheduledTaskRuns, listScheduledTasks } from "@opengeni/db";
import type { Hono } from "hono";
import type { ScheduledTask } from "@opengeni/contracts";
import { HTTPException } from "hono/http-exception";
import {
  requireAccessGrant,
  requireAccessGrantAuthorization,
  resolveWorkspaceCatalogSettings,
} from "@opengeni/core";
import {
  recordWorkspaceUsage,
  requireLimit,
  resolveScheduledTaskPreflightModel,
} from "@opengeni/core";
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
  updateScheduledTaskForApi,
  triggerScheduledTaskForGrant,
  validateScheduledTaskMachineTarget,
  validateScheduledTaskTarget,
  validatedScheduledTaskUpdate,
  listScheduledTaskAccessAttention,
  refreshScheduledTaskAccess,
  scheduledTaskAccessSource,
  withScheduledTaskPolicyDrift,
  withScheduledTaskRunAccessFailures,
} from "@opengeni/core";
import type { AccessGrantAuthorization } from "@opengeni/core";
import { boundedLimit } from "../http/common";
import { permissionsRequiredByFirstPartyTools } from "../mcp/first-party-tool-permissions";
import { deleteScheduledTaskWithDurableCleanup } from "../scheduled-task-deletion";

export function registerScheduledTaskRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, workflowClient, objectStorage } = deps;

  // Drift is advisory: it is attached for viewers who can act on a task and
  // never fails the read it decorates.
  async function withPolicyDrift(
    authorization: AccessGrantAuthorization,
    tasks: ScheduledTask[],
  ): Promise<ScheduledTask[]> {
    if (!tasks.some((task) => scheduledTaskAccessSource(task, authorization.grant))) {
      return tasks;
    }
    const catalogSettings = (
      await resolveWorkspaceCatalogSettings(db, deps.settings, {
        accountId: authorization.grant.accountId,
        workspaceId: authorization.grant.workspaceId,
      })
    ).settings;
    return await withScheduledTaskPolicyDrift({
      db,
      settings: catalogSettings,
      authorization,
      tasks,
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
      onError: (error) => {
        deps.observability?.warn("Scheduled task access drift could not be computed", {
          errorClass: error instanceof Error ? error.name : "ScheduledTaskPolicyDriftError",
          origin: "api",
        });
      },
    });
  }

  // Registered before `/:taskId` so the literal segment is never read as an id.
  app.get("/v1/workspaces/:workspaceId/scheduled-tasks/attention", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    // The account plan reads only the MCP registry and tool defaults, which the
    // model catalog does not change, so the deployment settings suffice here.
    const tasks = await listScheduledTaskAccessAttention({
      db,
      settings: deps.settings,
      grant,
      onError: (error) => {
        deps.observability?.warn("Scheduled task account availability could not be computed", {
          errorClass: error instanceof Error ? error.name : "ScheduledTaskAccessAttentionError",
          origin: "api",
        });
      },
    });
    return c.json({ tasks });
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "scheduled_tasks:manage",
    );
    const grant = authorization.grant;
    const rawPayload = await c.req.json();
    const parsedPayload = CreateScheduledTaskRequest.safeParse(rawPayload);
    if (!parsedPayload.success) {
      throw new HTTPException(400, {
        message: "invalid scheduled task create request",
      });
    }
    const payload = parsedPayload.data;
    const catalogSettings = (
      await resolveWorkspaceCatalogSettings(db, deps.settings, {
        accountId: grant.accountId,
        workspaceId,
      })
    ).settings;
    await requireLimit(deps, {
      accountId: grant.accountId,
      workspaceId,
      action: "schedule:create",
      quantity: 1,
    });
    const task = await createValidatedScheduledTask({
      settings: catalogSettings,
      db,
      objectStorage,
      grant,
      authorization,
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
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "scheduled_tasks:run",
    );
    const grant = authorization.grant;
    const sessionId = c.req.query("sessionId");
    const offset = Number(c.req.query("offset") ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new HTTPException(400, { message: "invalid offset" });
    }
    if (sessionId !== undefined) {
      if (!z.string().uuid().safeParse(sessionId).success) {
        throw new HTTPException(400, { message: "invalid sessionId" });
      }
      await requireAccessGrant(c, deps, workspaceId, "sessions:control");
    }
    const tasks = await listScheduledTasks(
      db,
      workspaceId,
      boundedLimit(c.req.query("limit")),
      offset,
      sessionId,
    );
    return c.json(
      (await withPolicyDrift(authorization, tasks)).map((task) =>
        scheduledTaskForGrant(task, grant),
      ),
    );
  });

  app.get("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "scheduled_tasks:run",
    );
    const grant = authorization.grant;
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    const [withDrift] = await withPolicyDrift(authorization, [task]);
    return c.json(scheduledTaskForGrant(withDrift ?? task, grant));
  });

  // The owner's explicit access refresh: re-freeze connectors, connector
  // accounts and an agent-created task's OpenGeni tools with the calling
  // person's current authority. It changes neither the schedule nor its
  // status, so the Temporal schedule is untouched.
  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/refresh-access", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "scheduled_tasks:manage",
    );
    const parsed = RefreshScheduledTaskAccessRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new HTTPException(400, { message: "invalid scheduled task access refresh request" });
    }
    const catalogSettings = (
      await resolveWorkspaceCatalogSettings(db, deps.settings, {
        accountId: authorization.grant.accountId,
        workspaceId,
      })
    ).settings;
    const task = await refreshScheduledTaskAccess({
      settings: catalogSettings,
      db,
      objectStorage,
      authorization,
      taskId: c.req.param("taskId"),
      request: parsed.data,
      permissionsRequiredByTools: permissionsRequiredByFirstPartyTools,
      sessionAuthorization: deps.sessionAuthorization,
      authorizationSurface: "http",
    });
    const [withDrift] = await withPolicyDrift(authorization, [task]);
    return c.json(scheduledTaskForGrant(withDrift ?? task, authorization.grant));
  });

  app.patch("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "scheduled_tasks:manage",
    );
    const grant = authorization.grant;
    const taskId = c.req.param("taskId");
    const existing = await requireScheduledTaskForApi(db, workspaceId, taskId);
    const previous = await captureScheduledTaskRestoreState(db, existing);
    const rawPayload = await c.req.json();
    const parsedPayload = UpdateScheduledTaskRequest.safeParse(rawPayload);
    if (!parsedPayload.success) {
      throw new HTTPException(400, {
        message: "invalid scheduled task update request",
      });
    }
    const payload = parsedPayload.data;
    const catalogSettings = (
      await resolveWorkspaceCatalogSettings(db, deps.settings, {
        accountId: grant.accountId,
        workspaceId,
      })
    ).settings;
    const update = await validatedScheduledTaskUpdate({
      settings: catalogSettings,
      db,
      objectStorage,
      grant,
      existing,
      authorization,
      payload,
      toolsProvided: scheduledTaskToolsProvided(rawPayload),
      sessionAuthorization: deps.sessionAuthorization,
      authorizationSurface: "http",
    });
    const task = await updateScheduledTaskForApi(
      db,
      grant,
      taskId,
      update,
      payload.agentLearning
        ? { authorization, request: payload.agentLearning, restoreState: previous }
        : undefined,
    );
    await syncUpdatedScheduledTask({ db, workflowClient, previous, task });
    return c.json(scheduledTaskForGrant(task, grant));
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/pause", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    const existing = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    const previous = await captureScheduledTaskRestoreState(db, existing);
    const task = await updateScheduledTaskForApi(db, grant, existing.id, {
      status: "paused",
    });
    await syncUpdatedScheduledTask({ db, workflowClient, previous, task });
    return c.json(scheduledTaskForGrant(task, grant));
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/resume", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "scheduled_tasks:manage",
    );
    const grant = authorization.grant;
    const existing = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    const previous = await captureScheduledTaskRestoreState(db, existing);
    const catalogSettings = (
      await resolveWorkspaceCatalogSettings(db, deps.settings, {
        accountId: grant.accountId,
        workspaceId,
      })
    ).settings;
    const update = await validatedScheduledTaskUpdate({
      settings: catalogSettings,
      db,
      objectStorage,
      grant,
      existing,
      payload: { status: "active" },
      authorization,
      sessionAuthorization: deps.sessionAuthorization,
      authorizationSurface: "http",
    });
    const task = await updateScheduledTaskForApi(db, grant, existing.id, update);
    await syncUpdatedScheduledTask({ db, workflowClient, previous, task });
    return c.json(scheduledTaskForGrant(task, grant));
  });

  app.post("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId/trigger", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
    // Load the task before the gate so a codex-model scheduled task can be
    // recognised as codex-billed and skip the credit/cost gates at the edge.
    const task = await requireScheduledTaskForApi(db, workspaceId, c.req.param("taskId"));
    if (task.action.kind === "agent_turn") {
      const catalogSettings = (
        await resolveWorkspaceCatalogSettings(db, deps.settings, {
          accountId: grant.accountId,
          workspaceId,
        })
      ).settings;
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
      await validateScheduledTaskMachineTarget({
        settings: catalogSettings,
        db,
        grant,
        runMode: task.runMode,
        agentConfig: task.agentConfig,
        requireOnline: true,
      });
      await requireLimit(
        { ...deps, settings: catalogSettings },
        {
          accountId: grant.accountId,
          workspaceId,
          action: "agent_run:create",
          quantity: 1,
          // A model-less task is checked against the model its occurrence
          // will run (a connected subscription, the credits default, or the
          // deployment default), not always the deployment default.
          model: await resolveScheduledTaskPreflightModel(db, catalogSettings, task),
        },
      );
    }
    // Body is optional (a bare POST is still a valid trigger); only a present,
    // non-empty body must parse against the contract.
    const body = await c.req.json().catch(() => ({}));
    const { triggerId } = TriggerScheduledTaskRequest.parse(body ?? {});
    const triggerToken = scheduledTaskTriggerToken(triggerId);
    const agentRunUsageIdempotencyKey =
      task.action.kind === "agent_turn"
        ? manualScheduledTaskTriggerUsageKey(workspaceId, task.id, triggerToken)
        : `knowledge-source-sync:manual:${workspaceId}:${task.id}:${triggerToken}`;
    const triggerWorkflowId = manualScheduledTaskTriggerWorkflowId(task.id, triggerToken);
    await triggerScheduledTaskForGrant(db, grant, workflowClient, {
      task,
      agentRunUsageIdempotencyKey,
      triggerWorkflowId,
      initiator: { kind: "subject", subjectId: grant.subjectId },
    });
    if (task.action.kind === "agent_turn") {
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
    }
    return c.json(scheduledTaskForGrant(task, grant), 202);
  });

  app.delete("/v1/workspaces/:workspaceId/scheduled-tasks/:taskId", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:manage");
    await deleteScheduledTaskWithDurableCleanup(deps, {
      grant,
      taskId: c.req.param("taskId"),
    });
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
    const runs = await withScheduledTaskRunAccessFailures({
      db,
      settings: deps.settings,
      grant,
      task,
      runs: taskRuns,
    });
    return c.json(runs.map((run) => scheduledTaskRunForGrant(run, grant)));
  });
}
