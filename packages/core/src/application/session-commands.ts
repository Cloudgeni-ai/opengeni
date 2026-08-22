import type {
  ComposerDraft,
  DeleteSessionQueueItemRequest,
  EditSessionQueueItemRequest,
  MoveSessionQueueItemRequest,
  SaveComposerDraftRequest,
  AccessGrant,
  SessionAuthorizationOperation,
  SessionAuthorizationPort,
  SessionAuthorizationSurface,
  SessionCommandReceipt,
  SessionControlRequest,
  SessionControlResponse,
  SessionQueueMutationResponse,
  SteerSessionQueueItemRequest,
  WorkspaceInferenceControlRequest,
  WorkspaceInferenceControlResponse,
} from "@opengeni/contracts";
import { DraftTimelineAnnotations } from "@opengeni/contracts";
import {
  deleteSessionQueueItemInTransaction,
  editQueuedTurnInTransaction,
  getComposerDraftInTransaction,
  getSession,
  getSessionEvent,
  getWorkspaceControlEvent,
  getSessionQueueSnapshot,
  moveQueuedTurnInTransaction,
  mutateSessionControlInTransaction,
  mutateWorkspaceControlInTransaction,
  projectEffectiveControlForRelatedAccess,
  runIdempotentPersistenceTransaction,
  saveComposerDraftInTransaction,
  sendAgentMessageInTransaction,
  serializeEffectiveSessionControl,
  steerAgentSessionInTransaction,
  steerQueuedTurnInTransaction,
  WORKSPACE_CONTROL_REQUEST_LOCK_TIMEOUT_MS,
  withWorkspaceRls,
  withWorkspaceSessionActivityRls,
  withWorkspaceSubjectRls,
  withWorkspaceSubjectSessionActivityRls,
  type Database,
  type SessionActivityDatabase,
  type SessionCommandReceiptRow,
} from "@opengeni/db";
import {
  publishDurableSessionEvents,
  publishDurableWorkspaceControlEvent,
  type EventBus,
} from "@opengeni/events";
import type { SessionWorkflowClient } from "../dependencies";
import { normalizeResources } from "../domain/resources";
import { validateDraftTimelineAnnotations } from "../domain/timeline-annotations";
import {
  requireSessionAuthorization,
  type ResolvedSessionAuthorization,
} from "../session-authorization";

export type HumanSessionCommandContext = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  subjectId: string;
  /** See AgentSessionCommandContext.authorizationSurface. */
  authorizationSurface?: SessionAuthorizationSurface;
};

export type AgentSessionCommandContext = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  callerSessionId: string;
  callerTurnId: string;
  callerAttemptId: string;
  callerExecutionGeneration: number;
  /**
   * The trusted adapter surface that owns this command's one authorization
   * decision. Direct core callers omit it and retain the canonical `core`
   * surface; adapters that delegate the complete command set it explicitly so
   * they do not authorize once at the edge and then repeat the host call here.
   */
  authorizationSurface?: SessionAuthorizationSurface;
};

type SessionAuthorizationCommandDeps = {
  db: Database;
  sessionAuthorization?: SessionAuthorizationPort | null;
};

function humanAccessGrant(context: HumanSessionCommandContext): AccessGrant {
  return {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    subjectId: context.subjectId,
    permissions: [],
  };
}

function agentAccessGrant(context: AgentSessionCommandContext): AccessGrant {
  return {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    subjectId: context.subjectId,
    permissions: [],
    metadata: {
      sessionId: context.callerSessionId,
      turnId: context.callerTurnId,
      attemptId: context.callerAttemptId,
      executionGeneration: context.callerExecutionGeneration,
    },
  };
}

async function authorizeHumanSessionCommand(
  deps: SessionAuthorizationCommandDeps,
  context: HumanSessionCommandContext,
  operation: SessionAuthorizationOperation,
): Promise<ResolvedSessionAuthorization | null> {
  return await requireSessionAuthorization(deps, humanAccessGrant(context), {
    sessionId: context.sessionId,
    operation,
    surface: context.authorizationSurface ?? "core",
  });
}

