import type { Settings } from "@opengeni/config";
import type {
  AccessGrant,
  McpPersonalConnectionDelegation,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  Session,
  SessionAuthorizationPort,
  SessionAuthorizationSurface,
  CreateScheduledTaskRequest as CreateScheduledTaskPayload,
  UpdateScheduledTaskRequest as UpdateScheduledTaskPayload,
} from "@opengeni/contracts";
import { OPENGENI_SLACK_BOT_SESSION_METADATA_KEY } from "@opengeni/contracts";
import {
  createScheduledTask,
  deleteScheduledTask,
  getNestedAgentDepthDeploymentPolicy,
  getRig,
  getScheduledTask,
  getScheduledTaskPersonalConnectionDelegations,
  getSession,
  requireWorkspace,
  updateScheduledTask,
  type Database,
  type UpdateScheduledTaskInput,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { hasPermission, requirePermission } from "../access";
import {
  requireSessionAuthorization,
  SessionAuthorizationDeniedError,
  SessionAuthorizationUnavailableError,
} from "../session-authorization";
import type { SessionWorkflowClient } from "../dependencies";
import type { ObjectStorageDependency } from "../dependencies";
import { settingsWithEnabledCapabilityMcpServers } from "./capabilities";
import { validateVariableSetAttachment } from "./environments";
import {
  freezePersonalConnectionDelegations,
  personalConnectionDelegationSourceForGrant,
  personalConnectionDelegationsEqual,
} from "./personal-connection-delegations";
import {
  assertWorkspaceModelPolicyAllows,
  canonicalConfiguredModel,
  creationInitiatorForGrant,
} from "./sessions";
import {
  hasReservedOpenGeniSlackBotSessionMetadata,
  scheduledSlackBotConnectionId,
  validateOpenGeniSlackBotConnectionSelection,
} from "./slack-bot";
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
    agentConfig &&
    typeof agentConfig === "object" &&
    Object.prototype.hasOwnProperty.call(agentConfig, "tools"),
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
  sessionAuthorization?: SessionAuthorizationPort | null | undefined;
  authorizationSurface?: SessionAuthorizationSurface | undefined;
}): Promise<ScheduledTask> {
  const agentConfig = await validateScheduledTaskAgentConfig({
    ...input,
    workspaceId: input.grant.workspaceId,
  });
  const id = crypto.randomUUID();
  validateScheduledTaskSchedule(input.payload.schedule);
  const target = await validateScheduledTaskTarget({
    db: input.db,
    sessionAuthorization: input.sessionAuthorization,
    authorizationSurface: input.authorizationSurface,
    grant: input.grant,
    targetSessionId: input.payload.targetSessionId,
    runMode: input.payload.runMode,
    variableSetId: input.payload.variableSetId,
    rigId: input.payload.rigId,
    agentConfig,
  });
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
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
    input.db,
    input.grant.workspaceId,
    input.settings,
  );
  const personalConnectionDelegations = await freezePersonalConnectionDelegations({
    db: input.db,
    workspaceId: input.grant.workspaceId,
    settings: runtimeSettings,
    tools: [...agentConfig.tools, { kind: "mcp", id: "opengeni" }],
    source: personalConnectionDelegationSourceForGrant(input.grant),
  });
  const creationInitiator = creationInitiatorForGrant(input.grant);
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
    ...(creationInitiator.initiator ? { createdBy: creationInitiator.initiator } : {}),
    ...(creationInitiator.context ? { createdByContext: creationInitiator.context } : {}),
    createdByActor: creationInitiator.actor ?? null,
    personalConnectionDelegations,
    targetSessionId: target?.id ?? null,
    variableSetId: input.payload.variableSetId ?? null,
    rigId: input.payload.rigId ?? null,
    metadata: input.payload.metadata,
  });
}

