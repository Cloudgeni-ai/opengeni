import {
  WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1,
  XaiProviderAccountAuthoritySnapshotV1,
  DraftTimelineAnnotations,
  McpPersonalConnectionDelegations,
  PersonalResourceAttachmentSummary,
  TimelineAnnotations,
  metadataWithTurnExecutionPolicyV1,
  mergeResourceRefs,
  renderTimelineAnnotationsForModel,
  ResourceRef,
  resourceMountPath,
  stableJson,
  turnExecutionPolicyAuditMetadata,
  type McpPersonalConnectionDelegation,
  type DraftTimelineAnnotation,
  type LatencyMode,
  type ReasoningEffort,
  type SandboxBackend,
  type SandboxOs,
  type SessionEvent,
  type SessionEventType,
  type SessionTurn,
  type SessionTurnSource,
  type SessionTurnStatus,
  type ToolRef,
  type TurnExecutionPolicyV1,
  type TimelineAnnotation,
  type PersonalResourceAttachmentIntent,
} from "@opengeni/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { setSubjectRlsContext, type Database, type SessionActivityDatabase } from "./database";
import {
  fromPostgresLosslessJson,
  fromPostgresLosslessText,
  withLosslessContentWriteVersion,
} from "./lossless-json";
import { closePendingSessionToolCallsInTransaction } from "./session-tool-call-settlement";
import { cancelTurnInteractionInterventionsInTransaction } from "./browser-auth";
import {
  assertAgentCommandAuthorityInTransaction,
  autoResumeSessionBranchInTransaction,
  canonicalSessionCommandHash,
  evaluateSessionControl,
  lockSessionEventWriteRows,
  lockWorkspaceInferenceControl,
  lockWorkspaceInferenceControlForAdmission,
  registerInternalUpdateWakeInTransaction,
  reserveSessionCommandReceipt,
  registerSessionWorkflowWakeInTransaction,
  type SessionCommandActor,
  type SessionCommandReceiptRow,
  SessionControlConflictError,
  SessionControlInvariantError,
  updateSessionCommandReceiptResult,
} from "./session-control";
import { sessionRealtimeIsActiveInTransaction } from "./session-realtime-state";
import { autoResumeGoalPausedByCapInTransaction } from "./session-goal-pacing";
import {
  mirrorSessionRealtimeContextInTransaction,
  renderRealtimeHumanInputContext,
  renderRealtimeHumanInputResponseContext,
} from "./session-realtime-mirror";
import * as schema from "./schema";
import {
  frozenInitiatorForCommandActor,
  initiatorColumns,
  initiatorFromStorage,
  type FrozenTurnInitiator,
} from "./turn-initiator";
import { resolveXaiProviderAccountAuthoritySnapshotForAcceptanceInTransaction } from "./xai-subscription";
import { assertActiveManagedHumanOrganizationMembership } from "./organization-membership-lifecycle";
import { acceptTurnPersonalResourceAttachmentInTransaction } from "./user-resource-authority";

type SessionEventInsertWithPayload = typeof schema.sessionEvents.$inferInsert & {
  payload: unknown;
};

export type QueueCommandConflictCode =
  | "QUEUE_VERSION_CHANGED"
  | "QUEUE_PROMPT_STARTED"
  | "QUEUE_ANCHOR_CHANGED"
  | "PROMPT_CHANGED"
  | "DRAFT_CHANGED"
  | "DRAFT_NOT_EMPTY"
  | "EDIT_SOURCE_CHANGED"
  | "ONCE_ATTACHMENT_IMMUTABLE";

export class QueueCommandConflictError extends Error {
  readonly name = "QueueCommandConflictError";

  constructor(
    readonly code: QueueCommandConflictCode,
    message: string,
    readonly current: {
      queueVersion: number;
      turnVersion?: number;
      draftRevision?: number;
    },
  ) {
    super(message);
  }
}

export type ComposerDraftRow = typeof schema.composerDrafts.$inferSelect;
export type QueuedTurnRow = typeof schema.sessionTurns.$inferSelect;

export type QueueCommandResult = {
  receipt: SessionCommandReceiptRow;
  queueVersion: number;
  items: QueuedTurnRow[];
  eventIds: string[];
  replay: boolean;
};

export type EditQueueCommandResult = QueueCommandResult & {
  draft: ComposerDraftRow;
};

export type SteerQueueCommandResult = QueueCommandResult & {
  interruptionCount: number;
  workspaceControlEventId: string | null;
};

export type SubmitHumanPromptResult = {
  receipt: SessionCommandReceiptRow;
  queueVersion: number;
  accepted: SessionEvent;
  events: SessionEvent[];
  turn: SessionTurn;
  /** Current actor/session composer after an exact draft-bound submission. */
  draft: ComposerDraftRow | null;
  /** Backward-compatible row identities for lower-level callers. */
  acceptedEventId: string;
  eventIds: string[];
  turnId: string;
  wakeRevision: number;
  interruptionCount: number;
  workspaceControlEventId: string | null;
  replay: boolean;
};

function mapSubmittedPromptEvent(row: typeof schema.sessionEvents.$inferSelect): SessionEvent {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    sequence: row.sequence,
    type: row.type as SessionEventType,
    payload: fromPostgresLosslessJson(row.payload, row.payloadCodecVersion),
    occurredAt: row.occurredAt.toISOString(),
    clientEventId: row.clientEventId,
    turnId: row.turnId,
    turnGeneration: row.turnGeneration,
    turnAttemptId: row.turnAttemptId,
    turnAssociation: row.turnAssociation as SessionEvent["turnAssociation"],
    duplicateOfEventId: row.duplicateOfEventId,
    duplicateReason: row.duplicateReason,
  };
}

function mapSubmittedPromptTurn(row: typeof schema.sessionTurns.$inferSelect): SessionTurn {
  const personalConnections = McpPersonalConnectionDelegations.parse(
    row.personalConnectionDelegations,
  ).map(({ serverId, providerDomain }) => ({ serverId, providerDomain }));
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    triggerEventId: row.triggerEventId,
    temporalWorkflowId: row.temporalWorkflowId,
    status: row.status as SessionTurnStatus,
    source: row.source as SessionTurnSource,
    position: row.position,
    prompt: fromPostgresLosslessText(row.prompt, row.promptCodecVersion),
    annotations: TimelineAnnotations.parse(row.annotations),
    resources: row.resources as ResourceRef[],
    tools: row.tools as ToolRef[],
    toolsProvided: row.toolsProvided,
    model: row.model,
    reasoningEffort: row.reasoningEffort as ReasoningEffort,
    latencyMode: row.latencyMode as LatencyMode,
    sandboxBackend: row.sandboxBackend as SandboxBackend,
    sandboxOs: (row.sandboxOs as SandboxOs | null) ?? null,
    metadata: row.metadata,
    version: row.version,
    executionGeneration: row.executionGeneration,
    activeAttemptId: row.activeAttemptId,
    lineage: row.lineage,
    initiator: initiatorFromStorage(
      row.initiatorKind,
      row.initiatorSubjectId,
      row.initiatorContext ?? {},
    ),
    initiatorContext: row.initiatorContext ?? {},
    personalConnections,
    personalResources: row.personalResourceAttachmentSummary
      ? PersonalResourceAttachmentSummary.parse(row.personalResourceAttachmentSummary)
      : null,
    cancelledBy: row.cancelledBy,
    cancelReason: row.cancelReason,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type AgentInternalUpdateCommandResult = {
  receipt: SessionCommandReceiptRow;
  updateId: string;
  eventIds: string[];
  wakeRevision: number | null;
  shouldSignal: boolean;
  workflowId: string;
  effectiveState: "active" | "paused";
  interruptionCount: number;
  workspaceControlEventId: string | null;
  replay: boolean;
};

async function personalConnectionDelegationsForAgentActor(
  db: Database,
  workspaceId: string,
  actor: Extract<SessionCommandActor, { type: "agent_attempt" }>,
  targetSessionId: string,
): Promise<{
  delegations: McpPersonalConnectionDelegation[];
  connectionAuthoritySubjectId: string | null;
}> {
  const [row] = await db
    .select({
      delegations: schema.sessionTurns.personalConnectionDelegations,
      initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
    })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, actor.sessionId),
        eq(schema.sessionTurns.id, actor.turnId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new SessionControlInvariantError(
      `Agent authority turn not found: ${actor.sessionId}/${actor.turnId}`,
    );
  }
  const parsed = McpPersonalConnectionDelegations.safeParse(row.delegations);
  if (!parsed.success) {
    throw new SessionControlInvariantError(
      `Agent authority turn has malformed personal MCP delegation state: ${actor.sessionId}/${actor.turnId}`,
    );
  }
  // Agent messages and Agent Steer create new accepted work. A once grant is
  // already bound to the caller turn, while a session grant may be projected
  // only into another turn of that exact session. Always grants can cross the
  // direct parent/child boundary subject to the live admission fences.
  const delegations = parsed.data
    .filter((delegation) => {
      const authority = delegation.userDelegation;
      if (!authority) return true;
      if (authority.mode === "once") return false;
      if (authority.mode === "session") return authority.sessionId === targetSessionId;
      return true;
    })
    .map((delegation) => ({ ...delegation }));
  const activated = delegations.filter((delegation) => delegation.userDelegation);
  if (activated.length === 0) {
    return { delegations, connectionAuthoritySubjectId: null };
  }
  const connectionAuthoritySubjectId = row.initiatingHumanSubjectId;
  if (!connectionAuthoritySubjectId) {
    throw new SessionControlInvariantError(
      `Agent authority turn lost its causal human: ${actor.sessionId}/${actor.turnId}`,
    );
  }
  for (const delegation of activated) {
    if (delegation.ownerSubjectId !== connectionAuthoritySubjectId) {
      throw new SessionControlInvariantError(
        `Agent authority turn causal human does not own retained connection authority: ${actor.sessionId}/${actor.turnId}`,
      );
    }
  }
  return { delegations, connectionAuthoritySubjectId };
}

async function xaiAuthorityForAgentActor(
  db: Database,
  workspaceId: string,
  actor: Extract<SessionCommandActor, { type: "agent_attempt" }>,
): Promise<{
  snapshot: ReturnType<typeof XaiProviderAccountAuthoritySnapshotV1.parse>;
  subjectId: string | null;
}> {
  const [row] = await db
    .select({
      snapshot: schema.sessionTurns.xaiProviderAccountAuthoritySnapshot,
      initiatingHumanSubjectId: schema.sessionTurns.initiatingHumanSubjectId,
      initiatorKind: schema.sessionTurns.initiatorKind,
      initiatorSubjectId: schema.sessionTurns.initiatorSubjectId,
    })
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, actor.sessionId),
        eq(schema.sessionTurns.id, actor.turnId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new SessionControlInvariantError(
      `Agent xAI authority turn not found: ${actor.sessionId}/${actor.turnId}`,
    );
  }
  return {
    snapshot: XaiProviderAccountAuthoritySnapshotV1.parse(row.snapshot),
    subjectId:
      row.initiatingHumanSubjectId ??
      (row.initiatorKind === "subject" ? row.initiatorSubjectId : null),
  };
}

