import { z } from "zod";
import {
  CreateScheduledTaskRequest,
  ScheduledTaskSlackChannelId,
  ScheduledTaskSlackChannelListResponse,
  TriggerScheduledTaskRequest,
  UpdateScheduledTaskRequest,
  type AccessGrant,
} from "@opengeni/contracts";
import { listScheduledTaskRuns, listScheduledTasks } from "@opengeni/db";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  isAuthenticatedPersonAuthorization,
  requireAccessGrant,
  requireAccessGrantAuthorization,
  requirePermission,
  resolveWorkspaceCatalogSettings,
  validateOpenGeniSlackBotConnectionSelection,
  type ScheduledTaskSlackChannelVerifier,
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
} from "@opengeni/core";
import { boundedLimit } from "../http/common";
import {
  createOpenGeniSlackBotInteractionClient,
  verifyScheduledTaskSlackChannel,
} from "../integrations/slack-bot";
import { deleteScheduledTaskWithDurableCleanup } from "../scheduled-task-deletion";

export function registerScheduledTaskRoutes(app: Hono, deps: ApiRouteDeps): void {
  const { db, workflowClient, objectStorage } = deps;
  const slackChannelVerifier =
    (grant: AccessGrant): ScheduledTaskSlackChannelVerifier =>
    async ({ connectionId, channelId }) =>
      await verifyScheduledTaskSlackChannel(deps, {
        accountId: grant.accountId,
        workspaceId: grant.workspaceId,
        subjectId: grant.subjectId,
        connectionId,
        channelId,
      });

  // Channels a person may choose as a task's fixed Slack destination: active,
  // non-shared channels the selected OpenGeni bot already belongs to.
  app.get("/v1/workspaces/:workspaceId/scheduled-task-slack-channels", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const authorization = await requireAccessGrantAuthorization(
      c,
      deps,
      workspaceId,
      "scheduled_tasks:manage",
    );
    const grant = authorization.grant;
    requirePermission(grant, "connections:write");
    if (!isAuthenticatedPersonAuthorization(authorization)) {
      throw new HTTPException(403, {
        message: "Only a person can choose the Slack channel a scheduled task posts to",
      });
    }
    const connectionId = c.req.query("connectionId");
    if (!connectionId || !z.string().uuid().safeParse(connectionId).success) {
      throw new HTTPException(400, { message: "connectionId is required" });
    }
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && cursor.length > 1_024) {
      throw new HTTPException(400, { message: "invalid cursor" });
    }
    await validateOpenGeniSlackBotConnectionSelection(db, grant, workspaceId, connectionId);
    const client = await createOpenGeniSlackBotInteractionClient(deps, {
      accountId: grant.accountId,
      workspaceId,
      connectionId,
      subjectId: grant.subjectId,
    });
    const result = await client.listChannels({ limit: 200, ...(cursor ? { cursor } : {}) });
    c.header("cache-control", "private, no-store");
    return c.json(
      ScheduledTaskSlackChannelListResponse.parse({
        channels: result.channels
          .filter(
            (channel) =>
              channel.isMember &&
              !channel.isArchived &&
              !channel.isShared &&
              !channel.isExternallyShared &&
              !channel.isOrgShared &&
              ScheduledTaskSlackChannelId.safeParse(channel.id).success,
          )
          .map((channel) => ({ id: channel.id, name: channel.name, isPrivate: channel.isPrivate })),
        nextCursor: result.nextCursor || null,
      }),
    );
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
      verifySlackChannel: slackChannelVerifier(grant),
    });
    await syncCreatedScheduledTask({ db, workflowClient, task });
    return c.json(scheduledTaskForGrant(task, grant), 201);
  });

  app.get("/v1/workspaces/:workspaceId/scheduled-tasks", async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const grant = await requireAccessGrant(c, deps, workspaceId, "scheduled_tasks:run");
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
      verifySlackChannel: slackChannelVerifier(grant),
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
    return c.json(taskRuns.map((run) => scheduledTaskRunForGrant(run, grant)));
  });
}