export async function validateScheduledTaskTarget(input: {
  db: Database;
  sessionAuthorization?: SessionAuthorizationPort | null | undefined;
  authorizationSurface?: SessionAuthorizationSurface | undefined;
  grant: AccessGrant;
  targetSessionId: string | null | undefined;
  runMode: ScheduledTask["runMode"];
  variableSetId: string | null | undefined;
  rigId: string | null | undefined;
  agentConfig: ScheduledTaskAgentConfig;
  missingTargetStatus?: 404 | 422;
}): Promise<Session | null> {
  if (input.runMode !== "existing_session") {
    if (input.targetSessionId) {
      throw new HTTPException(422, {
        message: "targetSessionId requires runMode=existing_session",
      });
    }
    return null;
  }
  if (!input.targetSessionId) {
    throw new HTTPException(input.missingTargetStatus ?? 422, {
      message:
        input.missingTargetStatus === 404
          ? "target session not found"
          : "targetSessionId is required when runMode=existing_session",
    });
  }
  requirePermission(input.grant, "sessions:control");
  if (input.agentConfig.goal) {
    throw new HTTPException(422, {
      message: "agentConfig.goal cannot be used with an existing-session target",
    });
  }
  try {
    await requireSessionAuthorization(
      {
        db: input.db,
        ...(input.sessionAuthorization !== undefined
          ? { sessionAuthorization: input.sessionAuthorization }
          : {}),
      },
      input.grant,
      {
        sessionId: input.targetSessionId,
        operation: "session.control",
        surface: input.authorizationSurface ?? "http",
      },
    );
  } catch (error) {
    if (error instanceof SessionAuthorizationDeniedError) {
      throw new HTTPException(404, { message: "target session not found" });
    }
    if (error instanceof SessionAuthorizationUnavailableError) {
      throw new HTTPException(503, { message: "session authorization is unavailable" });
    }
    throw error;
  }
  const session = await getSession(input.db, input.grant.workspaceId, input.targetSessionId);
  if (!session || session.accountId !== input.grant.accountId) {
    throw new HTTPException(404, { message: "target session not found" });
  }
  if (session.status === "cancelled") {
    throw new HTTPException(409, {
      message: "target session is cancelled; choose a revivable session",
    });
  }
  if ((session.variableSetId ?? null) !== (input.variableSetId ?? null)) {
    throw new HTTPException(422, {
      message: "target session variableSet attachment does not match the scheduled task",
    });
  }
  if (input.rigId && input.rigId !== session.rigId) {
    throw new HTTPException(422, {
      message: "target session rig does not match the scheduled task",
    });
  }
  if (
    input.agentConfig.sandboxBackend !== undefined &&
    input.agentConfig.sandboxBackend !== session.sandboxBackend
  ) {
    throw new HTTPException(422, {
      message: "target session sandbox backend does not match the scheduled task",
    });
  }
  if (
    scheduledSlackBotConnectionId(session.metadata) !==
    (input.agentConfig.slackBotConnectionId ?? null)
  ) {
    throw new HTTPException(422, {
      message: "target session OpenGeni Slack bot binding does not match the scheduled task",
    });
  }
  return session;
}

export function scheduledTaskForGrant(task: ScheduledTask, grant: AccessGrant): ScheduledTask {
  if (hasPermission(grant.permissions, "sessions:control") || task.targetSessionId === null) {
    return task;
  }
  return { ...task, targetSessionId: null };
}

export function scheduledTaskRunForGrant<T extends { sessionId: string | null }>(
  run: T,
  grant: AccessGrant,
): T {
  if (hasPermission(grant.permissions, "sessions:control") || run.sessionId === null) {
    return run;
  }
  return { ...run, sessionId: null };
}