async function lockSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<typeof schema.sessions.$inferSelect> {
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    sessionIds: [sessionId],
  });
  const session = locks.sessions[0];
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  return session;
}

type SteerSupersessionResult = {
  interruptionCount: number;
  replacedTurn: typeof schema.sessionTurns.$inferSelect | null;
  liveCurrentTurnId: string | null;
  lastSequence: number;
};

/**
 * One canonical replacement transition shared by human row/new-prompt Steer
 * and Agent Steer. A live owner is interrupted and remains current until exact
 * settlement; an ownerless approval/recovery/capacity turn is superseded now.
 */
export async function supersedeSessionCurrentDirectionInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    activeTurnId: string | null;
    actor: SessionCommandActor;
    operationId: string;
    controlRevision: number;
    lastSequence: number;
  },
): Promise<SteerSupersessionResult> {
  if (!input.activeTurnId) {
    return {
      interruptionCount: 0,
      replacedTurn: null,
      liveCurrentTurnId: null,
      lastSequence: input.lastSequence,
    };
  }
  const [preview] = await db
    .select()
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        eq(schema.sessionTurns.id, input.activeTurnId),
      ),
    )
    .limit(1);
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    turnIds: [input.activeTurnId],
    attemptIds: preview?.activeAttemptId ? [preview.activeAttemptId] : [],
  });
  const current = locks.turns[0];
  if (!current) {
    throw new SessionControlInvariantError(
      `Session ${input.sessionId} points to missing active turn ${input.activeTurnId}`,
    );
  }
  if (!["running", "requires_action", "recovering", "waiting_capacity"].includes(current.status)) {
    throw new SessionControlInvariantError(
      `Active turn ${current.id} cannot be Steered from ${current.status}`,
    );
  }
  if (current.status === "running" && !current.activeAttemptId) {
    throw new SessionControlInvariantError(
      `Running turn ${current.id} has no first-class attempt owner`,
    );
  }
  if (current.activeAttemptId) {
    if (current.status !== "running") {
      throw new SessionControlInvariantError(
        `Live attempt ${current.activeAttemptId} owns non-running turn ${current.id}`,
      );
    }
    const [interruption] = await db
      .insert(schema.sessionAttemptInterruptions)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        operationId: input.operationId,
        attemptId: current.activeAttemptId,
        kind: "steer",
        controlRevision: input.controlRevision,
      })
      .onConflictDoNothing()
      .returning({ id: schema.sessionAttemptInterruptions.id });
    return {
      interruptionCount: interruption ? 1 : 0,
      replacedTurn: current,
      liveCurrentTurnId: current.id,
      lastSequence: input.lastSequence,
    };
  }

  const now = new Date();
  await cancelTurnInteractionInterventionsInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: current.id,
  });
  const closedTools = await closePendingSessionToolCallsInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: current.id,
    reason: "steer",
    sequence: input.lastSequence,
    now,
  });
  const cancelledHumanInputs = await db
    .update(schema.sessionHumanInputRequests)
    .set({
      status: "cancelled",
      response: { outcome: "cancelled" },
      respondedBy:
        input.actor.type === "agent_attempt"
          ? `attempt:${input.actor.attemptId}`
          : input.actor.subjectId,
      respondedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.sessionHumanInputRequests.workspaceId, input.workspaceId),
        eq(schema.sessionHumanInputRequests.sessionId, input.sessionId),
        eq(schema.sessionHumanInputRequests.turnId, current.id),
        eq(schema.sessionHumanInputRequests.status, "pending"),
      ),
    )
    .returning({
      id: schema.sessionHumanInputRequests.id,
      questions: schema.sessionHumanInputRequests.questions,
    });
  let lastSequence = closedTools.sequence;
  if (cancelledHumanInputs.length > 0) {
    const cancelledHumanInputEvents = await db
      .insert(schema.sessionEvents)
      .values(
        withLosslessContentWriteVersion(
          cancelledHumanInputs.map((request) => ({
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            sequence: ++lastSequence,
            type: "user.humanInputResponse",
            turnId: current.id,
            turnGeneration: current.executionGeneration,
            turnAssociation: "current",
            payload: {
              requestId: request.id,
              response: { outcome: "cancelled" },
            },
            occurredAt: now,
          })),
          "payload",
          "payloadCodecVersion",
        ),
      )
      .returning();
    const requestsById = new Map(cancelledHumanInputs.map((request) => [request.id, request]));
    for (const event of cancelledHumanInputEvents) {
      const payload = event.payload as { requestId?: unknown };
      const request =
        typeof payload.requestId === "string" ? requestsById.get(payload.requestId) : null;
      if (!request) continue;
      await mirrorSessionRealtimeContextInTransaction(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sourceKind: "human_input_response",
        sourceId: event.id,
        turnId: current.id,
        channel: null,
        text: renderRealtimeHumanInputResponseContext({
          requestId: request.id,
          questions: request.questions,
          response: { outcome: "cancelled" },
        }),
        payload: {
          requestId: request.id,
          outcome: "cancelled",
          sourceEventId: event.id,
        },
        now,
      });
    }
  }
  await db
    .update(schema.sessionTurns)
    .set({
      status: "superseded",
      cancelledBy:
        input.actor.type === "agent_attempt"
          ? `attempt:${input.actor.attemptId}`
          : input.actor.subjectId,
      cancelReason: "steer",
      version: current.version + 1,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sessionTurns.id, current.id));
  if (current.status === "waiting_capacity") {
    await db
      .update(schema.codexCapacityWaiters)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(schema.codexCapacityWaiters.workspaceId, input.workspaceId),
          eq(schema.codexCapacityWaiters.sessionId, input.sessionId),
          eq(schema.codexCapacityWaiters.blockedTurnId, current.id),
          eq(schema.codexCapacityWaiters.status, "waiting"),
        ),
      );
    await db
      .update(schema.xaiCapacityWaiters)
      .set({ status: "superseded", lastWakeReason: "steer", updatedAt: now })
      .where(
        and(
          eq(schema.xaiCapacityWaiters.workspaceId, input.workspaceId),
          eq(schema.xaiCapacityWaiters.sessionId, input.sessionId),
          eq(schema.xaiCapacityWaiters.blockedTurnId, current.id),
          eq(schema.xaiCapacityWaiters.status, "waiting"),
        ),
      );
  }
  return {
    interruptionCount: 0,
    replacedTurn: current,
    liveCurrentTurnId: null,
    lastSequence,
  };
}

async function loadQueuedTurns(
  db: Database,
  workspaceId: string,
  sessionId: string,
  lock = false,
): Promise<QueuedTurnRow[]> {
  const query = db
    .select()
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, workspaceId),
        eq(schema.sessionTurns.sessionId, sessionId),
        eq(schema.sessionTurns.status, "queued"),
        inArray(schema.sessionTurns.source, ["user", "api"]),
      ),
    )
    .orderBy(
      asc(schema.sessionTurns.position),
      asc(schema.sessionTurns.createdAt),
      asc(schema.sessionTurns.id),
    );
  const rows = await query;
  if (!lock || rows.length === 0) return rows;
  const locks = await lockSessionEventWriteRows(db, {
    workspaceId,
    controlLock: "already_locked",
    workspaceLock: "already_locked",
    turnIds: rows.map((row) => row.id),
  });
  const byId = new Map(locks.turns.map((row) => [row.id, row]));
  return rows.map((row) => byId.get(row.id)).filter((row): row is QueuedTurnRow => Boolean(row));
}

async function normalizeQueuePositions(
  db: SessionActivityDatabase,
  workspaceId: string,
  sessionId: string,
  orderedIds: string[],
): Promise<void> {
  if (orderedIds.length > 0) {
    const orderedValues = sql.join(
      orderedIds.map((id, index) => sql`(${id}::uuid, ${index + 1}::bigint)`),
      sql`, `,
    );
    await db.execute(sql`
      with ordered(id, position) as (values ${orderedValues})
      update ${schema.sessionTurns} turn
      set position = ordered.position, updated_at = now()
      from ordered
      where turn.workspace_id = ${workspaceId}
        and turn.session_id = ${sessionId}
        and turn.id = ordered.id
        and turn.status = 'queued'
    `);
  }
  await db
    .update(schema.sessions)
    .set({
      queueHeadPosition: 0,
      queueTailPosition: orderedIds.length,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)));
}

function draftIsNonEmpty(draft: ComposerDraftRow): boolean {
  return (
    draft.text.length > 0 ||
    DraftTimelineAnnotations.parse(draft.annotations).length > 0 ||
    draft.resources.length > 0 ||
    draft.sourceTurnId !== null
  );
}

function draftAnnotationsFromTurn(value: unknown): DraftTimelineAnnotation[] {
  return TimelineAnnotations.parse(value).map(({ ordinal: _ordinal, ...annotation }) => ({
    ...annotation,
    source: { ...annotation.source },
  }));
}

function withCanonicalResourceMountPaths(resources: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const canonical: unknown[] = [];
  for (const value of resources) {
    const parsed = ResourceRef.safeParse(value);
    if (!parsed.success) {
      canonical.push(value);
      continue;
    }
    const normalized = {
      ...(value as Record<string, unknown>),
      mountPath: resourceMountPath(parsed.data),
    };
    const key = stableJson(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    canonical.push(normalized);
  }
  return canonical;
}

export async function getComposerDraftInTransaction(
  db: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    lock?: boolean;
  },
): Promise<ComposerDraftRow | null> {
  const query = db
    .select()
    .from(schema.composerDrafts)
    .where(
      and(
        eq(schema.composerDrafts.workspaceId, input.workspaceId),
        eq(schema.composerDrafts.sessionId, input.sessionId),
        eq(schema.composerDrafts.subjectId, input.subjectId),
      ),
    )
    .limit(1);
  const rows = input.lock ? await query.for("update") : await query;
  return rows[0] ?? null;
}

export async function saveComposerDraftInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    expectedRevision: number;
    text: string;
    annotations?: DraftTimelineAnnotation[];
    resources: ResourceRef[];
    model: string;
    reasoningEffort: ReasoningEffort;
    latencyMode: LatencyMode;
    /**
     * Bound the workspace control prefix wait (request-scoped API callers pass
     * `workspaceControlRequestLockTimeoutMs()`); omit for lifecycle callers.
     */
    controlLockTimeoutMs?: number;
  },
): Promise<ComposerDraftRow> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share", {
    ...(input.controlLockTimeoutMs !== undefined
      ? { lockTimeoutMs: input.controlLockTimeoutMs }
      : {}),
  });
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
  });
  await lockSession(db, input.workspaceId, input.sessionId);
  const current = await getComposerDraftInTransaction(db, {
    ...input,
    lock: true,
  });
  const currentRevision = current?.revision ?? 0;
  if (currentRevision !== input.expectedRevision) {
    throw new QueueCommandConflictError("DRAFT_CHANGED", "Composer draft changed", {
      queueVersion: 0,
      draftRevision: currentRevision,
    });
  }
  const revision = currentRevision + 1;
  const values = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    subjectId: input.subjectId,
    revision,
    text: input.text,
    annotations: DraftTimelineAnnotations.parse(input.annotations ?? []),
    resources: withCanonicalResourceMountPaths(input.resources),
    tools: [],
    toolsProvided: false,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    latencyMode: input.latencyMode,
    // A queue edit is still the same accepted work item. Preserve its frozen
    // initiator through arbitrary draft saves; only a genuinely new compose or
    // Steer captures the submitting actor.
    sourceTurnId: current?.sourceTurnId ?? null,
    sourceTurnVersion: current?.sourceTurnVersion ?? null,
    updatedAt: new Date(),
  };
  const [saved] = current
    ? await db
        .update(schema.composerDrafts)
        .set(values)
        .where(eq(schema.composerDrafts.id, current.id))
        .returning()
    : await db.insert(schema.composerDrafts).values(values).returning();
  if (!saved) throw new Error("Composer draft did not save");
  return saved;
}

