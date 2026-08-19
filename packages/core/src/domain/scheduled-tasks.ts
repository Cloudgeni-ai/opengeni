import { resolveFirstPartyMcpToolPolicy, type Settings } from "@opengeni/config";
import type {
  AccessGrant,
  McpPersonalConnectionDelegation,
  KnowledgeSourceSyncAction,
  Permission,
  ScheduledTask,
  ScheduledTaskAgentConfig,
  Session,
  SessionAuthorizationPort,
  SessionAuthorizationSurface,
  CreateScheduledTaskRequest as CreateScheduledTaskPayload,
  UpdateScheduledTaskRequest as UpdateScheduledTaskPayload,
  XaiProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import {
  DEFAULT_FIRST_PARTY_MCP_PERMISSIONS,
  OPENGENI_SLACK_BOT_SESSION_METADATA_KEY,
} from "@opengeni/contracts";
import {
  createScheduledTask,
  deleteScheduledTask,
  getConnectionMetadata,
  getKnowledgeSourceForSyncAuthority,
  getNestedAgentDepthDeploymentPolicy,
  getRig,
  getScheduledTask,
  getScheduledTaskIncludingDeletedForUpdate,
  getScheduledTaskPersonalConnectionDelegations,
  getScheduledTaskXaiProviderAccountAuthoritySnapshot,
  getSessionTurnXaiProviderAccountAuthoritySnapshot,
  getSession,
  nestedPostgresSqlState,
  requireWorkspace,
  scopedKnowledgeScopeKey,
  updateScheduledTask,
  withWorkspaceSubjectRls,
  resolveXaiProviderAccountAuthoritySnapshotForAcceptance,
  type Database,
  type TemporalScheduleCleanupClaim,
  type UpdateScheduledTaskInput,
} from "@opengeni/db";
import { HTTPException } from "hono/http-exception";
import { isDeepStrictEqual } from "node:util";
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

export function scheduledConnectionSurfaceEligibility(
  settings: Settings,
  target: Pick<Session, "firstPartyMcpTools" | "firstPartyMcpPermissions"> | null,
): { googleDrivePublicationEnabled: boolean; atlassianEnabled: boolean } {
  const tools = target?.firstPartyMcpTools ?? resolveFirstPartyMcpToolPolicy(settings).default;
  const permissions = target?.firstPartyMcpPermissions?.length
    ? target.firstPartyMcpPermissions
    : DEFAULT_FIRST_PARTY_MCP_PERMISSIONS;
  return {
    googleDrivePublicationEnabled:
      tools.includes("editable_artifact_export") &&
      tools.includes("editable_artifact_export_status") &&
      permissions.includes("artifacts:read") &&
      permissions.includes("artifacts:publish"),
    atlassianEnabled:
      tools.some((tool) => tool.startsWith("atlassian_")) &&
      permissions.includes("connections:read"),
  };
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
  // API parsing fills this default, but pack installers and older internal
  // callers can still invoke the shared validator with the pre-action shape.
  const action = input.payload.action ?? ({ kind: "agent_turn" } as const);
  const knowledgeAction = action.kind === "knowledge_source_sync" ? action : null;
  if (knowledgeAction) {
    await validateKnowledgeSourceSyncAction({
      db: input.db,
      grant: input.grant,
      action: knowledgeAction,
    });
  }
  const agentConfig = knowledgeAction
    ? input.payload.agentConfig
    : await validateScheduledTaskAgentConfig({
        ...input,
        workspaceId: input.grant.workspaceId,
      });
  const id = crypto.randomUUID();
  validateScheduledTaskSchedule(input.payload.schedule);
  const target = knowledgeAction
    ? null
    : await validateScheduledTaskTarget({
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
  if (!knowledgeAction && input.payload.variableSetId) {
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
  if (!knowledgeAction && input.payload.rigId) {
    await requireScheduledTaskRig(
      input.db,
      {
        accountId: input.grant.accountId,
        workspaceId: input.grant.workspaceId,
        subjectId: input.grant.subjectId,
      },
      input.payload.rigId,
    );
  }
  const runtimeSettings = knowledgeAction
    ? null
    : await settingsWithEnabledCapabilityMcpServers(
        input.db,
        input.grant.workspaceId,
        input.settings,
        { subjectId: input.grant.subjectId },
      );
  const personalConnectionDelegations =
    knowledgeAction || !runtimeSettings
      ? []
      : await freezePersonalConnectionDelegations({
          db: input.db,
          workspaceId: input.grant.workspaceId,
          settings: runtimeSettings,
          tools: [...agentConfig.tools, { kind: "mcp", id: "opengeni" }],
          source: personalConnectionDelegationSourceForGrant(input.grant),
          authoritySelections: input.payload.connectionAuthorities,
          rejectUnselectedActivatedConnections: true,
          ...scheduledConnectionSurfaceEligibility(runtimeSettings, target),
        });
  const creationInitiator = creationInitiatorForGrant(input.grant);
  const xaiProviderAccountAuthoritySnapshot: XaiProviderAccountAuthoritySnapshotV1 =
    creationInitiator.actor
      ? await getSessionTurnXaiProviderAccountAuthoritySnapshot(
          input.db,
          input.grant.workspaceId,
          creationInitiator.actor.sessionId,
          creationInitiator.actor.turnId,
        )
      : await resolveXaiProviderAccountAuthoritySnapshotForAcceptance(input.db, {
          workspaceId: input.grant.workspaceId,
          subjectId: input.grant.subjectId,
        });
  return await withScheduledTaskAuthorityWriteErrors(() =>
    createScheduledTask(input.db, {
      id,
      accountId: input.grant.accountId,
      workspaceId: input.grant.workspaceId,
      name: trimmedScheduledTaskName(input.payload.name),
      status: input.payload.status,
      schedule: input.payload.schedule,
      temporalScheduleId: scheduledTaskTemporalScheduleId(id),
      runMode: input.payload.runMode,
      overlapPolicy: input.payload.overlapPolicy,
      action,
      agentConfig,
      ...(creationInitiator.initiator ? { createdBy: creationInitiator.initiator } : {}),
      ...(creationInitiator.context ? { createdByContext: creationInitiator.context } : {}),
      createdByActor: creationInitiator.actor ?? null,
      personalConnectionDelegations,
      xaiProviderAccountAuthoritySnapshot,
      targetSessionId: target?.id ?? null,
      variableSetId: input.payload.variableSetId ?? null,
      rigId: input.payload.rigId ?? null,
      metadata: input.payload.metadata,
    }),
  );
}

function nestedPostgresMessage(error: unknown): string | null {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < 64) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      return record.message;
    }
    for (const key of ["cause", "errors", "error", "originalError"]) {
      const nested = record[key];
      if (Array.isArray(nested)) queue.push(...nested);
      else if (nested !== undefined) queue.push(nested);
    }
  }
  return null;
}

/**
 * Scheduled-task authority writes fail closed inside SECURITY DEFINER seams
 * (42501): a non-human writer delegating resources, an authorizer without
 * active workspace membership, or a foreign human retaining another subject's
 * grants. Those are caller-resolvable conflicts, not server faults.
 */
export async function withScheduledTaskAuthorityWriteErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (nestedPostgresSqlState(error) === "42501") {
      const detail = nestedPostgresMessage(error);
      throw new HTTPException(409, {
        message: detail
          ? `scheduled task authority denied: ${detail}`
          : "scheduled task authority denied",
      });
    }
    throw error;
  }
}