// Validate a scheduled task's rig reference: it must name a rig in the
// workspace. A missing/cross-workspace id is a 422 (RLS-invisible == missing).
async function requireScheduledTaskRig(
  db: Database,
  workspaceId: string,
  rigId: string,
): Promise<void> {
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
  sessionAuthorization?: SessionAuthorizationPort | null | undefined;
  authorizationSurface?: SessionAuthorizationSurface | undefined;
}): Promise<UpdateScheduledTaskInput> {
  const update: UpdateScheduledTaskInput = {};
  const existingTarget = input.existing.targetSessionId;
  const nextRunMode = input.payload.runMode ?? input.existing.runMode;
  const nextTargetSessionId =
    input.payload.targetSessionId !== undefined
      ? input.payload.targetSessionId
      : nextRunMode === "existing_session"
        ? existingTarget
        : null;
  if (
    input.existing.runMode === "reusable_session" &&
    input.existing.reusableSessionId &&
    nextRunMode === "existing_session"
  ) {
    throw new HTTPException(409, {
      message:
        "cannot target an existing session after this task created its reusable session; create a new task",
    });
  }
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
    if (
      (input.existing.variableSetId ?? null) !== (nextVariableSetId ?? null) &&
      input.existing.runMode === "reusable_session" &&
      input.existing.reusableSessionId
    ) {
      throw new HTTPException(409, {
        message:
          "cannot change variableSet of a task with a live reusable session; recreate the task",
      });
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
    const willHaveVariableSet =
      input.payload.variableSetId !== undefined
        ? input.payload.variableSetId !== null
        : Boolean(input.existing.variableSetId);
    if (willHaveVariableSet) {
      requirePermission(input.grant, "variable-sets:use");
    }
    const nextAgentConfig = await validateScheduledTaskAgentConfig({
      settings: input.settings,
      db: input.db,
      objectStorage: input.objectStorage,
      grant: input.grant,
      workspaceId: input.existing.workspaceId,
      payload: { agentConfig: input.payload.agentConfig },
      ...(input.toolsProvided !== undefined ? { toolsProvided: input.toolsProvided } : {}),
    });
    if (
      input.existing.reusableSessionId &&
      input.existing.runMode === "reusable_session" &&
      (input.existing.agentConfig.slackBotConnectionId ?? null) !==
        (nextAgentConfig.slackBotConnectionId ?? null)
    ) {
      throw new HTTPException(409, {
        message:
          "cannot change the OpenGeni Slack bot connection of a task with a live reusable session; recreate the task",
      });
    }
    update.agentConfig = nextAgentConfig;
    const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
      input.db,
      input.existing.workspaceId,
      input.settings,
    );
    const personalConnectionDelegations = await freezePersonalConnectionDelegations({
      db: input.db,
      workspaceId: input.existing.workspaceId,
      settings: runtimeSettings,
      tools: [...nextAgentConfig.tools, { kind: "mcp", id: "opengeni" }],
      source: personalConnectionDelegationSourceForGrant(input.grant),
    });
    if (input.existing.reusableSessionId && input.existing.runMode === "reusable_session") {
      const existingDelegations = await getScheduledTaskPersonalConnectionDelegations(
        input.db,
        input.existing.workspaceId,
        input.existing.id,
      );
      if (!personalConnectionDelegationsEqual(existingDelegations, personalConnectionDelegations)) {
        throw new HTTPException(409, {
          message:
            "cannot change personal MCP connections of a task with a live reusable session; recreate the task",
        });
      }
    }
    update.personalConnectionDelegations = personalConnectionDelegations;
  }
  if (
    existingTarget &&
    (nextRunMode !== "existing_session" || nextTargetSessionId !== existingTarget)
  ) {
    await validateScheduledTaskTarget({
      db: input.db,
      sessionAuthorization: input.sessionAuthorization,
      authorizationSurface: input.authorizationSurface,
      grant: input.grant,
      targetSessionId: existingTarget,
      runMode: "existing_session",
      variableSetId: input.existing.variableSetId,
      rigId: input.existing.rigId,
      agentConfig: input.existing.agentConfig,
    });
  }
  await validateScheduledTaskTarget({
    db: input.db,
    sessionAuthorization: input.sessionAuthorization,
    authorizationSurface: input.authorizationSurface,
    grant: input.grant,
    targetSessionId: nextTargetSessionId,
    runMode: nextRunMode,
    variableSetId:
      input.payload.variableSetId !== undefined
        ? input.payload.variableSetId
        : input.existing.variableSetId,
    rigId: input.payload.rigId !== undefined ? input.payload.rigId : input.existing.rigId,
    agentConfig: update.agentConfig ?? input.existing.agentConfig,
  });
  if (
    input.payload.targetSessionId !== undefined ||
    input.existing.runMode === "existing_session" ||
    nextRunMode === "existing_session"
  ) {
    update.targetSessionId = nextTargetSessionId;
  }
  return update;
}

export async function requireScheduledTaskForApi(
  db: Database,
  workspaceId: string,
  taskId: string,
): Promise<ScheduledTask> {
  const task = await getScheduledTask(db, workspaceId, taskId);
  if (!task) {
    throw new HTTPException(404, { message: "scheduled task not found" });
  }
  return task;
}

export type ScheduledTaskRestoreState = {
  task: ScheduledTask;
  personalConnectionDelegations: McpPersonalConnectionDelegation[];
};

export async function captureScheduledTaskRestoreState(
  db: Database,
  task: ScheduledTask,
): Promise<ScheduledTaskRestoreState> {
  return {
    task,
    personalConnectionDelegations: await getScheduledTaskPersonalConnectionDelegations(
      db,
      task.workspaceId,
      task.id,
    ),
  };
}

export async function restoreScheduledTask(
  db: Database,
  previous: ScheduledTaskRestoreState,
): Promise<ScheduledTask> {
  const { task } = previous;
  return await updateScheduledTask(db, task.workspaceId, task.id, {
    name: task.name,
    status: task.status,
    schedule: task.schedule,
    runMode: task.runMode,
    overlapPolicy: task.overlapPolicy,
    agentConfig: task.agentConfig,
    personalConnectionDelegations: previous.personalConnectionDelegations,
    ...(task.runMode === "existing_session"
      ? { targetSessionId: task.targetSessionId }
      : { reusableSessionId: task.reusableSessionId }),
    variableSetId: task.variableSetId,
    rigId: task.rigId,
    metadata: task.metadata,
  });
}

export class ScheduledTaskSyncError extends Error {
  readonly persistenceRestored: boolean;

  constructor(cause: unknown, persistenceRestored: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ScheduledTaskSyncError";
    this.persistenceRestored = persistenceRestored;
  }
}

