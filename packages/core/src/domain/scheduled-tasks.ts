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
  getRig,
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
import { validateVariableSetAttachment } from "./environments";
import { assertConfiguredModel } from "./sessions";
import {
  normalizeResources,
  validateFileResources,
  validateGitHubRepositorySelection,
  validateToolRefs,
  withDefaultEnabledCapabilityMcpTools,
} from "./resources";

/**
 * Whether a raw scheduled-task payload explicitly set agentConfig.tools.
 * Zod's `.default([])` erases the distinction between "absent" and
 * "explicitly empty", so callers detect it on the raw payload — the same
 * contract sessions use: absent tools mean "give me the workspace defaults
 * (enabled capability MCP servers)", an explicit list (even empty) is taken
 * verbatim.
 */
export function scheduledTaskToolsProvided(rawPayload: unknown): boolean {
  if (!rawPayload || typeof rawPayload !== "object") {
    return false;
  }
  const agentConfig = (rawPayload as { agentConfig?: unknown }).agentConfig;
  return Boolean(
    agentConfig
    && typeof agentConfig === "object"
    && Object.prototype.hasOwnProperty.call(agentConfig, "tools"),
  );
}

export async function createValidatedScheduledTask(input: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorageDependency;
  grant: AccessGrant;
  payload: CreateScheduledTaskPayload;
  // Whether the caller explicitly set agentConfig.tools (see
  // scheduledTaskToolsProvided). Absent tools get the workspace's enabled
  // capability MCP servers, mirroring session creation.
  toolsProvided?: boolean;
  // Set for pack-installation-inherited attachments that were already
  // authorized with variable-sets:use when the pack was enabled.
  variableSetPreauthorized?: boolean;
}): Promise<ScheduledTask> {
  const agentConfig = await validateScheduledTaskAgentConfig({ ...input, workspaceId: input.grant.workspaceId });
  const id = crypto.randomUUID();
  validateScheduledTaskSchedule(input.payload.schedule);
  if (input.payload.variableSetId) {
    await validateVariableSetAttachment(
      { settings: input.settings, db: input.db },
      input.grant,
      input.grant.workspaceId,
      input.payload.variableSetId,
      { preauthorized: input.variableSetPreauthorized ?? false },
    );
  }
  // The rig is stored on the task and resolved to its ACTIVE version per fire
  // (at dispatch), so validate only that the id names a rig in the workspace —
  // NOT that it has an active version now (that is a fire-time concern). RLS
  // makes a cross-workspace id indistinguishable from missing → both 422.
  if (input.payload.rigId) {
    await requireScheduledTaskRig(input.db, input.grant.workspaceId, input.payload.rigId);
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
    variableSetId: input.payload.variableSetId ?? null,
    rigId: input.payload.rigId ?? null,
    metadata: input.payload.metadata,
  });
}

// Validate a scheduled task's rig reference: it must name a rig in the
// workspace. A missing/cross-workspace id is a 422 (RLS-invisible == missing).
async function requireScheduledTaskRig(db: Database, workspaceId: string, rigId: string): Promise<void> {
  const rig = await getRig(db, workspaceId, rigId);
  if (!rig) {
    throw new HTTPException(422, { message: `unknown rigId: ${rigId}` });
  }
}

