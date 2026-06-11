import type { Settings } from "@opengeni/config";
import type {
  AccessGrant,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  CreateScheduledTaskRequest as CreateScheduledTaskPayload,
  UpdateScheduledTaskRequest as UpdateScheduledTaskPayload,
} from "@opengeni/contracts";
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  updateScheduledTask,
  type Database,
  type UpdateScheduledTaskInput,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { requirePermission } from "../access";
import type { SessionWorkflowClient } from "../dependencies";
import type { ObjectStorageDependency } from "../dependencies";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import { validateEnvironmentAttachment } from "./environments";
import {
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
} from "./resources";

export async function createValidatedScheduledTask(input: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorageDependency;
  grant: AccessGrant;
  payload: CreateScheduledTaskPayload;
  // Set for pack-installation-inherited attachments that were already
  // authorized with environments:use when the pack was enabled.
  environmentPreauthorized?: boolean;
}): Promise<ScheduledTask> {
  const agentConfig = await validateScheduledTaskAgentConfig({ ...input, workspaceId: input.grant.workspaceId });
  const id = crypto.randomUUID();
  validateScheduledTaskSchedule(input.payload.schedule);
  if (input.payload.environmentId) {
    await validateEnvironmentAttachment(
      { settings: input.settings, db: input.db },
      input.grant,
      input.grant.workspaceId,
      input.payload.environmentId,
      { preauthorized: input.environmentPreauthorized ?? false },
    );
  }
  return await createScheduledTask(input.db, {
    id,
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    name: trimmedScheduledTaskName(input.payload.name),
    status: input.payload.status,
    schedule: input.payload.schedule,
    temporalScheduleId: scheduledTaskTemporalScheduleId(id),
    runMode: input.payload.runMode,
    overlapPolicy: input.payload.overlapPolicy,
    agentConfig,
    environmentId: input.payload.environmentId ?? null,
    metadata: input.payload.metadata,
  });
}

export async function validatedScheduledTaskUpdate(input: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorageDependency;
  grant: AccessGrant;
  existing: ScheduledTask;
  payload: UpdateScheduledTaskPayload;
}): Promise<UpdateScheduledTaskInput> {
  const update: UpdateScheduledTaskInput = {};
  if (input.payload.name !== undefined) {
    update.name = trimmedScheduledTaskName(input.payload.name);
  }
  if (input.payload.status !== undefined) {
    update.status = input.payload.status;
  }
  if (input.payload.schedule !== undefined) {
    validateScheduledTaskSchedule(input.payload.schedule);
    update.schedule = input.payload.schedule;
  }
  if (input.payload.runMode !== undefined) {
    update.runMode = input.payload.runMode;
  }
  if (input.payload.overlapPolicy !== undefined) {
    update.overlapPolicy = input.payload.overlapPolicy;
  }
  if (input.payload.metadata !== undefined) {
    update.metadata = input.payload.metadata;
  }
  if (input.payload.environmentId !== undefined) {
    const nextEnvironmentId = input.payload.environmentId;
    if ((input.existing.environmentId ?? null) !== (nextEnvironmentId ?? null)
      && input.existing.runMode === "reusable_session"
      && input.existing.reusableSessionId) {
      throw new HTTPException(409, { message: "cannot change environment of a task with a live reusable session; recreate the task" });
    }
    if (nextEnvironmentId === null) {
      if (input.existing.environmentId !== null) {
        // Detaching is also an attachment change: it strips the secrets a
        // task's instructions were designed around.
        requirePermission(input.grant, "environments:use");
      }
      update.environmentId = null;
    } else {
      await validateEnvironmentAttachment(
        { settings: input.settings, db: input.db },
        input.grant,
        input.existing.workspaceId,
        nextEnvironmentId,
      );
      update.environmentId = nextEnvironmentId;
    }
  }
  if (input.payload.agentConfig !== undefined) {
    // Editing the instructions of a task that injects workspace secrets is
    // equivalent to attaching those secrets to new instructions, so it
    // requires environments:use even though plain task edits do not.
    const willHaveEnvironment = input.payload.environmentId !== undefined
      ? input.payload.environmentId !== null
      : Boolean(input.existing.environmentId);
    if (willHaveEnvironment) {
      requirePermission(input.grant, "environments:use");
    }
    update.agentConfig = await validateScheduledTaskAgentConfig({
      settings: input.settings,
      db: input.db,
      objectStorage: input.objectStorage,
      workspaceId: input.existing.workspaceId,
      payload: { agentConfig: input.payload.agentConfig },
    });
  }
  return update;
}