async function authorizeAgentSessionCommand(
  deps: SessionAuthorizationCommandDeps,
  context: AgentSessionCommandContext,
  targetSessionId: string,
  operation: SessionAuthorizationOperation,
): Promise<ResolvedSessionAuthorization | null> {
  return await requireSessionAuthorization(deps, agentAccessGrant(context), {
    sessionId: targetSessionId,
    operation,
    surface: context.authorizationSurface ?? "core",
  });
}

function agentActor(context: AgentSessionCommandContext) {
  return {
    type: "agent_attempt" as const,
    sessionId: context.callerSessionId,
    turnId: context.callerTurnId,
    attemptId: context.callerAttemptId,
    executionGeneration: context.callerExecutionGeneration,
  };
}

/**
 * Retry only one operation-keyed session command transaction. Callers keep
 * event publication and Temporal wake delivery after this returns, so a
 * deadlock/serialization retry can never replay an external effect. Human
 * draft ownership is applied inside every retry attempt when required.
 */
async function runSessionCommandPersistenceTransaction<T>(
  deps: { db: Database },
  scope: { workspaceId: string; subjectId?: string },
  input: {
    stage: string;
    eventTypes: string[];
    transaction: (tx: SessionActivityDatabase) => Promise<T>;
  },
): Promise<T> {
  return await runIdempotentPersistenceTransaction(
    {
      stage: input.stage,
      eventTypes: input.eventTypes,
      maxAttempts: 3,
    },
    async () => {
      const run = async (scoped: SessionActivityDatabase) => await input.transaction(scoped);
      return scope.subjectId === undefined
        ? await withWorkspaceSessionActivityRls(deps.db, scope.workspaceId, run)
        : await withWorkspaceSubjectSessionActivityRls(
            deps.db,
            scope.workspaceId,
            scope.subjectId,
            run,
          );
    },
  );
}

async function publishAndWakeAgentCommand(
  deps: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    eventIds: string[];
    workflowId: string;
    wakeRevision: number | null;
    shouldSignal: boolean;
    interruptionCount: number;
    controlRequested?: boolean;
  },
): Promise<void> {
  await publishSessionEventIds(deps, input.workspaceId, input.sessionId, input.eventIds);
  if (!input.shouldSignal || input.wakeRevision === null) return;
  try {
    await deps.workflowClient.wakeSessionWorkflow({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      workflowId: input.workflowId,
      wakeRevision: input.wakeRevision,
      ...(input.controlRequested || input.interruptionCount > 0
        ? { interruptionRequested: true }
        : {}),
    });
  } catch {
    console.warn(
      "[session-commands] immediate Agent command wake failed; durable outbox will retry",
      {
        errorClass: "WorkflowWakeOperationError",
        errorCode: "agent_command_wake_failed",
        origin: "core",
      },
    );
  }
}

/**
 * Nudge the one bounded dispatcher after a set-based control transaction. The
 * API never materializes descendant session ids; Postgres remains the complete
 * wake ledger and the 10-second Schedule repairs a lost immediate trigger.
 */
async function requestControlWakeDispatch(
  deps: {
    workflowClient: Pick<SessionWorkflowClient, "requestSessionWorkflowWakeDispatch">;
  },
  wakeCount: number,
): Promise<void> {
  if (wakeCount === 0) return;
  try {
    await deps.workflowClient.requestSessionWorkflowWakeDispatch();
  } catch {
    console.warn(
      "[session-commands] immediate control wake dispatch failed; durable outbox will retry",
      {
        errorClass: "WorkflowWakeOperationError",
        errorCode: "control_wake_dispatch_failed",
        origin: "core",
        wakeCount,
      },
    );
  }
}

async function publishSessionEventIds(
  deps: { db: Database; bus: EventBus },
  workspaceId: string,
  sessionId: string,
  eventIds: string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  const events = await Promise.all(
    eventIds.map((eventId) => getSessionEvent(deps.db, workspaceId, eventId)),
  );
  await publishDurableSessionEvents(
    deps.bus,
    workspaceId,
    sessionId,
    events.filter((event): event is NonNullable<typeof event> => event !== null),
  );
}