export async function moveQueuedTurnInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    beforeTurnId: string | null;
    expectedQueueVersion: number;
    actor: SessionCommandActor;
    operationKey: string;
    /**
     * Bound the workspace control prefix wait (request-scoped API callers pass
     * `workspaceControlRequestLockTimeoutMs()`); omit for lifecycle callers.
     */
    controlLockTimeoutMs?: number;
  },
): Promise<QueueCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share", {
    ...(input.controlLockTimeoutMs !== undefined
      ? { lockTimeoutMs: input.controlLockTimeoutMs }
      : {}),
  });
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
  });
  let session = await lockSession(db, input.workspaceId, input.sessionId);
  const requestHash = canonicalSessionCommandHash({
    beforeTurnId: input.beforeTurnId,
    expectedQueueVersion: input.expectedQueueVersion,
  });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "queue.move",
    targetSessionId: input.sessionId,
    targetTurnId: input.turnId,
    operationKey: input.operationKey,
    canonicalRequestHash: requestHash,
  });
  if (reserved.replay && reserved.receipt.appliedQueueVersion !== null) {
    return {
      receipt: reserved.receipt,
      queueVersion: session.queueVersion,
      items: await loadQueuedTurns(db, input.workspaceId, input.sessionId),
      eventIds: [],
      replay: true,
    };
  }
  if (session.queueVersion !== input.expectedQueueVersion) {
    throw new QueueCommandConflictError("QUEUE_VERSION_CHANGED", "Queue order changed", {
      queueVersion: session.queueVersion,
    });
  }
  const rows = await loadQueuedTurns(db, input.workspaceId, input.sessionId, true);
  const target = rows.find((row) => row.id === input.turnId);
  if (!target) {
    throw new QueueCommandConflictError("QUEUE_PROMPT_STARTED", "Prompt is no longer waiting", {
      queueVersion: session.queueVersion,
    });
  }
  if (input.beforeTurnId === input.turnId) {
    throw new QueueCommandConflictError(
      "QUEUE_ANCHOR_CHANGED",
      "Prompt cannot move before itself",
      {
        queueVersion: session.queueVersion,
        turnVersion: target.version,
      },
    );
  }
  const withoutTarget = rows.filter((row) => row.id !== input.turnId);
  const anchorIndex =
    input.beforeTurnId === null
      ? withoutTarget.length
      : withoutTarget.findIndex((row) => row.id === input.beforeTurnId);
  if (anchorIndex < 0) {
    throw new QueueCommandConflictError("QUEUE_ANCHOR_CHANGED", "Queue anchor changed", {
      queueVersion: session.queueVersion,
      turnVersion: target.version,
    });
  }
  const ordered = [...withoutTarget];
  ordered.splice(anchorIndex, 0, target);
  const changed = ordered.some((row, index) => row.id !== rows[index]?.id);
  const queueVersion = changed ? session.queueVersion + 1 : session.queueVersion;
  const eventIds: string[] = [];
  if (changed) {
    await normalizeQueuePositions(
      db,
      input.workspaceId,
      input.sessionId,
      ordered.map((row) => row.id),
    );
    const [event] = await db
      .insert(schema.sessionEvents)
      .values(
        withLosslessContentWriteVersion(
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            sequence: session.lastSequence + 1,
            type: "session.queue.changed",
            turnId: target.id,
            payload: {
              operation: "move",
              queueVersion,
              turnId: target.id,
              beforeTurnId: input.beforeTurnId,
            },
            occurredAt: new Date(),
          },
          "payload",
          "payloadCodecVersion",
        ),
      )
      .returning({ id: schema.sessionEvents.id });
    if (!event) throw new Error("Queue move event was not inserted");
    eventIds.push(event.id);
    await db
      .update(schema.sessions)
      .set({
        queueVersion,
        lastSequence: session.lastSequence + 1,
        updatedAt: new Date(),
      })
      .where(eq(schema.sessions.id, input.sessionId));
  }
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    queueVersion,
    turnVersion: target.version,
    result: { changed, beforeTurnId: input.beforeTurnId },
  });
  return {
    receipt,
    queueVersion,
    items: await loadQueuedTurns(db, input.workspaceId, input.sessionId),
    eventIds,
    replay: false,
  };
}

export async function deleteSessionQueueItemInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedTurnVersion: number;
    actor: SessionCommandActor;
    operationKey: string;
    reason?: string | null;
    /**
     * Bound the workspace control prefix wait (request-scoped API callers pass
     * `workspaceControlRequestLockTimeoutMs()`); omit for lifecycle callers.
     */
    controlLockTimeoutMs?: number;
  },
): Promise<QueueCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share", {
    ...(input.controlLockTimeoutMs !== undefined
      ? { lockTimeoutMs: input.controlLockTimeoutMs }
      : {}),
  });
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
  });
  let session = await lockSession(db, input.workspaceId, input.sessionId);
  const requestHash = canonicalSessionCommandHash({
    expectedTurnVersion: input.expectedTurnVersion,
    reason: input.reason ?? null,
  });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "queue.delete",
    targetSessionId: input.sessionId,
    targetTurnId: input.turnId,
    operationKey: input.operationKey,
    canonicalRequestHash: requestHash,
  });
  if (reserved.replay && reserved.receipt.appliedQueueVersion !== null) {
    return {
      receipt: reserved.receipt,
      queueVersion: session.queueVersion,
      items: await loadQueuedTurns(db, input.workspaceId, input.sessionId),
      eventIds: [],
      replay: true,
    };
  }
  const turn = (
    await lockSessionEventWriteRows(db, {
      workspaceId: input.workspaceId,
      controlLock: "already_locked",
      workspaceLock: "already_locked",
      turnIds: [input.turnId],
    })
  ).turns[0];
  if (!turn || turn.status !== "queued" || !["user", "api"].includes(turn.source)) {
    throw new QueueCommandConflictError("QUEUE_PROMPT_STARTED", "Prompt is no longer waiting", {
      queueVersion: session.queueVersion,
      ...(turn ? { turnVersion: turn.version } : {}),
    });
  }
  if (turn.version !== input.expectedTurnVersion) {
    throw new QueueCommandConflictError("PROMPT_CHANGED", "Prompt changed", {
      queueVersion: session.queueVersion,
      turnVersion: turn.version,
    });
  }
  const now = new Date();
  const queueVersion = session.queueVersion + 1;
  await db
    .update(schema.sessionTurns)
    .set({
      status: "cancelled",
      cancelledBy:
        input.actor.type === "agent_attempt"
          ? `attempt:${input.actor.attemptId}`
          : input.actor.subjectId,
      cancelReason: input.reason ?? "human_delete",
      version: turn.version + 1,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sessionTurns.id, turn.id));
  const remaining = await loadQueuedTurns(db, input.workspaceId, input.sessionId, true);
  await normalizeQueuePositions(
    db,
    input.workspaceId,
    input.sessionId,
    remaining.map((row) => row.id),
  );
  const [event] = await db
    .insert(schema.sessionEvents)
    .values(
      withLosslessContentWriteVersion(
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sequence: session.lastSequence + 1,
          type: "session.queue.changed",
          turnId: turn.id,
          payload: {
            operation: "delete",
            queueVersion,
            turnId: turn.id,
          },
          occurredAt: now,
        },
        "payload",
        "payloadCodecVersion",
      ),
    )
    .returning({ id: schema.sessionEvents.id });
  if (!event) throw new Error("Queue delete event was not inserted");
  await db
    .update(schema.sessions)
    .set({
      queueVersion,
      lastSequence: session.lastSequence + 1,
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, input.sessionId));
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    queueVersion,
    turnVersion: turn.version + 1,
    result: { reason: input.reason ?? "human_delete" },
  });
  return {
    receipt,
    queueVersion,
    items: remaining,
    eventIds: [event.id],
    replay: false,
  };
}