export async function requireScheduledTaskForApi(db: Database, workspaceId: string, taskId: string): Promise<ScheduledTask> {
  const task = await getScheduledTask(db, workspaceId, taskId);
  if (!task) {
    throw new HTTPException(404, { message: "scheduled task not found" });
  }
  return task;
}

export async function restoreScheduledTask(db: Database, task: ScheduledTask): Promise<ScheduledTask> {
  return await updateScheduledTask(db, task.workspaceId, task.id, {
    name: task.name,
    status: task.status,
    schedule: task.schedule,
    runMode: task.runMode,
    overlapPolicy: task.overlapPolicy,
    agentConfig: task.agentConfig,
    reusableSessionId: task.reusableSessionId,
    environmentId: task.environmentId,
    metadata: task.metadata,
  });
}

export async function syncCreatedScheduledTask(input: {
  db: Database;
  workflowClient: SessionWorkflowClient;
  task: ScheduledTask;
}): Promise<void> {
  try {
    await input.workflowClient.syncScheduledTask({ task: input.task });
  } catch (error) {
    await deleteScheduledTask(input.db, input.task.workspaceId, input.task.id).catch(() => undefined);
    throw error;
  }
}

export async function syncUpdatedScheduledTask(input: {
  db: Database;
  workflowClient: SessionWorkflowClient;
  previous: ScheduledTask;
  task: ScheduledTask;
}): Promise<void> {
  try {
    await input.workflowClient.syncScheduledTask({ task: input.task });
  } catch (error) {
    await restoreScheduledTask(input.db, input.previous).catch(() => undefined);
    throw error;
  }
}

export function scheduledTaskTemporalScheduleId(taskId: string): string {
  return `scheduled-task-${taskId}`;
}

async function validateScheduledTaskAgentConfig(input: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorageDependency;
  payload: { agentConfig: ScheduledTaskAgentConfig };
  workspaceId: string;
}): Promise<ScheduledTaskAgentConfig> {
  const resources = normalizeResources(input.payload.agentConfig.resources ?? []);
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(input.db, input.workspaceId, input.settings);
  const tools = validateToolRefs(input.payload.agentConfig.tools ?? [], runtimeSettings);
  const prompt = input.payload.agentConfig.prompt.trim();
  if (!prompt) {
    throw new HTTPException(422, { message: "scheduled task prompt is required" });
  }
  await validateGitHubRepositorySelection(input.db, input.workspaceId, resources);
  if (resources.some((resource) => resource.kind === "file") && !input.objectStorage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }
  await validateFileResources(input.db, input.workspaceId, resources);
  return {
    ...input.payload.agentConfig,
    prompt,
    resources,
    tools,
  };
}

function validateScheduledTaskSchedule(schedule: ScheduledTask["schedule"]): void {
  if (schedule.type !== "interval" || !schedule.startAt || !schedule.endAt) {
    return;
  }
  if (new Date(schedule.startAt).getTime() >= new Date(schedule.endAt).getTime()) {
    throw new HTTPException(422, { message: "interval schedule endAt must be after startAt" });
  }
}

function trimmedScheduledTaskName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new HTTPException(422, { message: "scheduled task name is required" });
  }
  return trimmed;
}