async function publishWorkspaceControlEvent(
  deps: { db: Database; bus: EventBus },
  workspaceId: string,
  eventId: string | null,
): Promise<void> {
  if (!eventId) return;
  const event = await getWorkspaceControlEvent(deps.db, workspaceId, eventId);
  if (!event) {
    throw new Error(`Committed workspace control event disappeared: ${eventId}`);
  }
  await publishDurableWorkspaceControlEvent(deps.bus, workspaceId, event);
}

export async function sendAgentSessionMessage(
  deps: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: AgentSessionCommandContext,
  input: { targetSessionId: string; text: string; idempotencyKey: string },
) {
  await authorizeAgentSessionCommand(deps, context, input.targetSessionId, "session.append");
  const result = await runSessionCommandPersistenceTransaction(
    deps,
    { workspaceId: context.workspaceId },
    {
      stage: "session_commands.agent_message",
      eventTypes: ["system.update.pending"],
      transaction: async (tx) =>
        await sendAgentMessageInTransaction(tx, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          targetSessionId: input.targetSessionId,
          actor: agentActor(context),
          operationKey: input.idempotencyKey,
          text: input.text,
        }),
    },
  );
  await publishAndWakeAgentCommand(deps, {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    sessionId: input.targetSessionId,
    eventIds: result.eventIds,
    workflowId: result.workflowId,
    wakeRevision: result.wakeRevision,
    shouldSignal: result.shouldSignal,
    interruptionCount: 0,
  });
  await publishWorkspaceControlEvent(deps, context.workspaceId, result.workspaceControlEventId);
  return result;
}

export async function steerAgentSession(
  deps: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "wakeSessionWorkflow">;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: AgentSessionCommandContext,
  input: {
    targetSessionId: string;
    instruction: string;
    idempotencyKey: string;
  },
) {
  await authorizeAgentSessionCommand(deps, context, input.targetSessionId, "session.steer");
  const result = await runSessionCommandPersistenceTransaction(
    deps,
    { workspaceId: context.workspaceId },
    {
      stage: "session_commands.agent_steer",
      eventTypes: ["session.control.steer_requested", "system.update.pending", "turn.superseded"],
      transaction: async (tx) =>
        await steerAgentSessionInTransaction(tx, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          targetSessionId: input.targetSessionId,
          actor: agentActor(context),
          operationKey: input.idempotencyKey,
          instruction: input.instruction,
          controlLockTimeoutMs: WORKSPACE_CONTROL_REQUEST_LOCK_TIMEOUT_MS,
        }),
    },
  );
  await publishAndWakeAgentCommand(deps, {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    sessionId: input.targetSessionId,
    eventIds: result.eventIds,
    workflowId: result.workflowId,
    wakeRevision: result.wakeRevision,
    shouldSignal: result.shouldSignal,
    interruptionCount: result.interruptionCount,
    controlRequested: true,
  });
  await publishWorkspaceControlEvent(deps, context.workspaceId, result.workspaceControlEventId);
  return result;
}

export async function controlAgentSessionWorkstream(
  deps: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "requestSessionWorkflowWakeDispatch">;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: AgentSessionCommandContext,
  input: {
    targetSessionId: string;
    action: "pause" | "resume";
    idempotencyKey: string;
    reason?: string | null;
  },
) {
  const authorization = await authorizeAgentSessionCommand(
    deps,
    context,
    input.targetSessionId,
    "session.control",
  );
  const result = await runSessionCommandPersistenceTransaction(
    deps,
    { workspaceId: context.workspaceId },
    {
      stage: "session_commands.agent_control",
      eventTypes: [input.action === "pause" ? "session.control.paused" : "session.control.resumed"],
      transaction: async (tx) =>
        await mutateSessionControlInTransaction(tx, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          sessionId: input.targetSessionId,
          actor: agentActor(context),
          operationKey: input.idempotencyKey,
          action: input.action,
          reason: input.reason ?? null,
          controlLockTimeoutMs: WORKSPACE_CONTROL_REQUEST_LOCK_TIMEOUT_MS,
        }),
    },
  );
  await publishSessionEventIds(deps, context.workspaceId, input.targetSessionId, [
    result.sessionControlEventId,
  ]);
  await publishWorkspaceControlEvent(deps, context.workspaceId, result.workspaceControlEventId);
  await requestControlWakeDispatch(deps, result.wakeCount);
  return { ...result, authorization };
}

