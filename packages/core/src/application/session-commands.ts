import type {
  ComposerDraft,
  DeleteSessionQueueItemRequest,
  EditSessionQueueItemRequest,
  MoveSessionQueueItemRequest,
  SaveComposerDraftRequest,
  AccessGrant,
  SessionAuthorizationOperation,
  SessionAuthorizationPort,
  SessionCommandReceipt,
  SessionControlRequest,
  SessionControlResponse,
  SessionQueueMutationResponse,
  SteerSessionQueueItemRequest,
  WorkspaceInferenceControlRequest,
  WorkspaceInferenceControlResponse,
} from "@opengeni/contracts";
import { reasoningEffortForMetadata } from "@opengeni/contracts";
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
  withWorkspaceRls,
  withWorkspaceSubjectRls,
  type Database,
  type SessionCommandReceiptRow,
} from "@opengeni/db";
import {
  publishDurableSessionEvents,
  publishDurableWorkspaceControlEvent,
  type EventBus,
} from "@opengeni/events";
import type { SessionWorkflowClient } from "../dependencies";
import {
  requireSessionAuthorization,
  type ResolvedSessionAuthorization,
} from "../session-authorization";

export type HumanSessionCommandContext = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  subjectId: string;
};

export type AgentSessionCommandContext = {
  accountId: string;
  workspaceId: string;
  subjectId: string;
  callerSessionId: string;
  callerTurnId: string;
  callerAttemptId: string;
  callerExecutionGeneration: number;
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
    surface: "core",
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
    surface: "core",
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
 * Retry only one operation-keyed Agent command transaction. The caller keeps
 * event publication and Temporal wake delivery after this returns, so a
 * deadlock/serialization retry can never replay an external effect.
 */
async function runAgentCommandPersistenceTransaction<T>(
  deps: { db: Database },
  context: AgentSessionCommandContext,
  input: {
    stage: string;
    eventTypes: string[];
    transaction: (tx: Database) => Promise<T>;
  },
): Promise<T> {
  return await runIdempotentPersistenceTransaction(
    {
      stage: input.stage,
      eventTypes: input.eventTypes,
      maxAttempts: 3,
    },
    async () =>
      await withWorkspaceRls(deps.db, context.workspaceId, async (scoped) =>
        scoped.transaction(async (tx) => await input.transaction(tx as unknown as Database)),
      ),
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
      ...(input.interruptionCount > 0 ? { interruptionRequested: true } : {}),
    });
  } catch (error) {
    console.warn(
      `[session-commands] immediate Agent command wake failed for ${input.workspaceId}/${input.sessionId}; durable outbox will retry`,
      error,
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
  } catch (error) {
    console.warn(
      `[session-commands] immediate control wake dispatch failed for ${wakeCount} committed revisions; durable outbox will retry`,
      error,
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
  const result = await runAgentCommandPersistenceTransaction(deps, context, {
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
  });
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
  input: { targetSessionId: string; instruction: string; idempotencyKey: string },
) {
  await authorizeAgentSessionCommand(deps, context, input.targetSessionId, "session.steer");
  const result = await runAgentCommandPersistenceTransaction(deps, context, {
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
      }),
  });
  await publishAndWakeAgentCommand(deps, {
    accountId: context.accountId,
    workspaceId: context.workspaceId,
    sessionId: input.targetSessionId,
    eventIds: result.eventIds,
    workflowId: result.workflowId,
    wakeRevision: result.wakeRevision,
    shouldSignal: result.shouldSignal,
    interruptionCount: result.interruptionCount,
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
  await authorizeAgentSessionCommand(deps, context, input.targetSessionId, "session.control");
  const result = await withWorkspaceRls(deps.db, context.workspaceId, (scoped) =>
    scoped.transaction((tx) =>
      mutateSessionControlInTransaction(tx as unknown as Database, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        sessionId: input.targetSessionId,
        actor: agentActor(context),
        operationKey: input.idempotencyKey,
        action: input.action,
        reason: input.reason ?? null,
      }),
    ),
  );
  await publishSessionEventIds(deps, context.workspaceId, input.targetSessionId, [
    result.sessionControlEventId,
  ]);
  await publishWorkspaceControlEvent(deps, context.workspaceId, result.workspaceControlEventId);
  await requestControlWakeDispatch(deps, result.wakeCount);
  return result;
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
    resources: row.resources as ComposerDraft["resources"],
    tools: row.tools as ComposerDraft["tools"],
    model: row.model,
    reasoningEffort: row.reasoningEffort as ComposerDraft["reasoningEffort"],
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
  deps: { db: Database; bus: EventBus; sessionAuthorization?: SessionAuthorizationPort | null },
  context: HumanSessionCommandContext,
  turnId: string,
  input: MoveSessionQueueItemRequest,
): Promise<SessionQueueMutationResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.queue.control");
  const result = await withWorkspaceRls(deps.db, context.workspaceId, (scoped) =>
    scoped.transaction((tx) =>
      moveQueuedTurnInTransaction(tx as unknown as Database, {
        ...context,
        turnId,
        beforeTurnId: input.beforeTurnId,
        expectedQueueVersion: input.expectedQueueVersion,
        actor: { type: "human", subjectId: context.subjectId },
        operationKey: input.clientEventId,
      }),
    ),
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
  deps: { db: Database; bus: EventBus; sessionAuthorization?: SessionAuthorizationPort | null },
  context: HumanSessionCommandContext,
  turnId: string,
  input: DeleteSessionQueueItemRequest,
): Promise<SessionQueueMutationResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.queue.control");
  const result = await withWorkspaceRls(deps.db, context.workspaceId, (scoped) =>
    scoped.transaction((tx) =>
      deleteSessionQueueItemInTransaction(tx as unknown as Database, {
        ...context,
        turnId,
        expectedTurnVersion: input.expectedTurnVersion,
        actor: { type: "human", subjectId: context.subjectId },
        operationKey: input.clientEventId,
        reason: input.reason ?? null,
      }),
    ),
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
  deps: { db: Database; bus: EventBus; sessionAuthorization?: SessionAuthorizationPort | null },
  context: HumanSessionCommandContext,
  turnId: string,
  input: EditSessionQueueItemRequest,
): Promise<SessionQueueMutationResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.queue.control");
  const result = await withWorkspaceSubjectRls(
    deps.db,
    context.workspaceId,
    context.subjectId,
    (scoped) =>
      scoped.transaction((tx) =>
        editQueuedTurnInTransaction(tx as unknown as Database, {
          ...context,
          turnId,
          expectedTurnVersion: input.expectedTurnVersion,
          expectedDraftRevision: input.expectedDraftRevision,
          replaceDraft: input.replaceDraft,
          actor: { type: "human", subjectId: context.subjectId },
          operationKey: input.clientEventId,
        }),
      ),
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
  deps: { db: Database; bus: EventBus; sessionAuthorization?: SessionAuthorizationPort | null },
  context: HumanSessionCommandContext,
  turnId: string,
  input: SteerSessionQueueItemRequest,
): Promise<SessionQueueMutationResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.queue.control");
  const result = await withWorkspaceRls(deps.db, context.workspaceId, (scoped) =>
    scoped.transaction((tx) =>
      steerQueuedTurnInTransaction(tx as unknown as Database, {
        ...context,
        turnId,
        expectedTurnVersion: input.expectedTurnVersion,
        controlEtag: input.controlEtag ?? null,
        actor: { type: "human", subjectId: context.subjectId },
        operationKey: input.clientEventId,
      }),
    ),
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

export async function controlHumanSessionWorkstream(
  deps: {
    db: Database;
    bus: EventBus;
    workflowClient: Pick<SessionWorkflowClient, "requestSessionWorkflowWakeDispatch">;
    sessionAuthorization?: SessionAuthorizationPort | null;
  },
  context: HumanSessionCommandContext,
  input: SessionControlRequest,
): Promise<SessionControlResponse> {
  const authorization = await authorizeHumanSessionCommand(deps, context, "session.control");
  const result = await withWorkspaceRls(deps.db, context.workspaceId, (scoped) =>
    scoped.transaction((tx) =>
      mutateSessionControlInTransaction(tx as unknown as Database, {
        accountId: context.accountId,
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        actor: { type: "human", subjectId: context.subjectId },
        operationKey: input.clientEventId,
        action: input.action,
        reason: input.reason ?? null,
        expectedControlEtag: input.expectedControlEtag ?? null,
      }),
    ),
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
  };
  await publishSessionEventIds(deps, context.workspaceId, context.sessionId, [
    result.sessionControlEventId,
  ]);
  await publishWorkspaceControlEvent(deps, context.workspaceId, result.workspaceControlEventId);
  await requestControlWakeDispatch(deps, result.wakeCount);
  return response;
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
    resources: [],
    tools: [],
    model: session.model,
    reasoningEffort: reasoningEffortForMetadata(session.metadata, "medium"),
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
  const row = await withWorkspaceSubjectRls(
    deps.db,
    context.workspaceId,
    context.subjectId,
    (scoped) =>
      scoped.transaction((tx) =>
        saveComposerDraftInTransaction(tx as unknown as Database, {
          ...context,
          ...input,
          subjectId: context.subjectId,
        }),
      ),
  );
  return composerDraft(row)!;
}