export async function editQueuedTurnInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    subjectId: string;
    expectedTurnVersion: number;
    expectedDraftRevision: number;
    replaceDraft: boolean;
    actor: SessionCommandActor;
    operationKey: string;
    /**
     * Bound the workspace control prefix wait (request-scoped API callers pass
     * `workspaceControlRequestLockTimeoutMs()`); omit for lifecycle callers.
     */
    controlLockTimeoutMs?: number;
  },
): Promise<EditQueueCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share", {
    ...(input.controlLockTimeoutMs !== undefined
      ? { lockTimeoutMs: input.controlLockTimeoutMs }
      : {}),
  });
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
  });
  let session = await lockSession(db, input.workspaceId, input.sessionId);
  const requestHash = canonicalSessionCommandHash({
    expectedTurnVersion: input.expectedTurnVersion,
    expectedDraftRevision: input.expectedDraftRevision,
    replaceDraft: input.replaceDraft,
  });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "queue.edit",
    targetSessionId: input.sessionId,
    targetTurnId: input.turnId,
    operationKey: input.operationKey,
    canonicalRequestHash: requestHash,
  });
  const existingDraft = await getComposerDraftInTransaction(db, {
    ...input,
    lock: true,
  });
  if (reserved.replay && reserved.receipt.appliedQueueVersion !== null) {
    if (!existingDraft) throw new Error("Replayed queue Edit has no durable draft");
    return {
      receipt: reserved.receipt,
      queueVersion: session.queueVersion,
      items: await loadQueuedTurns(db, input.workspaceId, input.sessionId),
      draft: existingDraft,
      eventIds: [],
      replay: true,
    };
  }
  const draftRevision = existingDraft?.revision ?? 0;
  if (draftRevision !== input.expectedDraftRevision) {
    throw new QueueCommandConflictError("DRAFT_CHANGED", "Composer draft changed", {
      queueVersion: session.queueVersion,
      draftRevision,
    });
  }
  if (existingDraft && draftIsNonEmpty(existingDraft) && !input.replaceDraft) {
    throw new QueueCommandConflictError("DRAFT_NOT_EMPTY", "Composer draft is not empty", {
      queueVersion: session.queueVersion,
      draftRevision,
    });
  }
  const turn = (
    await lockSessionEventWriteRows(db, {
      workspaceId: input.workspaceId,
      controlLock: "already_locked",
      workspaceLock: "already_locked",
      turnIds: [input.turnId],
    })
  ).turns[0];
  if (!turn || turn.status !== "queued" || !["user", "api"].includes(turn.source)) {
    throw new QueueCommandConflictError("QUEUE_PROMPT_STARTED", "Prompt is no longer waiting", {
      queueVersion: session.queueVersion,
      draftRevision,
      ...(turn ? { turnVersion: turn.version } : {}),
    });
  }
  if (turn.version !== input.expectedTurnVersion) {
    throw new QueueCommandConflictError("PROMPT_CHANGED", "Prompt changed", {
      queueVersion: session.queueVersion,
      turnVersion: turn.version,
      draftRevision,
    });
  }
  if (turn.personalResourceAttachmentSummary?.mode === "once") {
    throw new QueueCommandConflictError(
      "ONCE_ATTACHMENT_IMMUTABLE",
      "A queued prompt with a once personal-resource attachment cannot be edited into new work",
      {
        queueVersion: session.queueVersion,
        turnVersion: turn.version,
        draftRevision,
      },
    );
  }
  const nextDraftRevision = draftRevision + 1;
  const draftValues = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    subjectId: input.subjectId,
    revision: nextDraftRevision,
    text: turn.prompt,
    annotations: draftAnnotationsFromTurn(turn.annotations),
    resources: withCanonicalResourceMountPaths(turn.resources),
    tools: [],
    toolsProvided: false,
    model: turn.model,
    reasoningEffort: turn.reasoningEffort,
    latencyMode: turn.latencyMode,
    sourceTurnId: turn.id,
    sourceTurnVersion: turn.version,
    updatedAt: new Date(),
  };
  const [draft] = existingDraft
    ? await db
        .update(schema.composerDrafts)
        .set(draftValues)
        .where(eq(schema.composerDrafts.id, existingDraft.id))
        .returning()
    : await db.insert(schema.composerDrafts).values(draftValues).returning();
  if (!draft) throw new Error("Queue Edit did not persist its draft");
  const now = new Date();
  const queueVersion = session.queueVersion + 1;
  await db
    .update(schema.sessionTurns)
    .set({
      status: "withdrawn_for_edit",
      cancelledBy: input.subjectId,
      cancelReason: "withdrawn_for_edit",
      version: turn.version + 1,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.sessionTurns.id, turn.id));
  const remaining = await loadQueuedTurns(db, input.workspaceId, input.sessionId, true);
  await normalizeQueuePositions(
    db,
    input.workspaceId,
    input.sessionId,
    remaining.map((row) => row.id),
  );
  const [event] = await db
    .insert(schema.sessionEvents)
    .values(
      withLosslessContentWriteVersion(
        {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          sequence: session.lastSequence + 1,
          type: "session.queue.changed",
          turnId: turn.id,
          payload: {
            operation: "edit",
            queueVersion,
            turnId: turn.id,
            draftRevision: nextDraftRevision,
          },
          occurredAt: now,
        },
        "payload",
        "payloadCodecVersion",
      ),
    )
    .returning({ id: schema.sessionEvents.id });
  if (!event) throw new Error("Queue edit event was not inserted");
  await db
    .update(schema.sessions)
    .set({
      queueVersion,
      lastSequence: session.lastSequence + 1,
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, input.sessionId));
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    queueVersion,
    turnVersion: turn.version + 1,
    draftRevision: nextDraftRevision,
    result: { sourceTurnId: turn.id },
  });
  return {
    receipt,
    queueVersion,
    items: remaining,
    draft,
    eventIds: [event.id],
    replay: false,
  };
}

export async function steerQueuedTurnInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedTurnVersion: number;
    controlEtag?: string | null;
    actor: SessionCommandActor;
    operationKey: string;
    /** Request-scoped callers bound the control prefix wait; lifecycle callers omit it. */
    controlLockTimeoutMs?: number;
  },
): Promise<SteerQueueCommandResult> {
  const admission = await lockWorkspaceInferenceControlForAdmission(db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    ...(input.controlLockTimeoutMs !== undefined
      ? { lockTimeoutMs: input.controlLockTimeoutMs }
      : {}),
  });
  const workspaceControl = admission.control;
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    sessionIds:
      input.actor.type === "agent_attempt"
        ? [input.actor.sessionId, input.sessionId]
        : [input.sessionId],
    turnIds:
      input.actor.type === "agent_attempt" ? [input.actor.turnId, input.turnId] : [input.turnId],
    attemptIds: input.actor.type === "agent_attempt" ? [input.actor.attemptId] : [],
  });
  const requestHash = canonicalSessionCommandHash({
    expectedTurnVersion: input.expectedTurnVersion,
    controlEtag: input.controlEtag ?? null,
  });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "queue.steer",
    targetSessionId: input.sessionId,
    targetTurnId: input.turnId,
    operationKey: input.operationKey,
    canonicalRequestHash: requestHash,
  });
  if (reserved.replay && reserved.receipt.appliedQueueVersion !== null) {
    const replaySession = await lockSession(db, input.workspaceId, input.sessionId);
    return {
      receipt: reserved.receipt,
      queueVersion: replaySession.queueVersion,
      items: await loadQueuedTurns(db, input.workspaceId, input.sessionId),
      eventIds: [],
      interruptionCount: Number(reserved.receipt.result.interruptionCount ?? 0),
      workspaceControlEventId:
        typeof reserved.receipt.result.workspaceControlEventId === "string"
          ? reserved.receipt.result.workspaceControlEventId
          : null,
      replay: true,
    };
  }
  await lockSession(db, input.workspaceId, input.sessionId);
  if (input.actor.type === "agent_attempt") {
    await assertAgentCommandAuthorityInTransaction(db, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      targetSessionId: input.sessionId,
      action: "steer",
    });
  }
  const before = await evaluateSessionControl(db, input.workspaceId, input.sessionId, {
    workspaceControl,
  });
  if (input.controlEtag && input.controlEtag !== before.controlEtag) {
    throw new SessionControlConflictError();
  }
  const resumed = await autoResumeSessionBranchInTransaction(db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    actor:
      input.actor.type === "agent_attempt"
        ? `attempt:${input.actor.attemptId}`
        : input.actor.subjectId,
    reason: "human_steer",
    observedControlEtag: input.controlEtag ?? null,
    admission,
  });
  const session = await lockSession(db, input.workspaceId, input.sessionId);
  const rows = await loadQueuedTurns(db, input.workspaceId, input.sessionId, true);
  const target = rows.find((row) => row.id === input.turnId);
  if (!target) {
    throw new QueueCommandConflictError("QUEUE_PROMPT_STARTED", "Prompt is no longer waiting", {
      queueVersion: session.queueVersion,
    });
  }
  if (target.version !== input.expectedTurnVersion) {
    throw new QueueCommandConflictError("PROMPT_CHANGED", "Prompt changed", {
      queueVersion: session.queueVersion,
      turnVersion: target.version,
    });
  }

  const supersession = await supersedeSessionCurrentDirectionInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    activeTurnId: session.activeTurnId,
    actor: input.actor,
    operationId: reserved.receipt.id,
    controlRevision: resumed.revision,
    lastSequence: session.lastSequence,
  });
  const interruptionCount = supersession.interruptionCount;
  const supersededTurnId = supersession.replacedTurn?.id ?? null;
  const supersededAttemptId = supersession.replacedTurn?.activeAttemptId ?? null;
  const liveCurrentTurnId = supersession.liveCurrentTurnId;

  const withoutTarget = rows.filter((row) => row.id !== target.id);
  const ordered = [target, ...withoutTarget];
  await normalizeQueuePositions(
    db,
    input.workspaceId,
    input.sessionId,
    ordered.map((row) => row.id),
  );
  const now = new Date();
  const queueVersion = session.queueVersion + 1;
  await db
    .update(schema.sessionTurns)
    .set({
      version: target.version + 1,
      metadata: {
        ...target.metadata,
        delivery: "steer",
        replacedTurnId: supersededTurnId,
        replacedAttemptId: supersededAttemptId,
        interruptionCount,
      },
      updatedAt: now,
    })
    .where(eq(schema.sessionTurns.id, target.id));
  let sequence = supersession.lastSequence;
  const actor =
    input.actor.type === "agent_attempt"
      ? `attempt:${input.actor.attemptId}`
      : input.actor.subjectId;
  const eventValues: SessionEventInsertWithPayload[] = [];
  if (supersededTurnId && !liveCurrentTurnId) {
    eventValues.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: ++sequence,
      type: "turn.superseded",
      turnId: supersededTurnId,
      payload: { reason: "steer", targetTurnId: target.id },
      occurredAt: now,
    });
  }
  eventValues.push({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sequence: ++sequence,
    type: "session.control.steer_requested",
    turnId: supersededTurnId ?? target.id,
    payload: {
      operationId: reserved.receipt.id,
      targetTurnId: target.id,
      replacedTurnId: supersededTurnId,
      stopping: liveCurrentTurnId !== null,
    },
    occurredAt: now,
  });
  const eventRows = await db
    .insert(schema.sessionEvents)
    .values(withLosslessContentWriteVersion(eventValues, "payload", "payloadCodecVersion"))
    .returning({
      id: schema.sessionEvents.id,
    });
  await db
    .update(schema.sessions)
    .set({
      activeTurnId: liveCurrentTurnId,
      status: liveCurrentTurnId ? session.status : "queued",
      queueVersion,
      queueHeadPosition: 0,
      queueTailPosition: ordered.length,
      lastSequence: sequence,
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, input.sessionId));
  await db.insert(schema.auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: actor,
        action: "session.queue.steer",
        targetType: "session_turn",
        targetId: target.id,
        metadata: {
          operationId: reserved.receipt.id,
          replacedTurnId: supersededTurnId,
          interruptionCount,
        },
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
  const wakeRevision = await registerSessionWorkflowWakeInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    temporalWorkflowId: session.temporalWorkflowId ?? `session-${input.sessionId}`,
    reason: "queue_steer",
    controlRequested: true,
  });
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    controlRevision: resumed.revision,
    queueVersion,
    turnVersion: target.version + 1,
    result: {
      interruptionCount,
      supersededTurnId,
      wakeRevision,
      workspaceControlEventId: resumed.workspaceControlEventId,
    },
  });
  return {
    receipt,
    queueVersion,
    items: await loadQueuedTurns(db, input.workspaceId, input.sessionId),
    eventIds: eventRows.map((event) => event.id),
    interruptionCount,
    workspaceControlEventId: resumed.workspaceControlEventId,
    replay: false,
  };
}