function receipt(row: SessionCommandReceiptRow): SessionCommandReceipt {
  return {
    id: row.id,
    action: row.action,
    operationKey: row.operationKey,
    targetSessionId: row.targetSessionId,
    targetTurnId: row.targetTurnId,
    appliedControlRevision: row.appliedControlRevision,
    appliedQueueVersion: row.appliedQueueVersion,
    appliedTurnVersion: row.appliedTurnVersion,
    appliedDraftRevision: row.appliedDraftRevision,
    createdAt: row.createdAt.toISOString(),
  };
}

function composerDraft(
  row: Awaited<ReturnType<typeof getComposerDraftInTransaction>>,
): ComposerDraft | null {
  if (!row) return null;
  return {
    revision: row.revision,
    text: row.text,
    annotations: DraftTimelineAnnotations.parse(row.annotations),
    resources: row.resources as ComposerDraft["resources"],
    model: row.model,
    reasoningEffort: row.reasoningEffort as ComposerDraft["reasoningEffort"],
    latencyMode: row.latencyMode as ComposerDraft["latencyMode"],
    sourceTurnId: row.sourceTurnId,
    sourceTurnVersion: row.sourceTurnVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function authoritativeQueue(
  db: Database,
  workspaceId: string,
  sessionId: string,
  relatedSessionAccess: "target" | "root",
) {
  const snapshot = await getSessionQueueSnapshot(db, workspaceId, sessionId);
  if (!snapshot) throw new Error(`Session not found: ${sessionId}`);
  return {
    ...snapshot,
    effectiveControl: projectEffectiveControlForRelatedAccess(
      snapshot.effectiveControl,
      sessionId,
      relatedSessionAccess,
    ),
  };
}

export async function moveHumanQueuePrompt(
  deps: {
    db: Database;
    bus: EventBus;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: HumanSessionCommandContext,
  turnId: string,
  input: MoveSessionQueueItemRequest,
): Promise<SessionQueueMutationResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.queue.control");
  const result = await runSessionCommandPersistenceTransaction(
    deps,
    { workspaceId: context.workspaceId },
    {
      stage: "session_commands.human_queue_move",
      eventTypes: ["session.queue.changed"],
      transaction: async (tx) =>
        await moveQueuedTurnInTransaction(tx, {
          ...context,
          turnId,
          beforeTurnId: input.beforeTurnId,
          expectedQueueVersion: input.expectedQueueVersion,
          actor: { type: "human", subjectId: context.subjectId },
          operationKey: input.clientEventId,
        }),
    },
  );
  const response = {
    receipt: receipt(result.receipt),
    snapshot: await authoritativeQueue(
      deps.db,
      context.workspaceId,
      context.sessionId,
      authorization?.relatedSessionAccess ?? "root",
    ),
  };
  await publishSessionEventIds(deps, context.workspaceId, context.sessionId, result.eventIds);
  return response;
}

export async function deleteHumanQueuePrompt(
  deps: {
    db: Database;
    bus: EventBus;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: HumanSessionCommandContext,
  turnId: string,
  input: DeleteSessionQueueItemRequest,
): Promise<SessionQueueMutationResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.queue.control");
  const result = await runSessionCommandPersistenceTransaction(
    deps,
    { workspaceId: context.workspaceId },
    {
      stage: "session_commands.human_queue_delete",
      eventTypes: ["session.queue.changed"],
      transaction: async (tx) =>
        await deleteSessionQueueItemInTransaction(tx, {
          ...context,
          turnId,
          expectedTurnVersion: input.expectedTurnVersion,
          actor: { type: "human", subjectId: context.subjectId },
          operationKey: input.clientEventId,
          reason: input.reason ?? null,
        }),
    },
  );
  const response = {
    receipt: receipt(result.receipt),
    snapshot: await authoritativeQueue(
      deps.db,
      context.workspaceId,
      context.sessionId,
      authorization?.relatedSessionAccess ?? "root",
    ),
  };
  await publishSessionEventIds(deps, context.workspaceId, context.sessionId, result.eventIds);
  return response;
}

export async function editHumanQueuePrompt(
  deps: {
    db: Database;
    bus: EventBus;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: HumanSessionCommandContext,
  turnId: string,
  input: EditSessionQueueItemRequest,
): Promise<SessionQueueMutationResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.queue.control");
  const result = await runSessionCommandPersistenceTransaction(
    deps,
    { workspaceId: context.workspaceId, subjectId: context.subjectId },
    {
      stage: "session_commands.human_queue_edit",
      eventTypes: ["session.queue.changed"],
      transaction: async (tx) =>
        await editQueuedTurnInTransaction(tx, {
          ...context,
          turnId,
          expectedTurnVersion: input.expectedTurnVersion,
          expectedDraftRevision: input.expectedDraftRevision,
          replaceDraft: input.replaceDraft,
          actor: { type: "human", subjectId: context.subjectId },
          operationKey: input.clientEventId,
        }),
    },
  );
  const response = {
    receipt: receipt(result.receipt),
    snapshot: await authoritativeQueue(
      deps.db,
      context.workspaceId,
      context.sessionId,
      authorization?.relatedSessionAccess ?? "root",
    ),
    draft: composerDraft(result.draft)!,
  };
  await publishSessionEventIds(deps, context.workspaceId, context.sessionId, result.eventIds);
  return response;
}

export async function steerHumanQueuePrompt(
  deps: {
    db: Database;
    bus: EventBus;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: HumanSessionCommandContext,
  turnId: string,
  input: SteerSessionQueueItemRequest,
): Promise<SessionQueueMutationResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.queue.control");
  const result = await runSessionCommandPersistenceTransaction(
    deps,
    { workspaceId: context.workspaceId },
    {
      stage: "session_commands.human_queue_steer",
      eventTypes: ["session.control.steer_requested", "session.queue.changed", "turn.superseded"],
      transaction: async (tx) =>
        await steerQueuedTurnInTransaction(tx, {
          ...context,
          turnId,
          expectedTurnVersion: input.expectedTurnVersion,
          controlEtag: input.controlEtag ?? null,
          actor: { type: "human", subjectId: context.subjectId },
          operationKey: input.clientEventId,
          controlLockTimeoutMs: WORKSPACE_CONTROL_REQUEST_LOCK_TIMEOUT_MS,
        }),
    },
  );
  const response = {
    receipt: receipt(result.receipt),
    snapshot: await authoritativeQueue(
      deps.db,
      context.workspaceId,
      context.sessionId,
      authorization?.relatedSessionAccess ?? "root",
    ),
  };
  await publishSessionEventIds(deps, context.workspaceId, context.sessionId, result.eventIds);
  await publishWorkspaceControlEvent(deps, context.workspaceId, result.workspaceControlEventId);
  return response;
}

export async function controlHumanSessionWorkstreamWithOutcome(
  deps: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "requestSessionWorkflowWakeDispatch">;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: HumanSessionCommandContext,
  input: SessionControlRequest,
): Promise<{ response: SessionControlResponse; replay: boolean }> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.control");
  const result = await runSessionCommandPersistenceTransaction(
    deps,
    { workspaceId: context.workspaceId },
    {
      stage: "session_commands.human_control",
      eventTypes: [
        input.action === "resume" ? "session.control.resumed" : "session.control.paused",
      ],
      transaction: async (tx) =>
        await mutateSessionControlInTransaction(tx, {
          accountId: context.accountId,
          workspaceId: context.workspaceId,
          sessionId: context.sessionId,
          actor: { type: "human", subjectId: context.subjectId },
          operationKey: input.clientEventId,
          action: input.action,
          reason: input.reason ?? null,
          expectedControlEtag: input.expectedControlEtag ?? null,
          controlLockTimeoutMs: WORKSPACE_CONTROL_REQUEST_LOCK_TIMEOUT_MS,
        }),
    },
  );
  const response = {
    receipt: receipt(result.receipt),
    effectiveControl: projectEffectiveControlForRelatedAccess(
      serializeEffectiveSessionControl(result.control),
      context.sessionId,
      authorization?.relatedSessionAccess ?? "root",
    ),
    interruptionCount: result.interruptionCount,
    wakeCount: result.wakeCount,
    cancelledSessionCount: result.cancelledSessionCount,
    cancelledTurnCount: result.cancelledTurnCount,
  };
  for (const affected of result.affectedSessionEvents) {
    await publishSessionEventIds(deps, context.workspaceId, affected.sessionId, affected.eventIds);
  }
  await publishWorkspaceControlEvent(deps, context.workspaceId, result.workspaceControlEventId);
  await requestControlWakeDispatch(deps, result.wakeCount);
  return { response, replay: result.replay };
}

/** Backward-compatible response path used by the REST control route. */
export async function controlHumanSessionWorkstream(
  deps: Parameters<typeof controlHumanSessionWorkstreamWithOutcome>[0],
  context: Parameters<typeof controlHumanSessionWorkstreamWithOutcome>[1],
  input: Parameters<typeof controlHumanSessionWorkstreamWithOutcome>[2],
): Promise<SessionControlResponse> {
  return (await controlHumanSessionWorkstreamWithOutcome(deps, context, input)).response;
}

export async function controlHumanWorkspace(
  deps: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "requestSessionWorkflowWakeDispatch">;
  },
  context: Omit<HumanSessionCommandContext, "sessionId">,
  input: WorkspaceInferenceControlRequest,
): Promise<WorkspaceInferenceControlResponse> {
  const result = await withWorkspaceRls(deps.db, context.workspaceId, (scoped) =>
    scoped.transaction((tx) =>
      mutateWorkspaceControlInTransaction(tx as unknown as Database, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        actor: { type: "human", subjectId: context.subjectId },
        operationKey: input.clientEventId,
        action: input.action,
        reason: input.reason ?? null,
        expectedRevision: input.expectedRevision ?? null,
        controlLockTimeoutMs: WORKSPACE_CONTROL_REQUEST_LOCK_TIMEOUT_MS,
      }),
    ),
  );
  const response = {
    receipt: receipt(result.receipt),
    state: result.workspaceState,
    revision: result.revision,
    interruptionCount: result.interruptionCount,
    wakeCount: result.wakeCount,
  };
  await publishWorkspaceControlEvent(deps, context.workspaceId, result.workspaceControlEventId);
  await requestControlWakeDispatch(deps, result.wakeCount);
  return response;
}