/** API/MCP-facing update that maps authority-write denials to 409. */
export async function updateScheduledTaskForApi(
  db: Database,
  workspaceId: string,
  taskId: string,
  update: UpdateScheduledTaskInput,
): Promise<ScheduledTask> {
  return await withScheduledTaskAuthorityWriteErrors(() =>
    updateScheduledTask(db, workspaceId, taskId, update),
  );
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
  if ((session.rigId ?? null) !== (input.rigId ?? null)) {
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

export function scheduledTaskAuthorityUpdateForGrant(
  grant: AccessGrant,
): Pick<
  UpdateScheduledTaskInput,
  | "refreshPersonalResourceAuthority"
  | "authorityUpdatedBy"
  | "authorityUpdatedByContext"
  | "authorityUpdatedByActor"
> {
  const writer = creationInitiatorForGrant(grant);
  return {
    refreshPersonalResourceAuthority: true,
    ...(writer.initiator ? { authorityUpdatedBy: writer.initiator } : {}),
    ...(writer.context ? { authorityUpdatedByContext: writer.context } : {}),
    authorityUpdatedByActor: writer.actor ?? null,
  };
}

// Validate a scheduled task's rig reference: it must name a rig in the
// workspace. A missing/cross-workspace id is a 422 (RLS-invisible == missing).
async function requireScheduledTaskRig(
  db: Database,
  access: { accountId: string; workspaceId: string; subjectId: string },
  rigId: string,
): Promise<void> {
  const rig = await getRig(db, access, rigId);
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
  const existingKnowledge = input.existing.action.kind === "knowledge_source_sync";
  if (input.payload.action && input.payload.action.kind !== input.existing.action.kind) {
    throw new HTTPException(409, {
      message: "scheduled task action kind is immutable; create a new schedule",
    });
  }
  if (existingKnowledge) {
    if (
      input.payload.agentConfig !== undefined ||
      input.payload.runMode !== undefined ||
      input.payload.targetSessionId !== undefined ||
      input.payload.variableSetId !== undefined ||
      input.payload.rigId !== undefined ||
      input.payload.connectionAuthorities !== undefined
    ) {
      throw new HTTPException(422, {
        message: "knowledge source schedules do not accept agent/session configuration",
      });
    }
    if (input.payload.overlapPolicy === "allow_concurrent") {
      throw new HTTPException(422, {
        message: "knowledge source schedules require skip or buffer_one overlap",
      });
    }
    if (input.payload.action?.kind === "knowledge_source_sync") {
      await validateKnowledgeSourceSyncAction({
        db: input.db,
        grant: input.grant,
        action: input.payload.action,
      });
      update.action = input.payload.action;
    }
    if (input.payload.name !== undefined)
      update.name = trimmedScheduledTaskName(input.payload.name);
    if (input.payload.status !== undefined) update.status = input.payload.status;
    if (input.payload.schedule !== undefined) {
      validateScheduledTaskSchedule(input.payload.schedule);
      update.schedule = input.payload.schedule;
    }
    if (input.payload.overlapPolicy !== undefined) {
      update.overlapPolicy = input.payload.overlapPolicy;
    }
    if (input.payload.metadata !== undefined) update.metadata = input.payload.metadata;
    return update;
  }
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
        requirePermission(input.grant, "variable-sets:attach");
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
    if (
      input.existing.runMode === "reusable_session" &&
      input.existing.reusableSessionId !== null &&
      input.payload.rigId !== input.existing.rigId
    ) {
      throw new HTTPException(409, {
        message: "A reusable-session task cannot change rigId after materialization; recreate it",
      });
    }
    if (input.payload.rigId !== null) {
      await requireScheduledTaskRig(
        input.db,
        {
          accountId: input.existing.accountId,
          workspaceId: input.existing.workspaceId,
          subjectId: input.grant.subjectId,
        },
        input.payload.rigId,
      );
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
  }
  const nextAgentConfig = update.agentConfig ?? input.existing.agentConfig;
  const authorityTargetChanged =
    nextRunMode !== input.existing.runMode ||
    nextTargetSessionId !== input.existing.targetSessionId ||
    (input.payload.variableSetId !== undefined &&
      input.payload.variableSetId !== input.existing.variableSetId) ||
    (input.payload.rigId !== undefined && input.payload.rigId !== input.existing.rigId);
  const materialExecutionChange =
    authorityTargetChanged ||
    input.payload.connectionAuthorities !== undefined ||
    !isDeepStrictEqual(nextAgentConfig, input.existing.agentConfig) ||
    (input.payload.action !== undefined &&
      !isDeepStrictEqual(input.payload.action, input.existing.action)) ||
    (input.payload.schedule !== undefined &&
      !isDeepStrictEqual(input.payload.schedule, input.existing.schedule)) ||
    (input.payload.overlapPolicy !== undefined &&
      input.payload.overlapPolicy !== input.existing.overlapPolicy) ||
    (input.payload.metadata !== undefined &&
      !isDeepStrictEqual(input.payload.metadata, input.existing.metadata)) ||
    (input.existing.status === "paused" && input.payload.status === "active");
  const existingXaiAuthority = await getScheduledTaskXaiProviderAccountAuthoritySnapshot(
    input.db,
    input.existing.workspaceId,
    input.existing.id,
  );
  if (
    existingXaiAuthority.scope === "user" &&
    materialExecutionChange &&
    (input.existing.createdBy.kind !== "subject" ||
      input.existing.createdBy.subjectId !== input.grant.subjectId)
  ) {
    throw new HTTPException(409, {
      message: "changing a user-scoped xAI scheduled task requires the same causal human",
    });
  }
  const existingDelegations = await getScheduledTaskPersonalConnectionDelegations(
    input.db,
    input.existing.workspaceId,
    input.existing.id,
  );
  if (input.payload.connectionAuthorities === undefined) {
    if (
      existingDelegations.length > 0 &&
      !isDeepStrictEqual(nextAgentConfig.tools, input.existing.agentConfig.tools)
    ) {
      throw new HTTPException(409, {
        message:
          "changing tools on a connection-authorized task requires explicit connectionAuthorities",
      });
    }
    if (existingDelegations.length > 0) {
      if (
        materialExecutionChange &&
        existingDelegations.some(
          (delegation) => delegation.ownerSubjectId !== input.grant.subjectId,
        )
      ) {
        throw new HTTPException(409, {
          message:
            "preserving connection authority requires the same causal human; provide a new explicit selection",
        });
      }
      if (authorityTargetChanged) {
        update.cloneConnectionAuthorityFromRevision = input.existing.authorityRevision;
      } else {
        update.clonePersonalResourceAuthorityFromRevision = input.existing.authorityRevision;
      }
    }
  } else if (input.payload.connectionAuthorities.length === 0) {
    update.personalConnectionDelegations = [];
  } else {
    const runtimeSettings = await settingsWithEnabledCapabilityMcpServers(
      input.db,
      input.existing.workspaceId,
      input.settings,
      { subjectId: input.grant.subjectId },
    );
    const nextTarget = await validateScheduledTaskTarget({
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
      agentConfig: nextAgentConfig,
    });
    update.personalConnectionDelegations = await freezePersonalConnectionDelegations({
      db: input.db,
      workspaceId: input.existing.workspaceId,
      settings: runtimeSettings,
      tools: [...nextAgentConfig.tools, { kind: "mcp", id: "opengeni" }],
      source: personalConnectionDelegationSourceForGrant(input.grant),
      authoritySelections: input.payload.connectionAuthorities,
      rejectUnselectedActivatedConnections: true,
      ...scheduledConnectionSurfaceEligibility(runtimeSettings, nextTarget),
    });
  }
  if (
    !materialExecutionChange &&
    input.payload.connectionAuthorities === undefined &&
    update.clonePersonalResourceAuthorityFromRevision === undefined
  ) {
    // Administrative lifecycle/name edits preserve the exact revision-bound
    // causal human. They must not silently re-authorize retained Variable Set,
    // Rig, Connection, or xAI authority under the manager performing the edit.
    update.clonePersonalResourceAuthorityFromRevision = input.existing.authorityRevision;
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
    nextRunMode === "existing_session" ||
    (input.existing.runMode === "reusable_session" && nextRunMode !== "reusable_session")
  ) {
    update.targetSessionId = nextTargetSessionId;
  }
  Object.assign(update, scheduledTaskAuthorityUpdateForGrant(input.grant));
  if (update.clonePersonalResourceAuthorityFromRevision !== undefined) {
    update.refreshPersonalResourceAuthority = false;
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
    action: task.action,
    agentConfig: task.agentConfig,
    personalConnectionDelegations: previous.personalConnectionDelegations,
    ...(task.runMode === "existing_session"
      ? { targetSessionId: task.targetSessionId }
      : { reusableSessionId: task.reusableSessionId }),
    variableSetId: task.variableSetId,
    rigId: task.rigId,
    metadata: task.metadata,
    clonePersonalResourceAuthorityFromRevision: task.authorityRevision,
  });
}

async function validateKnowledgeSourceSyncAction(input: {
  db: Database;
  grant: AccessGrant;
  action: KnowledgeSourceSyncAction;
}): Promise<void> {
  if (input.action.initiatingSubjectId !== input.grant.subjectId) {
    throw new HTTPException(403, {
      message: "knowledge source sync must preserve the exact initiating subject",
    });
  }
  if (input.action.connection.ownerSubjectId !== input.grant.subjectId) {
    throw new HTTPException(403, {
      message: "knowledge source connection must belong to the initiating subject",
    });
  }
  const resolved = await getKnowledgeSourceForSyncAuthority(input.db, {
    accountId: input.grant.accountId,
    workspaceId: input.grant.workspaceId,
    sourceId: input.action.sourceId,
    initiatingSubjectId: input.grant.subjectId,
  });
  if (!resolved || resolved.source.lifecycleState !== "active") {
    throw new HTTPException(404, { message: "knowledge source not found" });
  }
  if (
    resolved.source.syncGeneration !== input.action.sourceGeneration ||
    resolved.source.lifecycleGeneration !== input.action.sourceLifecycleGeneration ||
    scopedKnowledgeScopeKey(resolved.source.scope) !==
      scopedKnowledgeScopeKey(input.action.destination)
  ) {
    throw new HTTPException(409, {
      message: "knowledge source authority or generation changed",
    });
  }
  const connection = await getConnectionMetadata(
    input.db,
    input.grant.workspaceId,
    input.action.connection.connectionId,
    input.grant.subjectId,
  );
  if (
    !connection ||
    connection.accountId !== input.grant.accountId ||
    connection.workspaceId !== input.grant.workspaceId ||
    connection.subjectId !== input.action.connection.ownerSubjectId ||
    connection.version !== input.action.connection.connectionVersion ||
    connection.providerDomain.toLowerCase() !==
      input.action.connection.providerDomain.toLowerCase() ||
    connection.kind !== input.action.connection.kind ||
    connection.status !== "active"
  ) {
    throw new HTTPException(409, {
      message: "knowledge source connection authority changed or requires reconnect",
    });
  }
}

export class ScheduledTaskSyncError extends Error {
  readonly persistenceRestored: boolean;

  constructor(cause: unknown, persistenceRestored: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ScheduledTaskSyncError";
    this.persistenceRestored = persistenceRestored;
  }
}

/**
 * One deletion lifecycle shared by HTTP and first-party MCP adapters.
 * Connector authorization is proven before the one-way tombstone. The same
 * transaction detaches reclaimable task resources and persists both external
 * cleanup obligations; best-effort processing is only an acceleration of that
 * durable receipt.
 */
export async function deleteScheduledTaskLifecycle(input: {
  db: Database;
  workspaceId: string;
  taskId: string;
  subjectId: string;
  preflightConnectorAuthorization: (task: ScheduledTask) => Promise<void>;
  cleanupConnectorAuthorization: (db: Database, task: ScheduledTask) => Promise<void>;
  processCleanupClaims?: (claims: readonly TemporalScheduleCleanupClaim[]) => Promise<void>;
}): Promise<{
  task: ScheduledTask;
  changed: boolean;
  cleanup: TemporalScheduleCleanupClaim | null;
}> {
  const result = await withWorkspaceSubjectRls(
    input.db,
    input.workspaceId,
    input.subjectId,
    async (tx) => {
      const task = await getScheduledTaskIncludingDeletedForUpdate(
        tx,
        input.workspaceId,
        input.taskId,
      );
      if (!task) throw new HTTPException(404, { message: "Scheduled task not found" });
      const wasLive = task.deletedAt === null;
      if (
        task.action.kind === "knowledge_source_sync" &&
        (task.action.initiatingSubjectId !== input.subjectId ||
          task.action.connection.ownerSubjectId !== input.subjectId)
      ) {
        throw new HTTPException(403, {
          message: "knowledge source schedule requires the exact initiating subject",
        });
      }
      if (wasLive && task.action.kind === "knowledge_source_sync") {
        await input.preflightConnectorAuthorization(task);
      }
      const deletion =
        task.action.kind === "knowledge_source_sync"
          ? await (async () => {
              await input.cleanupConnectorAuthorization(tx, task);
              return await deleteScheduledTask(tx, input.workspaceId, task.id, {
                connectorCleanupSubjectId: input.subjectId,
                connectorCleanupCompleted: true,
                expectedAuthorityRevision: task.authorityRevision,
                expectedExecutionDigest: task.executionDigest,
              });
            })()
          : await deleteScheduledTask(tx, input.workspaceId, task.id);
      return { task, deletion };
    },
  );
  const { task, deletion } = result;
  const { cleanup, changed } = deletion;
  if (cleanup && input.processCleanupClaims) {
    await input.processCleanupClaims([cleanup]);
  }
  return { task, changed, cleanup };
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
      // Creation rollback removes only the failed schedule. Connector desired
      // state remains authoritative so a later connector save can rematerialize
      // it; this is intentionally not the user-requested deletion lifecycle.
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
    { subjectId: input.grant.subjectId },
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
  await validateFileResources(
    input.db,
    input.grant.accountId,
    input.workspaceId,
    input.grant.subjectId,
    resources,
  );
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
  const validated = {
    ...input.payload.agentConfig,
    ...(model === undefined || model === null ? {} : { model }),
    prompt,
    resources,
    tools,
  };
  validateIncidentTelemetryPreflightSelection(input.settings, validated);
  return validated;
}

/**
 * Static incident-telemetry admission validates only already-selected task
 * authority. It never discovers a resource, reads a variable value, probes a
 * provider, or treats ambient worker credentials as responder capability.
 * Mutable rig/variable-set metadata is revalidated again at dispatch.
 */
export function validateIncidentTelemetryPreflightSelection(
  settings: Pick<Settings, "allowedFirstPartyMcpTools" | "defaultFirstPartyMcpTools">,
  agentConfig: ScheduledTaskAgentConfig,
): void {
  const executionClass = agentConfig.executionClass;
  const preflight = agentConfig.incidentTelemetryPreflight;
  if (executionClass === undefined && preflight === undefined) return;
  if (executionClass !== "incident_telemetry" || !preflight) {
    throw new HTTPException(422, {
      message:
        "executionClass=incident_telemetry and incidentTelemetryPreflight must be configured together",
    });
  }

  for (const required of preflight.requiredResources) {
    if (!agentConfig.resources.some((selected) => isDeepStrictEqual(selected, required))) {
      throw new HTTPException(422, {
        message: "incidentTelemetryPreflight.requiredResources must be exact selected resources",
      });
    }
  }

  const selectedMcpServerIds = new Set(agentConfig.tools.map((tool) => tool.id));
  // Scheduled dispatch always attaches the first-party OpenGeni MCP server.
  selectedMcpServerIds.add("opengeni");
  if (preflight.requiredMcpServerIds.some((id) => !selectedMcpServerIds.has(id))) {
    throw new HTTPException(422, {
      message: "incidentTelemetryPreflight.requiredMcpServerIds must be exact selected MCP servers",
    });
  }

  const selectedFirstPartyTools = new Set(resolveFirstPartyMcpToolPolicy(settings).default);
  if (preflight.requiredFirstPartyMcpTools.some((tool) => !selectedFirstPartyTools.has(tool))) {
    throw new HTTPException(422, {
      message:
        "incidentTelemetryPreflight.requiredFirstPartyMcpTools must be present in the selected first-party tool policy",
    });
  }

  const selectedFirstPartyPermissions = new Set<Permission>(DEFAULT_FIRST_PARTY_MCP_PERMISSIONS);
  if (
    (preflight.requiredFirstPartyMcpPermissions ?? []).some(
      (permission) => !selectedFirstPartyPermissions.has(permission),
    )
  ) {
    throw new HTTPException(422, {
      message:
        "incidentTelemetryPreflight.requiredFirstPartyMcpPermissions must be present in the scheduled responder permission policy",
    });
  }

  const route = preflight.dataSource.route;
  if (route.kind === "mcp" && !selectedMcpServerIds.has(route.serverId)) {
    throw new HTTPException(422, {
      message: "incidentTelemetryPreflight.dataSource.route must use a selected MCP server",
    });
  }
  if (route.kind === "first_party" && !selectedFirstPartyTools.has(route.tool)) {
    throw new HTTPException(422, {
      message: "incidentTelemetryPreflight.dataSource.route must use a selected first-party tool",
    });
  }
  if (route.kind === "variable_set") {
    const declaredSets = new Set(preflight.requiredVariableSetNames);
    const declaredVariables = new Set(preflight.requiredVariableNames);
    if (
      !declaredSets.has(route.variableSetName) ||
      route.variableNames.some((name) => !declaredVariables.has(name))
    ) {
      throw new HTTPException(422, {
        message:
          "incidentTelemetryPreflight.dataSource.route variable metadata must be declared as required",
      });
    }
  }
  if (route.kind === "rig_credential_hook") {
    if (!preflight.requiredRig?.credentialHookIds.includes(route.credentialHookId)) {
      throw new HTTPException(422, {
        message:
          "incidentTelemetryPreflight.dataSource.route rig hook must be declared as required",
      });
    }
  }
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