export async function validatedScheduledTaskUpdate(input: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorageDependency;
  grant: AccessGrant;
  existing: ScheduledTask;
  payload: UpdateScheduledTaskPayload;
  /** See createValidatedScheduledTask; only consulted when agentConfig is updated. */
  toolsProvided?: boolean;
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
  if (input.payload.variableSetId !== undefined) {
    const nextVariableSetId = input.payload.variableSetId;
    if ((input.existing.variableSetId ?? null) !== (nextVariableSetId ?? null)
      && input.existing.runMode === "reusable_session"
      && input.existing.reusableSessionId) {
      throw new HTTPException(409, { message: "cannot change variableSet of a task with a live reusable session; recreate the task" });
    }
    if (nextVariableSetId === null) {
      if (input.existing.variableSetId !== null) {
        // Detaching is also an attachment change: it strips the secrets a
        // task's instructions were designed around.
        requirePermission(input.grant, "variable-sets:use");
      }
      update.variableSetId = null;
    } else {
      await validateVariableSetAttachment(
        { settings: input.settings, db: input.db },
        input.grant,
        input.existing.workspaceId,
        nextVariableSetId,
      );
      update.variableSetId = nextVariableSetId;
    }
  }
  if (input.payload.rigId !== undefined) {
    // The rig binds fresh per fire, so changing it on a reusable-session task is
    // harmless for the LIVE session (which keeps its own frozen version) and
    // only affects subsequent new-session fires — no live-session guard needed.
    if (input.payload.rigId !== null) {
      await requireScheduledTaskRig(input.db, input.existing.workspaceId, input.payload.rigId);
    }
    update.rigId = input.payload.rigId;
  }
  if (input.payload.agentConfig !== undefined) {
    // Editing the instructions of a task that injects workspace secrets is
    // equivalent to attaching those secrets to new instructions, so it
    // requires variable-sets:use even though plain task edits do not.
    const willHaveVariableSet = input.payload.variableSetId !== undefined
      ? input.payload.variableSetId !== null
      : Boolean(input.existing.variableSetId);
    if (willHaveVariableSet) {
      requirePermission(input.grant, "variable-sets:use");
    }
    update.agentConfig = await validateScheduledTaskAgentConfig({
      settings: input.settings,
      db: input.db,
      objectStorage: input.objectStorage,
      workspaceId: input.existing.workspaceId,
      payload: { agentConfig: input.payload.agentConfig },
      ...(input.toolsProvided !== undefined ? { toolsProvided: input.toolsProvided } : {}),
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
    variableSetId: task.variableSetId,
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

/**
 * Stable token that identifies a single logical manual trigger. A client that
 * retries a `/trigger` POST (network blip, lambda re-invocation) passes the
 * SAME token so the retry is idempotent — one usage charge, one workflow run.
 * When the client supplies nothing we mint one UUID PER REQUEST and reuse it
 * for both the idempotency key and the workflowId, so a single request stays
 * internally consistent while two genuinely-distinct manual triggers (no token,
 * fired a second apart) still each get their own run. The token is sanitized to
 * the Temporal workflow-id-safe charset so a client value cannot smuggle a
 * collision into a different task's id space.
 */
export function scheduledTaskTriggerToken(clientTriggerId?: string | null): string {
  const trimmed = (clientTriggerId ?? "").trim();
  if (!trimmed) {
    return crypto.randomUUID();
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  // A value that sanitizes to empty (only disallowed chars) is unusable as a
  // stable id; fall back to a fresh token rather than collapse to a constant.
  return safe.length > 0 ? safe : crypto.randomUUID();
}

/**
 * Deterministic Temporal workflow id for a manual trigger. Derived purely from
 * the task id and the stable trigger token, so a retry with the same token maps
 * to the same id and `workflowIdReusePolicy: "REJECT_DUPLICATE"` collapses the
 * second start into a no-op instead of spawning a second run.
 */
export function manualScheduledTaskTriggerWorkflowId(taskId: string, triggerToken: string): string {
  return `scheduled-task-${taskId}-manual-${triggerToken}`;
}

/**
 * Deterministic usage idempotency key for a manual trigger's agent_run.created
 * charge. Shares the stable trigger token with the workflow id so the charge
 * and the run dedupe together under retry.
 */
export function manualScheduledTaskTriggerUsageKey(workspaceId: string, taskId: string, triggerToken: string): string {
  return `agent_run.created:scheduled-trigger:${workspaceId}:${taskId}:${triggerToken}`;
}

async function validateScheduledTaskAgentConfig(input: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorageDependency;
  payload: { agentConfig: ScheduledTaskAgentConfig };
  workspaceId: string;
  toolsProvided?: boolean;
}): Promise<ScheduledTaskAgentConfig> {
  // Reject a curated-out model before touching the DB: a scheduled task is a
  // session the worker runs later, so it must pass the same allow-list as the
  // session choke points (a `scheduled_tasks:manage` holder could otherwise set
  // a model the host does not expose). An omitted model inherits the host
  // default downstream, which is always configured.
  assertConfiguredModel(input.settings, input.payload.agentConfig.model);
  const resources = normalizeResources(input.payload.agentConfig.resources ?? []);
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(input.db, input.workspaceId, input.settings);
  const requestedTools = validateToolRefs(input.payload.agentConfig.tools ?? [], runtimeSettings);
  // A task whose creator did not choose tools gets the workspace's enabled
  // capability MCP servers, exactly like a session created without a tools
  // key. Scheduled runs are sessions too; "no MCP servers at all" was a trap
  // every pack/template instantiation path kept falling into (a maintenance
  // task that cannot reach its workspace's notebook MCP cannot do its job).
  const tools = (input.toolsProvided ?? true)
    ? requestedTools
    : withDefaultEnabledCapabilityMcpTools(requestedTools, input.settings, runtimeSettings);
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