export async function getHumanComposerDraft(
  deps: SessionAuthorizationCommandDeps,
  context: HumanSessionCommandContext,
): Promise<ComposerDraft> {
  await authorizeHumanSessionCommand(deps, context, "session.composer.read");
  const row = await withWorkspaceSubjectRls(
    deps.db,
    context.workspaceId,
    context.subjectId,
    (scoped) =>
      getComposerDraftInTransaction(scoped, {
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        subjectId: context.subjectId,
      }),
  );
  const mapped = composerDraft(row);
  if (mapped) return mapped;
  const session = await getSession(deps.db, context.workspaceId, context.sessionId);
  if (!session) throw new Error(`Session not found: ${context.sessionId}`);
  return {
    revision: 0,
    text: "",
    annotations: [],
    resources: [],
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    latencyMode: session.latencyMode,
    sourceTurnId: null,
    sourceTurnVersion: null,
    updatedAt: null,
  };
}

export async function saveHumanComposerDraft(
  deps: SessionAuthorizationCommandDeps,
  context: HumanSessionCommandContext,
  input: SaveComposerDraftRequest,
): Promise<ComposerDraft> {
  await authorizeHumanSessionCommand(deps, context, "session.composer.write");
  const annotations = await validateDraftTimelineAnnotations(
    deps.db,
    context.workspaceId,
    context.sessionId,
    input.annotations ?? [],
  );
  const row = await withWorkspaceSubjectRls(
    deps.db,
    context.workspaceId,
    context.subjectId,
    (scoped) =>
      scoped.transaction((tx) =>
        saveComposerDraftInTransaction(tx as unknown as Database, {
          ...context,
          ...input,
          annotations,
          resources: normalizeResources(input.resources),
          subjectId: context.subjectId,
        }),
      ),
  );
  return composerDraft(row)!;
}