export async function syncCreatedScheduledTask(input: {
  db: Database;
  workflowClient: SessionWorkflowClient;
  task: ScheduledTask;
}): Promise<void> {
  try {
    await input.workflowClient.syncScheduledTask({ task: input.task });
  } catch (error) {
    let persistenceRestored = true;
    try {
      await deleteScheduledTask(input.db, input.task.workspaceId, input.task.id);
    } catch {
      persistenceRestored = false;
    }
    throw new ScheduledTaskSyncError(error, persistenceRestored);
  }
}

export async function syncUpdatedScheduledTask(input: {
  db: Database;
  workflowClient: SessionWorkflowClient;
  previous: ScheduledTaskRestoreState;
  task: ScheduledTask;
}): Promise<void> {
  try {
    await input.workflowClient.syncScheduledTask({ task: input.task });
  } catch (error) {
    let persistenceRestored = true;
    try {
      await restoreScheduledTask(input.db, input.previous);
    } catch {
      persistenceRestored = false;
    }
    throw new ScheduledTaskSyncError(error, persistenceRestored);
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
export function manualScheduledTaskTriggerUsageKey(
  workspaceId: string,
  taskId: string,
  triggerToken: string,
): string {
  return `agent_run.created:scheduled-trigger:${workspaceId}:${taskId}:${triggerToken}`;
}

async function validateScheduledTaskAgentConfig(input: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorageDependency;
  grant: AccessGrant;
  payload: { agentConfig: ScheduledTaskAgentConfig };
  workspaceId: string;
  toolsProvided?: boolean;
}): Promise<ScheduledTaskAgentConfig> {
  // Reject a curated-out model before touching the DB: a scheduled task is a
  // session the worker runs later, so it must pass the same allow-list as the
  // session choke points (a `scheduled_tasks:manage` holder could otherwise set
  // a model the host does not expose). An omitted model inherits the host
  // default downstream, which is always configured.
  const model = canonicalConfiguredModel(input.settings, input.payload.agentConfig.model);
  // Same policy vetting as the session choke points; an omitted model flows
  // through session creation later, where the effective default is vetted.
  await assertWorkspaceModelPolicyAllows(input.db, input.settings, input.workspaceId, model);
  const resources = normalizeResources(input.payload.agentConfig.resources ?? []);
  const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
    input.db,
    input.workspaceId,
    input.settings,
  );
  const requestedTools = validateToolRefs(input.payload.agentConfig.tools ?? [], runtimeSettings);
  // A task whose creator did not choose tools gets the workspace's enabled
  // capability MCP servers, exactly like a session created without a tools
  // key. Scheduled runs are sessions too; "no MCP servers at all" was a trap
  // every pack/template instantiation path kept falling into (a maintenance
  // task that cannot reach its workspace's notebook MCP cannot do its job).
  const tools =
    (input.toolsProvided ?? true)
      ? requestedTools
      : withDefaultEnabledCapabilityMcpTools(requestedTools, input.settings, runtimeSettings);
  const prompt = input.payload.agentConfig.prompt.trim();
  if (!prompt) {
    throw new HTTPException(422, { message: "scheduled task prompt is required" });
  }
  if (hasReservedOpenGeniSlackBotSessionMetadata(input.payload.agentConfig.metadata)) {
    throw new HTTPException(422, {
      message: `${OPENGENI_SLACK_BOT_SESSION_METADATA_KEY} is reserved for scheduler routing`,
    });
  }
  await validateGitHubRepositorySelection(input.db, input.workspaceId, resources);
  if (resources.some((resource) => resource.kind === "file") && !input.objectStorage) {
    throw new HTTPException(503, { message: "object storage is not configured" });
  }
  await validateFileResources(input.db, input.workspaceId, resources);
  if (input.payload.agentConfig.slackBotConnectionId) {
    await validateOpenGeniSlackBotConnectionSelection(
      input.db,
      input.grant,
      input.workspaceId,
      input.payload.agentConfig.slackBotConnectionId,
    );
  }
  const requestedMaxDepth = input.payload.agentConfig.maxNestedAgentDepth;
  if (requestedMaxDepth !== undefined) {
    const workspace = await requireWorkspace(input.db, input.workspaceId);
    const workspaceMaxDepth = workspace.settings.maxNestedAgentDepth;
    const deploymentPolicy = await getNestedAgentDepthDeploymentPolicy(input.db);
    const inheritedMaxDepth =
      typeof workspaceMaxDepth === "number"
        ? workspaceMaxDepth
        : deploymentPolicy.maxNestedAgentDepth;
    if (
      requestedMaxDepth > inheritedMaxDepth &&
      !hasPermission(input.grant.permissions, "workspace:admin")
    ) {
      throw new HTTPException(403, {
        message: `scheduled task maxNestedAgentDepth ${requestedMaxDepth} exceeds inherited limit ${inheritedMaxDepth}; workspace:admin is required to increase it`,
      });
    }
  }
  return {
    ...input.payload.agentConfig,
    ...(model === undefined || model === null ? {} : { model }),
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