export async function submitHumanPromptInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    subjectLabel?: string;
    actor: SessionCommandActor;
    operationKey: string;
    delivery: "send" | "steer";
    controlEtag?: string | null;
    expectedDraftRevision?: number | null;
    text: string;
    annotations?: TimelineAnnotation[];
    modelContext?: string | null;
    resources: ResourceRef[];
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    latencyMode?: LatencyMode | null;
    reasoningEffortFallback: ReasoningEffort;
    /** Trusted API/core admission snapshot. Omitted only by legacy low-level callers. */
    turnExecutionPolicy?: TurnExecutionPolicyV1;
    /** Trusted core-only metadata attached to the admitted turn. */
    turnMetadata?: Record<string, unknown>;
    /** Trusted display projection; the durable turn still receives `text`. */
    messagePresentation?: {
      kind: "realtime_voice" | "realtime_voice_handoff";
      text: string;
      context: string;
    };
    source: "user" | "api";
    /** Record the admitted run's durable usage fact in this transaction. */
    recordAgentRunUsage?: boolean;
    personalConnectionDelegations?: McpPersonalConnectionDelegation[];
    personalResourceAttachment?: PersonalResourceAttachmentIntent;
    mcpCredentialUpdates?: Array<{
      id: string;
      headersEncrypted: Record<string, string>;
    }>;
    /** Request-scoped callers bound the control prefix wait; lifecycle callers omit it. */
    controlLockTimeoutMs?: number;
  },
): Promise<SubmitHumanPromptResult> {
  const annotations = TimelineAnnotations.parse(input.annotations ?? []);
  // Send/Steer mutate the control row only when they auto-resume a paused
  // branch. Hold the prefix shared otherwise so concurrent admission on the
  // workspace is not serialized and genuine mutators are not starved.
  const admission = await lockWorkspaceInferenceControlForAdmission(db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    ...(input.controlLockTimeoutMs !== undefined
      ? { lockTimeoutMs: input.controlLockTimeoutMs }
      : {}),
  });
  const workspaceControl = admission.control;
  if (input.actor.type === "human") {
    await setSubjectRlsContext(db, input.actor.subjectId);
    await assertActiveManagedHumanOrganizationMembership(db, {
      accountId: input.accountId,
      subjectId: input.actor.subjectId,
    });
  }
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    sessionIds:
      input.actor.type === "agent_attempt"
        ? [input.actor.sessionId, input.sessionId]
        : [input.sessionId],
    turnIds: input.actor.type === "agent_attempt" ? [input.actor.turnId] : [],
    attemptIds: input.actor.type === "agent_attempt" ? [input.actor.attemptId] : [],
  });
  const requestHash = canonicalSessionCommandHash({
    delivery: input.delivery,
    controlEtag: input.controlEtag ?? null,
    expectedDraftRevision: input.expectedDraftRevision ?? null,
    text: input.text,
    annotations,
    modelContext: input.modelContext ?? null,
    resources: withCanonicalResourceMountPaths(input.resources),
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    latencyMode: input.latencyMode ?? null,
    source: input.source,
    turnMetadata: input.turnMetadata ?? {},
    messagePresentation: input.messagePresentation ?? null,
    mcpCredentialUpdates: input.mcpCredentialUpdates ?? [],
    personalConnectionDelegations: input.personalConnectionDelegations ?? [],
    personalResourceAttachment: input.personalResourceAttachment ?? null,
    ...(input.actor.type === "service"
      ? {
          serviceInitiator: {
            subjectId: input.actor.subjectId,
            subjectLabel: input.actor.subjectLabel ?? null,
            context: input.actor.context ?? {},
          },
        }
      : {}),
  });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: input.delivery === "steer" ? "prompt.steer" : "prompt.send",
    targetSessionId: input.sessionId,
    targetTurnId: null,
    operationKey: input.operationKey,
    canonicalRequestHash: requestHash,
  });
  if (reserved.replay && reserved.receipt.appliedQueueVersion !== null) {
    const turnId = String(reserved.receipt.result.turnId ?? "");
    const acceptedEventId = String(reserved.receipt.result.acceptedEventId ?? "");
    const eventIds = Array.isArray(reserved.receipt.result.eventIds)
      ? reserved.receipt.result.eventIds.filter((id): id is string => typeof id === "string")
      : [];
    const wakeRevision = Number(reserved.receipt.result.wakeRevision ?? 0);
    if (!turnId || !acceptedEventId || wakeRevision < 1) {
      throw new SessionControlInvariantError("Replayed prompt receipt is incomplete");
    }
    const replayEvents = await db
      .select()
      .from(schema.sessionEvents)
      .where(
        and(
          eq(schema.sessionEvents.workspaceId, input.workspaceId),
          eq(schema.sessionEvents.sessionId, input.sessionId),
          inArray(schema.sessionEvents.id, eventIds),
        ),
      )
      .orderBy(asc(schema.sessionEvents.sequence));
    const [replayTurn] = await db
      .select()
      .from(schema.sessionTurns)
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
          eq(schema.sessionTurns.sessionId, input.sessionId),
          eq(schema.sessionTurns.id, turnId),
        ),
      )
      .limit(1);
    const events = replayEvents.map(mapSubmittedPromptEvent);
    const accepted = events.find((event) => event.id === acceptedEventId);
    if (!accepted || !replayTurn || events.length !== eventIds.length) {
      throw new SessionControlInvariantError("Replayed prompt rows are incomplete");
    }
    const replayDraft =
      input.expectedDraftRevision === null || input.expectedDraftRevision === undefined
        ? null
        : await getComposerDraftInTransaction(db, {
            workspaceId: input.workspaceId,
            sessionId: input.sessionId,
            subjectId: input.subjectId,
          });
    return {
      receipt: reserved.receipt,
      queueVersion: Number(reserved.receipt.appliedQueueVersion),
      accepted,
      events,
      turn: mapSubmittedPromptTurn(replayTurn),
      draft: replayDraft,
      acceptedEventId,
      eventIds,
      turnId,
      wakeRevision,
      interruptionCount: Number(reserved.receipt.result.interruptionCount ?? 0),
      workspaceControlEventId:
        typeof reserved.receipt.result.workspaceControlEventId === "string"
          ? reserved.receipt.result.workspaceControlEventId
          : null,
      replay: true,
    };
  }

  const before = await evaluateSessionControl(db, input.workspaceId, input.sessionId, {
    workspaceControl,
  });
  if (input.controlEtag && input.controlEtag !== before.controlEtag) {
    throw new SessionControlConflictError();
  }

  const resumed = await autoResumeSessionBranchInTransaction(db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    actor:
      input.actor.type === "agent_attempt"
        ? `attempt:${input.actor.attemptId}`
        : input.actor.subjectId,
    reason:
      input.actor.type === "service"
        ? input.delivery === "steer"
          ? "service_steer"
          : "service_send"
        : input.delivery === "steer"
          ? "human_steer"
          : "human_send",
    observedControlEtag: input.controlEtag ?? null,
    admission,
  });
  const session = await lockSession(db, input.workspaceId, input.sessionId);
  if (session.status === "cancelled") {
    throw new QueueCommandConflictError(
      "QUEUE_PROMPT_STARTED",
      "Cancelled session cannot accept work",
      {
        queueVersion: session.queueVersion,
      },
    );
  }

  const draft =
    input.expectedDraftRevision === null || input.expectedDraftRevision === undefined
      ? null
      : await getComposerDraftInTransaction(db, {
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          subjectId: input.subjectId,
          lock: true,
        });
  if (input.expectedDraftRevision !== null && input.expectedDraftRevision !== undefined) {
    const actualRevision = draft?.revision ?? 0;
    if (actualRevision !== input.expectedDraftRevision) {
      throw new QueueCommandConflictError("DRAFT_CHANGED", "Composer draft changed", {
        queueVersion: session.queueVersion,
        draftRevision: actualRevision,
      });
    }
    if (
      draft &&
      canonicalSessionCommandHash({
        text: draft.text,
        annotations: DraftTimelineAnnotations.parse(draft.annotations),
        resources: withCanonicalResourceMountPaths(draft.resources),
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
        latencyMode: draft.latencyMode,
      }) !==
        canonicalSessionCommandHash({
          text: input.text,
          annotations: annotations.map(({ ordinal: _ordinal, ...annotation }) => annotation),
          resources: withCanonicalResourceMountPaths(input.resources),
          model: input.model ?? session.model,
          reasoningEffort: input.reasoningEffort ?? input.reasoningEffortFallback,
          latencyMode: input.turnExecutionPolicy?.latencyMode ?? input.latencyMode ?? "standard",
        })
    ) {
      throw new QueueCommandConflictError(
        "DRAFT_CHANGED",
        "Submitted content is not the saved draft",
        {
          queueVersion: session.queueVersion,
          draftRevision: draft.revision,
        },
      );
    }
  }

  let editedSourceTurn: QueuedTurnRow | undefined;
  let editedSourceModelContext: string | null | undefined;
  if (draft?.sourceTurnId) {
    const sourceLocks = await lockSessionEventWriteRows(db, {
      workspaceId: input.workspaceId,
      controlLock: "already_locked",
      workspaceLock: "already_locked",
      turnIds: [draft.sourceTurnId],
    });
    const sourceTurn = sourceLocks.turns[0];
    const sourceTurnVersion = draft.sourceTurnVersion;
    const sourceMetadata = sourceTurn?.metadata ?? {};
    const sourceIsExactWithdrawnRevision =
      sourceTurn !== undefined &&
      sourceTurn.accountId === input.accountId &&
      sourceTurn.workspaceId === input.workspaceId &&
      sourceTurn.sessionId === input.sessionId &&
      (sourceTurn.source === "user" || sourceTurn.source === "api") &&
      sourceTurn.status === "withdrawn_for_edit" &&
      sourceTurnVersion !== null &&
      sourceTurn.version === sourceTurnVersion + 1 &&
      sourceTurn.cancelledBy === input.subjectId &&
      sourceTurn.cancelReason === "withdrawn_for_edit" &&
      sourceTurn.activeAttemptId === null &&
      sourceMetadata.delivery !== "steer";
    if (!sourceIsExactWithdrawnRevision) {
      throw new QueueCommandConflictError(
        "EDIT_SOURCE_CHANGED",
        "Edited prompt source changed or is no longer withdrawn for edit",
        {
          queueVersion: session.queueVersion,
          draftRevision: draft.revision,
          ...(sourceTurn ? { turnVersion: sourceTurn.version } : {}),
        },
      );
    }
    // Preserve the non-rendered message segment when editing only the visible
    // draft. Source identity is fenced by the exact withdrawn row version; a
    // replacement request cannot accidentally detach or replace its context.
    editedSourceTurn = sourceTurn;
    editedSourceModelContext = sourceTurn.modelContext ?? null;
  }

  for (const update of input.mcpCredentialUpdates ?? []) {
    const [server] = await db
      .update(schema.sessionMcpServers)
      .set({
        headersEncrypted: update.headersEncrypted,
        credentialVersion: sql`${schema.sessionMcpServers.credentialVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.sessionMcpServers.workspaceId, input.workspaceId),
          eq(schema.sessionMcpServers.sessionId, input.sessionId),
          eq(schema.sessionMcpServers.serverId, update.id),
        ),
      )
      .returning({ id: schema.sessionMcpServers.serverId });
    if (!server) throw new Error(`Unknown session MCP server: ${update.id}`);
  }

  const now = new Date();
  let frozenInitiator: FrozenTurnInitiator;
  if (input.delivery === "send" && draft?.sourceTurnId) {
    const sourceTurn = editedSourceTurn;
    if (!sourceTurn) {
      throw new SessionControlInvariantError("Edited prompt source turn is missing");
    }
    frozenInitiator = {
      initiator: initiatorFromStorage(
        sourceTurn.initiatorKind,
        sourceTurn.initiatorSubjectId,
        sourceTurn.initiatorContext ?? {},
      ),
      context: sourceTurn.initiatorContext ?? {},
    };
  } else {
    frozenInitiator = await frozenInitiatorForCommandActor(
      db,
      input.workspaceId,
      input.actor,
      input.subjectLabel,
    );
  }
  const acceptedInitiatingHumanSubjectId = editedSourceTurn
    ? (editedSourceTurn.initiatingHumanSubjectId ??
      (editedSourceTurn.initiatorKind === "subject" ? editedSourceTurn.initiatorSubjectId : null))
    : (frozenInitiator.initiatingHumanSubjectId ??
      (frozenInitiator.initiator.kind === "subject" ? frozenInitiator.initiator.subjectId : null));
  if (
    (input.personalConnectionDelegations ?? []).some(
      (delegation) => delegation.userDelegation !== undefined,
    ) ||
    input.personalResourceAttachment !== undefined
  ) {
    if (!acceptedInitiatingHumanSubjectId) {
      throw new SessionControlInvariantError("Personal authority requires an exact causal human");
    }
    await db.execute(
      sql`select set_config(
        'opengeni.initiating_human_subject_id',
        ${acceptedInitiatingHumanSubjectId},
        true
      )`,
    );
  }
  const xaiProviderAccountAuthoritySnapshot = editedSourceTurn
    ? XaiProviderAccountAuthoritySnapshotV1.parse(
        editedSourceTurn.xaiProviderAccountAuthoritySnapshot,
      )
    : input.actor.type === "human"
      ? await resolveXaiProviderAccountAuthoritySnapshotForAcceptanceInTransaction(db, {
          workspaceId: input.workspaceId,
        })
      : WORKSPACE_XAI_PROVIDER_ACCOUNT_AUTHORITY_SNAPSHOT_V1;
  const acceptedEventId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const workflowId = session.temporalWorkflowId ?? `session-${session.id}`;
  const effectiveModelContext =
    editedSourceModelContext !== undefined
      ? editedSourceModelContext
      : (input.modelContext ?? null);
  let sequence = session.lastSequence;
  const eventValues: SessionEventInsertWithPayload[] = [
    {
      id: acceptedEventId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: ++sequence,
      type: "user.message",
      clientEventId: input.operationKey,
      payload: {
        text: input.messagePresentation?.text ?? input.text,
        ...(annotations.length > 0 ? { annotations } : {}),
        ...(input.messagePresentation
          ? {
              presentation: {
                kind: input.messagePresentation.kind,
                context: input.messagePresentation.context,
              },
            }
          : {}),
        ...(input.resources.length ? { resources: input.resources } : {}),
        ...(effectiveModelContext ? { modelContext: effectiveModelContext } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        ...(input.latencyMode ? { latencyMode: input.latencyMode } : {}),
        delivery: input.delivery,
        initiator: frozenInitiator.initiator,
      },
      occurredAt: now,
    },
  ];
  const existingQueued = await loadQueuedTurns(db, input.workspaceId, input.sessionId, true);
  const [turn] = await db
    .insert(schema.sessionTurns)
    .values(
      withLosslessContentWriteVersion(
        {
          id: turnId,
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          triggerEventId: acceptedEventId,
          temporalWorkflowId: workflowId,
          status: "queued",
          source: input.source,
          position: input.delivery === "steer" ? 0 : existingQueued.length + 1,
          prompt: input.text,
          annotations,
          modelContext: effectiveModelContext,
          resources: input.resources,
          tools: [],
          toolsProvided: false,
          model: input.model ?? session.model,
          reasoningEffort: input.reasoningEffort ?? input.reasoningEffortFallback,
          latencyMode: input.turnExecutionPolicy?.latencyMode ?? input.latencyMode ?? "standard",
          sandboxBackend: session.sandboxBackend,
          metadata: input.turnExecutionPolicy
            ? metadataWithTurnExecutionPolicyV1(input.turnMetadata ?? {}, input.turnExecutionPolicy)
            : (input.turnMetadata ?? {}),
          lineage: { actor: input.actor.type },
          ...initiatorColumns(frozenInitiator),
          initiatingHumanSubjectId: acceptedInitiatingHumanSubjectId,
          personalConnectionDelegations: editedSourceTurn
            ? editedSourceTurn.personalConnectionDelegations
            : (input.personalConnectionDelegations ?? []),
          xaiProviderAccountAuthoritySnapshot,
          createdAt: now,
          updatedAt: now,
        },
        "prompt",
        "promptCodecVersion",
      ),
    )
    .returning();
  if (!turn) throw new SessionControlInvariantError("Prompt turn was not inserted");
  let committedTurn = turn;
  const personalResourceExpectedAuthorityEpoch =
    input.personalResourceAttachment?.expectedAuthorityEpoch;
  let acceptedPersonalResources: Awaited<
    ReturnType<typeof acceptTurnPersonalResourceAttachmentInTransaction>
  > | null = null;
  if (input.personalResourceAttachment) {
    if (personalResourceExpectedAuthorityEpoch === undefined) {
      throw new SessionControlInvariantError(
        "Personal-resource attachment requires an expected authority epoch",
      );
    }
    acceptedPersonalResources = await acceptTurnPersonalResourceAttachmentInTransaction(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId,
      subjectId: acceptedInitiatingHumanSubjectId!,
      intent: {
        ...input.personalResourceAttachment,
        expectedAuthorityEpoch: personalResourceExpectedAuthorityEpoch,
      },
    });
  }
  if (acceptedPersonalResources) {
    committedTurn = {
      ...turn,
      personalResourceAttachmentSummary: acceptedPersonalResources.summary,
      personalResourceProtocolVersion: 1,
    };
    eventValues.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId,
      sequence: ++sequence,
      type: "session.personal_resources.attached",
      payload: {
        turnId,
        ...acceptedPersonalResources.summary,
      },
      occurredAt: now,
    });
  }
  eventValues.push({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sequence: ++sequence,
    type: "turn.queued",
    turnId,
    payload: {
      turnId,
      triggerEventId: acceptedEventId,
      source: input.source,
      initiator: frozenInitiator.initiator,
    },
    occurredAt: now,
  });

  const supersession =
    input.delivery === "steer"
      ? await supersedeSessionCurrentDirectionInTransaction(db, {
          accountId: input.accountId,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          activeTurnId: session.activeTurnId,
          actor: input.actor,
          operationId: reserved.receipt.id,
          controlRevision: resumed.revision,
          lastSequence: session.lastSequence,
        })
      : {
          interruptionCount: 0,
          replacedTurn: null,
          liveCurrentTurnId: null,
          lastSequence: session.lastSequence,
        };
  // Ownerless Steer settlement may have appended interrupted tool results.
  // Rebase the not-yet-inserted foreground events after those canonical rows.
  sequence = supersession.lastSequence;
  for (const event of eventValues) event.sequence = ++sequence;
  const interruptionCount = supersession.interruptionCount;
  const replacedTurnId = supersession.replacedTurn?.id ?? null;
  const replacedAttemptId = supersession.replacedTurn?.activeAttemptId ?? null;
  const liveCurrentTurnId = supersession.liveCurrentTurnId;
  // Durable provenance for the queue projection. Until the superseded attempt
  // loses inference, user-visible output, and workspace-persistence authority,
  // its exact first-class attempt has no quiescence receipt. Pairing that
  // attempt with the replacement lets every client render "Stopping previous
  // attempt…" truthfully across refresh/reconnect, even though logical
  // settlement has already cleared sessions.active_turn_id. Do not infer this
  // state from a local request spinner or queue position.
  if (input.delivery === "steer") {
    const [updatedTurn] = await db
      .update(schema.sessionTurns)
      .set({
        metadata: {
          ...turn.metadata,
          delivery: "steer",
          replacedTurnId,
          replacedAttemptId,
          interruptionCount,
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.sessionTurns.workspaceId, input.workspaceId),
          eq(schema.sessionTurns.sessionId, input.sessionId),
          eq(schema.sessionTurns.id, turnId),
        ),
      )
      .returning();
    if (!updatedTurn) {
      throw new SessionControlInvariantError("Steer prompt turn metadata was not updated");
    }
    committedTurn = updatedTurn;
  }
  if (supersession.replacedTurn) {
    const current = supersession.replacedTurn;
    if (!liveCurrentTurnId) {
      eventValues.push({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sequence: ++sequence,
        type: "turn.superseded",
        turnId: current.id,
        payload: { reason: "steer", targetTurnId: turnId },
        occurredAt: now,
      });
    }
    eventValues.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: ++sequence,
      type: "session.control.steer_requested",
      turnId: current.id,
      turnGeneration: current.executionGeneration,
      turnAttemptId: current.activeAttemptId,
      turnAssociation: "current",
      payload: {
        operationId: reserved.receipt.id,
        targetTurnId: turnId,
        replacedTurnId: current.id,
        stopping: liveCurrentTurnId !== null,
      },
      occurredAt: now,
    });
  }

  // A human/API prompt is external input for the goal. A goal paused only by
  // its continuation ceiling (`max_auto_continuations`, pacing rather than
  // intent) resumes in this same commit; a user/API/agent/limits pause is never
  // touched here. Goal row FOR UPDATE follows the session and turn locks above,
  // the order the claim transaction uses.
  const goalAutoResumed = await autoResumeGoalPausedByCapInTransaction(db, {
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    cause: { kind: "human_prompt", turnId },
    now,
  });
  if (goalAutoResumed) {
    eventValues.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: ++sequence,
      type: "goal.resumed",
      payload: goalAutoResumed.payload,
      occurredAt: now,
    });
  }

  const ordered =
    input.delivery === "steer" ? [turn, ...existingQueued] : [...existingQueued, turn];
  await normalizeQueuePositions(
    db,
    input.workspaceId,
    input.sessionId,
    ordered.map((row) => row.id),
  );
  const noCurrentAfter =
    input.delivery === "steer" ? liveCurrentTurnId === null : !session.activeTurnId;
  const nextStatus = noCurrentAfter ? "queued" : session.status;
  if (nextStatus !== session.status) {
    eventValues.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: ++sequence,
      type: "session.status.changed",
      payload: { status: nextStatus },
      occurredAt: now,
    });
  }
  const eventRows = await db
    .insert(schema.sessionEvents)
    .values(withLosslessContentWriteVersion(eventValues, "payload", "payloadCodecVersion"))
    .returning();
  if (input.actor.type === "human") {
    const realtimeRouting =
      input.delivery === "steer"
        ? "accepted_for_steering"
        : session.activeTurnId || existingQueued.length > 0
          ? "queued_for_execution"
          : "accepted_for_execution";
    await mirrorSessionRealtimeContextInTransaction(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sourceKind: "human_input",
      sourceId: acceptedEventId,
      turnId,
      channel: null,
      text: renderRealtimeHumanInputContext({
        delivery: input.delivery,
        routing: realtimeRouting,
        text: renderTimelineAnnotationsForModel(input.text, annotations),
      }),
      payload: {
        delivery: input.delivery,
        routing: realtimeRouting,
        acceptedEventId,
        instruction: "OpenGeni accepted and routed this user input; do not delegate it again.",
      },
      now,
    });
  }
  const queueVersion = session.queueVersion + 1;
  await db
    .update(schema.sessions)
    .set({
      resources: mergeResourceRefs(session.resources as ResourceRef[], input.resources),
      tools: session.tools,
      activeTurnId: input.delivery === "steer" ? liveCurrentTurnId : session.activeTurnId,
      status: nextStatus,
      queueVersion,
      queueHeadPosition: 0,
      queueTailPosition: ordered.length,
      lastSequence: sequence,
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, input.sessionId));
  const [nextDraft] = draft
    ? await db
        .update(schema.composerDrafts)
        .set({
          revision: draft.revision + 1,
          text: "",
          annotations: [],
          resources: [],
          tools: [],
          toolsProvided: false,
          sourceTurnId: null,
          sourceTurnVersion: null,
          updatedAt: now,
        })
        .where(eq(schema.composerDrafts.id, draft.id))
        .returning()
    : [undefined];
  if (draft && !nextDraft) {
    throw new SessionControlInvariantError("Accepted composer draft did not rotate");
  }
  const wakeRevision = await registerSessionWorkflowWakeInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    temporalWorkflowId: workflowId,
    reason: input.delivery === "steer" ? "prompt_steer" : "prompt_send",
    controlRequested: input.delivery === "steer",
  });
  await db.insert(schema.auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId:
          input.actor.type === "agent_attempt"
            ? `attempt:${input.actor.attemptId}`
            : input.actor.subjectId,
        action: input.delivery === "steer" ? "session.prompt.steer" : "session.prompt.send",
        targetType: "session_turn",
        targetId: turnId,
        metadata: {
          operationId: reserved.receipt.id,
          replacedTurnId,
          interruptionCount,
          ...(input.turnExecutionPolicy
            ? turnExecutionPolicyAuditMetadata(input.turnExecutionPolicy, turnId)
            : {}),
        },
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
  if (input.recordAgentRunUsage) {
    await db
      .insert(schema.usageEvents)
      .values({
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: input.subjectId,
        eventType: "agent_run.created",
        quantity: 1,
        unit: "run",
        sourceResourceType: "session_turn",
        sourceResourceId: turnId,
        sessionId: input.sessionId,
        turnId,
        ...initiatorColumns(frozenInitiator),
        origin: input.source,
        idempotencyKey: `agent_run.created:${input.workspaceId}:${turnId}`,
        occurredAt: now,
      })
      .onConflictDoNothing({ target: schema.usageEvents.idempotencyKey });
  }
  const eventIds = eventRows.map((event) => event.id);
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    controlRevision: resumed.revision,
    queueVersion,
    turnVersion: turn.version,
    ...(nextDraft ? { draftRevision: nextDraft.revision } : {}),
    result: {
      turnId,
      acceptedEventId,
      eventIds,
      wakeRevision,
      interruptionCount,
      replacedTurnId,
      workspaceControlEventId: resumed.workspaceControlEventId,
      ...(input.turnExecutionPolicy
        ? {
            executionPolicy: turnExecutionPolicyAuditMetadata(input.turnExecutionPolicy, turnId),
          }
        : {}),
    },
  });
  const events = eventRows.map(mapSubmittedPromptEvent);
  const accepted = events.find((event) => event.id === acceptedEventId);
  if (!accepted) {
    throw new SessionControlInvariantError("Inserted user.message event is missing");
  }
  return {
    receipt,
    queueVersion,
    accepted,
    events,
    turn: mapSubmittedPromptTurn(committedTurn),
    draft: nextDraft ?? null,
    acceptedEventId,
    eventIds,
    turnId,
    wakeRevision,
    interruptionCount,
    workspaceControlEventId: resumed.workspaceControlEventId,
    replay: false,
  };
}

export async function sendAgentMessageInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    targetSessionId: string;
    actor: Extract<SessionCommandActor, { type: "agent_attempt" }>;
    operationKey: string;
    text: string;
    /**
     * Bound the workspace control prefix wait (request-scoped API callers pass
     * `workspaceControlRequestLockTimeoutMs()`); omit for lifecycle callers.
     */
    controlLockTimeoutMs?: number;
  },
): Promise<AgentInternalUpdateCommandResult> {
  const workspaceControl = await lockWorkspaceInferenceControl(db, input.workspaceId, "share", {
    ...(input.controlLockTimeoutMs !== undefined
      ? { lockTimeoutMs: input.controlLockTimeoutMs }
      : {}),
  });
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    sessionIds: [input.actor.sessionId, input.targetSessionId],
    turnIds: [input.actor.turnId],
    attemptIds: [input.actor.attemptId],
  });
  const requestHash = canonicalSessionCommandHash({ text: input.text });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "agent.message",
    targetSessionId: input.targetSessionId,
    targetTurnId: null,
    operationKey: input.operationKey,
    canonicalRequestHash: requestHash,
  });
  if (reserved.replay) {
    const updateId = String(reserved.receipt.result.updateId ?? "");
    const workflowId = String(reserved.receipt.result.workflowId ?? "");
    if (!updateId || !workflowId) {
      throw new SessionControlInvariantError("Replayed Agent message receipt is incomplete");
    }
    return {
      receipt: reserved.receipt,
      updateId,
      eventIds: Array.isArray(reserved.receipt.result.eventIds)
        ? reserved.receipt.result.eventIds.filter((id): id is string => typeof id === "string")
        : [],
      wakeRevision:
        typeof reserved.receipt.result.wakeRevision === "number"
          ? reserved.receipt.result.wakeRevision
          : null,
      shouldSignal: false,
      workflowId,
      effectiveState: reserved.receipt.result.effectiveState === "paused" ? "paused" : "active",
      interruptionCount: 0,
      workspaceControlEventId: null,
      replay: true,
    };
  }
  await assertAgentCommandAuthorityInTransaction(db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    targetSessionId: input.targetSessionId,
    action: "message",
  });
  const inheritedConnectionAuthority = await personalConnectionDelegationsForAgentActor(
    db,
    input.workspaceId,
    input.actor,
    input.targetSessionId,
  );
  const personalConnectionDelegations = inheritedConnectionAuthority.delegations;
  const xaiAuthority = await xaiAuthorityForAgentActor(db, input.workspaceId, input.actor);
  const session = await lockSession(db, input.workspaceId, input.targetSessionId);
  if (session.status === "cancelled") {
    throw new QueueCommandConflictError(
      "QUEUE_PROMPT_STARTED",
      "Cancelled session cannot accept an Agent message",
      { queueVersion: session.queueVersion },
    );
  }
  const effective = await evaluateSessionControl(db, input.workspaceId, input.targetSessionId, {
    workspaceControl,
  });
  const realtimeActive = await sessionRealtimeIsActiveInTransaction(
    db,
    input.workspaceId,
    input.targetSessionId,
  );
  const now = new Date();
  const [update] = await db
    .insert(schema.sessionSystemUpdates)
    .values(
      withLosslessContentWriteVersion(
        withLosslessContentWriteVersion(
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.targetSessionId,
            kind: "agent_message",
            classification: "info",
            sourceId: input.actor.sessionId,
            dedupeKey: `agent-message:${reserved.receipt.id}`,
            summary: input.text,
            payload: {
              type: "agent_message",
              text: input.text,
              operationId: reserved.receipt.id,
            },
            lineage: {
              callerSessionId: input.actor.sessionId,
              callerTurnId: input.actor.turnId,
              callerAttemptId: input.actor.attemptId,
              callerExecutionGeneration: input.actor.executionGeneration,
              ...(inheritedConnectionAuthority.connectionAuthoritySubjectId
                ? {
                    connectionAuthoritySubjectId:
                      inheritedConnectionAuthority.connectionAuthoritySubjectId,
                  }
                : {}),
              ...(xaiAuthority.subjectId ? { xaiAuthoritySubjectId: xaiAuthority.subjectId } : {}),
            },
            personalConnectionDelegations,
            xaiProviderAccountAuthoritySnapshot: xaiAuthority.snapshot,
            state: "pending",
          },
          "summary",
          "summaryCodecVersion",
        ),
        "payload",
        "payloadCodecVersion",
      ),
    )
    .returning({ id: schema.sessionSystemUpdates.id });
  if (!update) throw new SessionControlInvariantError("Agent message was not inserted");
  // An Agent message is external input for the target's goal. A goal paused
  // only by its continuation ceiling (`max_auto_continuations`, pacing rather
  // than intent) resumes in this same commit; any other pause stays. Goal row
  // FOR UPDATE follows the session lock above, the goal tools' order.
  const goalAutoResumed = await autoResumeGoalPausedByCapInTransaction(db, {
    workspaceId: input.workspaceId,
    sessionId: input.targetSessionId,
    cause: { kind: "agent_message", updateId: update.id },
    now,
  });
  const eventValues: SessionEventInsertWithPayload[] = [
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.targetSessionId,
      sequence: session.lastSequence + 1,
      type: "system.update.pending",
      payload: {
        updateId: update.id,
        kind: "agent_message",
        sourceSessionId: input.actor.sessionId,
      },
      occurredAt: now,
    },
    ...(goalAutoResumed
      ? [
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.targetSessionId,
            sequence: session.lastSequence + 2,
            type: "goal.resumed" as const,
            payload: goalAutoResumed.payload,
            occurredAt: now,
          },
        ]
      : []),
  ];
  const insertedEvents = await db
    .insert(schema.sessionEvents)
    .values(withLosslessContentWriteVersion(eventValues, "payload", "payloadCodecVersion"))
    .returning({ id: schema.sessionEvents.id });
  if (insertedEvents.length !== eventValues.length) {
    throw new SessionControlInvariantError("Agent message event was not inserted");
  }
  const eventIds = insertedEvents.map((event) => event.id);
  const workflowId = session.temporalWorkflowId ?? `session-${session.id}`;
  const runnable = !realtimeActive && session.activeTurnId === null && effective.state === "active";
  const wake = runnable
    ? await registerInternalUpdateWakeInTransaction(db, {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sessionId: input.targetSessionId,
        temporalWorkflowId: workflowId,
      })
    : null;
  await db
    .update(schema.sessions)
    .set({
      lastSequence: session.lastSequence + eventValues.length,
      ...(runnable ? { status: "queued" as const } : {}),
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, input.targetSessionId));
  await db.insert(schema.auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: `attempt:${input.actor.attemptId}`,
        action: "session.agent_message",
        targetType: "session",
        targetId: input.targetSessionId,
        metadata: {
          operationId: reserved.receipt.id,
          callerSessionId: input.actor.sessionId,
          callerTurnId: input.actor.turnId,
          callerAttemptId: input.actor.attemptId,
          callerExecutionGeneration: input.actor.executionGeneration,
        },
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    result: {
      updateId: update.id,
      eventIds,
      wakeRevision: wake?.wakeRevision ?? null,
      workflowId,
      effectiveState: effective.state,
    },
  });
  return {
    receipt,
    updateId: update.id,
    eventIds,
    wakeRevision: wake?.wakeRevision ?? null,
    shouldSignal: wake?.shouldSignal ?? false,
    workflowId,
    effectiveState: effective.state,
    interruptionCount: 0,
    workspaceControlEventId: null,
    replay: false,
  };
}

export async function steerAgentSessionInTransaction(
  db: SessionActivityDatabase,
  input: {
    accountId: string;
    workspaceId: string;
    targetSessionId: string;
    actor: Extract<SessionCommandActor, { type: "agent_attempt" }>;
    operationKey: string;
    instruction: string;
    /** Request-scoped callers bound the control prefix wait; lifecycle callers omit it. */
    controlLockTimeoutMs?: number;
  },
): Promise<AgentInternalUpdateCommandResult> {
  const admission = await lockWorkspaceInferenceControlForAdmission(db, {
    workspaceId: input.workspaceId,
    sessionId: input.targetSessionId,
    ...(input.controlLockTimeoutMs !== undefined
      ? { lockTimeoutMs: input.controlLockTimeoutMs }
      : {}),
  });
  await lockSessionEventWriteRows(db, {
    workspaceId: input.workspaceId,
    controlLock: "already_locked",
    sessionIds: [input.actor.sessionId, input.targetSessionId],
    turnIds: [input.actor.turnId],
    attemptIds: [input.actor.attemptId],
  });
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "agent.steer",
    targetSessionId: input.targetSessionId,
    targetTurnId: null,
    operationKey: input.operationKey,
    canonicalRequestHash: canonicalSessionCommandHash({
      instruction: input.instruction,
    }),
  });
  if (reserved.replay) {
    const updateId = String(reserved.receipt.result.updateId ?? "");
    const workflowId = String(reserved.receipt.result.workflowId ?? "");
    const wakeRevision = Number(reserved.receipt.result.wakeRevision ?? 0);
    if (!updateId || !workflowId || wakeRevision < 1) {
      throw new SessionControlInvariantError("Replayed Agent Steer receipt is incomplete");
    }
    return {
      receipt: reserved.receipt,
      updateId,
      eventIds: Array.isArray(reserved.receipt.result.eventIds)
        ? reserved.receipt.result.eventIds.filter((id): id is string => typeof id === "string")
        : [],
      wakeRevision,
      shouldSignal: false,
      workflowId,
      effectiveState: "active",
      interruptionCount: Number(reserved.receipt.result.interruptionCount ?? 0),
      workspaceControlEventId:
        typeof reserved.receipt.result.workspaceControlEventId === "string"
          ? reserved.receipt.result.workspaceControlEventId
          : null,
      replay: true,
    };
  }
  await lockSession(db, input.workspaceId, input.targetSessionId);
  await assertAgentCommandAuthorityInTransaction(db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    targetSessionId: input.targetSessionId,
    action: "steer",
  });
  const inheritedConnectionAuthority = await personalConnectionDelegationsForAgentActor(
    db,
    input.workspaceId,
    input.actor,
    input.targetSessionId,
  );
  const personalConnectionDelegations = inheritedConnectionAuthority.delegations;
  const xaiAuthority = await xaiAuthorityForAgentActor(db, input.workspaceId, input.actor);
  const resumed = await autoResumeSessionBranchInTransaction(db, {
    workspaceId: input.workspaceId,
    sessionId: input.targetSessionId,
    actor: `attempt:${input.actor.attemptId}`,
    reason: "agent_steer",
    admission,
  });
  const session = await lockSession(db, input.workspaceId, input.targetSessionId);
  if (session.status === "cancelled") {
    throw new QueueCommandConflictError(
      "QUEUE_PROMPT_STARTED",
      "Cancelled session cannot be Steered",
      { queueVersion: session.queueVersion },
    );
  }
  const now = new Date();
  const updateId = crypto.randomUUID();
  // An Agent Steer is external input for the target's goal. A goal paused only
  // by its continuation ceiling (`max_auto_continuations`, pacing rather than
  // intent) resumes here, before the supersession, so the Steer starts a fresh
  // continuation epoch; any other pause stays. Goal row FOR UPDATE follows the
  // session lock above; the `goal.resumed` fact is appended below at the next
  // sequence of this same commit.
  const goalAutoResumed = await autoResumeGoalPausedByCapInTransaction(db, {
    workspaceId: input.workspaceId,
    sessionId: input.targetSessionId,
    cause: { kind: "agent_steer_instruction", updateId },
    now,
  });
  const supersession = await supersedeSessionCurrentDirectionInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.targetSessionId,
    activeTurnId: session.activeTurnId,
    actor: input.actor,
    operationId: reserved.receipt.id,
    controlRevision: resumed.revision,
    lastSequence: session.lastSequence,
  });
  const supersededUpdates = await db
    .update(schema.sessionSystemUpdates)
    .set({ state: "superseded" })
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, input.workspaceId),
        eq(schema.sessionSystemUpdates.sessionId, input.targetSessionId),
        eq(schema.sessionSystemUpdates.kind, "agent_steer_instruction"),
        eq(schema.sessionSystemUpdates.state, "pending"),
      ),
    )
    .returning({ id: schema.sessionSystemUpdates.id });
  const [update] = await db
    .insert(schema.sessionSystemUpdates)
    .values(
      withLosslessContentWriteVersion(
        withLosslessContentWriteVersion(
          {
            id: updateId,
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.targetSessionId,
            kind: "agent_steer_instruction",
            classification: "action_required",
            sourceId: input.actor.sessionId,
            dedupeKey: `agent-steer:${reserved.receipt.id}`,
            summary: input.instruction,
            payload: {
              type: "agent_steer_instruction",
              instruction: input.instruction,
              operationId: reserved.receipt.id,
            },
            lineage: {
              callerSessionId: input.actor.sessionId,
              callerTurnId: input.actor.turnId,
              callerAttemptId: input.actor.attemptId,
              callerExecutionGeneration: input.actor.executionGeneration,
              ...(inheritedConnectionAuthority.connectionAuthoritySubjectId
                ? {
                    connectionAuthoritySubjectId:
                      inheritedConnectionAuthority.connectionAuthoritySubjectId,
                  }
                : {}),
              ...(xaiAuthority.subjectId ? { xaiAuthoritySubjectId: xaiAuthority.subjectId } : {}),
            },
            personalConnectionDelegations,
            xaiProviderAccountAuthoritySnapshot: xaiAuthority.snapshot,
            state: "pending",
          },
          "summary",
          "summaryCodecVersion",
        ),
        "payload",
        "payloadCodecVersion",
      ),
    )
    .returning({ id: schema.sessionSystemUpdates.id });
  if (!update) throw new SessionControlInvariantError("Agent Steer instruction was not inserted");
  let sequence = supersession.lastSequence;
  const events: SessionEventInsertWithPayload[] = [];
  if (supersession.replacedTurn && !supersession.liveCurrentTurnId) {
    events.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.targetSessionId,
      sequence: ++sequence,
      type: "turn.superseded",
      turnId: supersession.replacedTurn.id,
      payload: { reason: "agent_steer", targetUpdateId: update.id },
      occurredAt: now,
    });
  }
  events.push(
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.targetSessionId,
      sequence: ++sequence,
      type: "session.control.steer_requested",
      turnId: supersession.replacedTurn?.id ?? null,
      turnGeneration: supersession.replacedTurn?.executionGeneration ?? null,
      turnAttemptId: supersession.replacedTurn?.activeAttemptId ?? null,
      turnAssociation: supersession.replacedTurn ? "current" : null,
      payload: {
        operationId: reserved.receipt.id,
        targetUpdateId: update.id,
        replacedTurnId: supersession.replacedTurn?.id ?? null,
        actorSessionId: input.actor.sessionId,
        stopping: supersession.liveCurrentTurnId !== null,
      },
      occurredAt: now,
    },
    ...(supersededUpdates.length > 0
      ? [
          {
            accountId: input.accountId,
            workspaceId: input.workspaceId,
            sessionId: input.targetSessionId,
            sequence: ++sequence,
            type: "system.update.superseded" as const,
            payload: {
              updateIds: supersededUpdates.map((entry) => entry.id),
              count: supersededUpdates.length,
              replacementUpdateId: update.id,
              reason: "newer_agent_steer",
            },
            occurredAt: now,
          },
        ]
      : []),
    {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.targetSessionId,
      sequence: ++sequence,
      type: "system.update.pending",
      payload: {
        updateId: update.id,
        kind: "agent_steer_instruction",
        sourceSessionId: input.actor.sessionId,
      },
      occurredAt: now,
    },
  );
  if (goalAutoResumed) {
    events.push({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.targetSessionId,
      sequence: ++sequence,
      type: "goal.resumed",
      payload: goalAutoResumed.payload,
      occurredAt: now,
    });
  }
  const insertedEvents = await db
    .insert(schema.sessionEvents)
    .values(withLosslessContentWriteVersion(events, "payload", "payloadCodecVersion"))
    .returning({
      id: schema.sessionEvents.id,
    });
  const workflowId = session.temporalWorkflowId ?? `session-${session.id}`;
  const wakeRevision = await registerSessionWorkflowWakeInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.targetSessionId,
    temporalWorkflowId: workflowId,
    reason: "agent_steer",
    controlRequested: true,
  });
  await db
    .update(schema.sessions)
    .set({
      activeTurnId: supersession.liveCurrentTurnId,
      status: supersession.liveCurrentTurnId ? session.status : "queued",
      lastSequence: sequence,
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, input.targetSessionId));
  await db.insert(schema.auditEvents).values(
    withLosslessContentWriteVersion(
      {
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        subjectId: `attempt:${input.actor.attemptId}`,
        action: "session.agent_steer",
        targetType: "session",
        targetId: input.targetSessionId,
        metadata: {
          operationId: reserved.receipt.id,
          callerSessionId: input.actor.sessionId,
          callerTurnId: input.actor.turnId,
          callerAttemptId: input.actor.attemptId,
          callerExecutionGeneration: input.actor.executionGeneration,
          controlRevision: resumed.revision,
          interruptionCount: supersession.interruptionCount,
          workspaceControlEventId: resumed.workspaceControlEventId,
        },
      },
      "metadata",
      "metadataCodecVersion",
    ),
  );
  const eventIds = insertedEvents.map((event) => event.id);
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    controlRevision: resumed.revision,
    result: {
      updateId: update.id,
      eventIds,
      wakeRevision,
      workflowId,
      interruptionCount: supersession.interruptionCount,
    },
  });
  return {
    receipt,
    updateId: update.id,
    eventIds,
    wakeRevision,
    shouldSignal: true,
    workflowId,
    effectiveState: "active",
    interruptionCount: supersession.interruptionCount,
    workspaceControlEventId: resumed.workspaceControlEventId,
    replay: false,
  };
}
