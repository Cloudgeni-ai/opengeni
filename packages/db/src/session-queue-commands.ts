import {
  metadataWithTurnExecutionPolicyV1,
  mergeResourceRefs,
  mergeToolRefs,
  turnExecutionPolicyAuditMetadata,
  type ReasoningEffort,
  type ResourceRef,
  type ToolRef,
  type TurnExecutionPolicyV1,
} from "@opengeni/contracts";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./index";
import { closePendingSessionToolCallsInTransaction } from "./session-tool-call-settlement";
import {
  assertAgentCommandAuthorityInTransaction,
  autoResumeSessionBranchInTransaction,
  canonicalSessionCommandHash,
  evaluateSessionControl,
  lockWorkspaceInferenceControl,
  registerInternalUpdateWakeInTransaction,
  reserveSessionCommandReceipt,
  registerSessionWorkflowWakeInTransaction,
  type SessionCommandActor,
  type SessionCommandReceiptRow,
  SessionControlConflictError,
  SessionControlInvariantError,
  updateSessionCommandReceiptResult,
} from "./session-control";
import * as schema from "./schema";

export type QueueCommandConflictCode =
  | "QUEUE_VERSION_CHANGED"
  | "QUEUE_PROMPT_STARTED"
  | "QUEUE_ANCHOR_CHANGED"
  | "PROMPT_CHANGED"
  | "DRAFT_CHANGED"
  | "DRAFT_NOT_EMPTY";

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
  acceptedEventId: string;
  eventIds: string[];
  turnId: string;
  wakeRevision: number;
  interruptionCount: number;
  workspaceControlEventId: string | null;
  replay: boolean;
};

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

async function lockSession(
  db: Database,
  workspaceId: string,
  sessionId: string,
): Promise<typeof schema.sessions.$inferSelect> {
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(and(eq(schema.sessions.workspaceId, workspaceId), eq(schema.sessions.id, sessionId)))
    .for("update")
    .limit(1);
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
  const [current] = await db
    .select()
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        eq(schema.sessionTurns.id, input.activeTurnId),
      ),
    )
    .for("update")
    .limit(1);
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
  const closedTools = await closePendingSessionToolCallsInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    turnId: current.id,
    reason: "steer",
    sequence: input.lastSequence,
    now,
  });
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
  await db
    .update(schema.sessionSystemUpdates)
    .set({ state: "pending", deliveredTurnId: null, deliveredAt: null })
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, input.workspaceId),
        eq(schema.sessionSystemUpdates.sessionId, input.sessionId),
        eq(schema.sessionSystemUpdates.deliveredTurnId, current.id),
        eq(schema.sessionSystemUpdates.state, "delivered"),
      ),
    );
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
  }
  return {
    interruptionCount: 0,
    replacedTurn: current,
    liveCurrentTurnId: null,
    lastSequence: closedTools.sequence,
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
  return lock ? await query.for("update") : await query;
}

async function normalizeQueuePositions(
  db: Database,
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
    draft.resources.length > 0 ||
    draft.tools.length > 0 ||
    draft.sourceTurnId !== null
  );
}

export async function getComposerDraftInTransaction(
  db: Database,
  input: { workspaceId: string; sessionId: string; subjectId: string; lock?: boolean },
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
    resources: ResourceRef[];
    tools: ToolRef[];
    model: string;
    reasoningEffort: ReasoningEffort;
  },
): Promise<ComposerDraftRow> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share");
  await lockSession(db, input.workspaceId, input.sessionId);
  const current = await getComposerDraftInTransaction(db, { ...input, lock: true });
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
    resources: input.resources,
    tools: input.tools,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    sourceTurnId: null,
    sourceTurnVersion: null,
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
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    beforeTurnId: string | null;
    expectedQueueVersion: number;
    actor: SessionCommandActor;
    operationKey: string;
  },
): Promise<QueueCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share");
  const session = await lockSession(db, input.workspaceId, input.sessionId);
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
      .values({
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
      })
      .returning({ id: schema.sessionEvents.id });
    if (!event) throw new Error("Queue move event was not inserted");
    eventIds.push(event.id);
    await db
      .update(schema.sessions)
      .set({ queueVersion, lastSequence: session.lastSequence + 1, updatedAt: new Date() })
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
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedTurnVersion: number;
    actor: SessionCommandActor;
    operationKey: string;
    reason?: string | null;
  },
): Promise<QueueCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share");
  const session = await lockSession(db, input.workspaceId, input.sessionId);
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
  const [turn] = await db
    .select()
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        eq(schema.sessionTurns.id, input.turnId),
      ),
    )
    .for("update")
    .limit(1);
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
    .values({
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
    })
    .returning({ id: schema.sessionEvents.id });
  if (!event) throw new Error("Queue delete event was not inserted");
  await db
    .update(schema.sessions)
    .set({ queueVersion, lastSequence: session.lastSequence + 1, updatedAt: now })
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
  db: Database,
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
  },
): Promise<EditQueueCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share");
  const session = await lockSession(db, input.workspaceId, input.sessionId);
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
  const existingDraft = await getComposerDraftInTransaction(db, { ...input, lock: true });
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
  const [turn] = await db
    .select()
    .from(schema.sessionTurns)
    .where(
      and(
        eq(schema.sessionTurns.workspaceId, input.workspaceId),
        eq(schema.sessionTurns.sessionId, input.sessionId),
        eq(schema.sessionTurns.id, input.turnId),
      ),
    )
    .for("update")
    .limit(1);
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
  const nextDraftRevision = draftRevision + 1;
  const draftValues = {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    subjectId: input.subjectId,
    revision: nextDraftRevision,
    text: turn.prompt,
    resources: turn.resources,
    tools: turn.tools,
    model: turn.model,
    reasoningEffort: turn.reasoningEffort,
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
    .values({
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
    })
    .returning({ id: schema.sessionEvents.id });
  if (!event) throw new Error("Queue edit event was not inserted");
  await db
    .update(schema.sessions)
    .set({ queueVersion, lastSequence: session.lastSequence + 1, updatedAt: now })
    .where(eq(schema.sessions.id, input.sessionId));
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    queueVersion,
    turnVersion: turn.version + 1,
    draftRevision: nextDraftRevision,
    result: { sourceTurnId: turn.id },
  });
  return { receipt, queueVersion, items: remaining, draft, eventIds: [event.id], replay: false };
}

export async function steerQueuedTurnInTransaction(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    turnId: string;
    expectedTurnVersion: number;
    controlEtag?: string | null;
    actor: SessionCommandActor;
    operationKey: string;
  },
): Promise<SteerQueueCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "update");
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
  if (input.actor.type === "agent_attempt") {
    await assertAgentCommandAuthorityInTransaction(db, {
      workspaceId: input.workspaceId,
      actor: input.actor,
      targetSessionId: input.sessionId,
      action: "steer",
    });
  }
  const before = await evaluateSessionControl(db, input.workspaceId, input.sessionId, {
    lock: "share",
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
    .set({ version: target.version + 1, updatedAt: now })
    .where(eq(schema.sessionTurns.id, target.id));
  let sequence = supersession.lastSequence;
  const actor =
    input.actor.type === "agent_attempt"
      ? `attempt:${input.actor.attemptId}`
      : input.actor.subjectId;
  const eventValues: Array<typeof schema.sessionEvents.$inferInsert> = [];
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
  const eventRows = await db.insert(schema.sessionEvents).values(eventValues).returning({
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
  await db.insert(schema.auditEvents).values({
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
  });
  const wakeRevision = await registerSessionWorkflowWakeInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    temporalWorkflowId: session.temporalWorkflowId ?? `session-${input.sessionId}`,
    reason: "queue_steer",
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
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    sessionId: string;
    subjectId: string;
    actor: SessionCommandActor;
    operationKey: string;
    delivery: "send" | "steer";
    controlEtag?: string | null;
    expectedDraftRevision?: number | null;
    text: string;
    resources: ResourceRef[];
    tools: ToolRef[];
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    reasoningEffortFallback: ReasoningEffort;
    /** Trusted API/core admission snapshot. Omitted only by legacy low-level callers. */
    turnExecutionPolicy?: TurnExecutionPolicyV1;
    source: "user" | "api";
    mcpCredentialUpdates?: Array<{ id: string; headersEncrypted: Record<string, string> }>;
  },
): Promise<SubmitHumanPromptResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "update");
  const requestHash = canonicalSessionCommandHash({
    delivery: input.delivery,
    controlEtag: input.controlEtag ?? null,
    expectedDraftRevision: input.expectedDraftRevision ?? null,
    text: input.text,
    resources: input.resources,
    tools: input.tools,
    model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null,
    source: input.source,
    mcpCredentialUpdates: input.mcpCredentialUpdates ?? [],
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
    return {
      receipt: reserved.receipt,
      queueVersion: Number(reserved.receipt.appliedQueueVersion),
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
    lock: "share",
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
    reason: input.delivery === "steer" ? "human_steer" : "human_send",
    observedControlEtag: input.controlEtag ?? null,
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
        resources: draft.resources,
        tools: draft.tools,
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
      }) !==
        canonicalSessionCommandHash({
          text: input.text,
          resources: input.resources,
          tools: input.tools,
          model: input.model ?? session.model,
          reasoningEffort: input.reasoningEffort ?? input.reasoningEffortFallback,
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
  const acceptedEventId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const workflowId = session.temporalWorkflowId ?? `session-${session.id}`;
  let sequence = session.lastSequence;
  const eventValues: Array<typeof schema.sessionEvents.$inferInsert> = [
    {
      id: acceptedEventId,
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sequence: ++sequence,
      type: "user.message",
      clientEventId: input.operationKey,
      payload: {
        text: input.text,
        ...(input.resources.length ? { resources: input.resources } : {}),
        ...(input.tools.length ? { tools: input.tools } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
        delivery: input.delivery,
      },
      occurredAt: now,
    },
  ];
  const existingQueued = await loadQueuedTurns(db, input.workspaceId, input.sessionId, true);
  const [turn] = await db
    .insert(schema.sessionTurns)
    .values({
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
      resources: input.resources,
      tools: input.tools,
      model: input.model ?? session.model,
      reasoningEffort: input.reasoningEffort ?? input.reasoningEffortFallback,
      sandboxBackend: session.sandboxBackend,
      metadata: input.turnExecutionPolicy
        ? metadataWithTurnExecutionPolicyV1({}, input.turnExecutionPolicy)
        : {},
      lineage: { actor: input.actor.type },
    })
    .returning();
  if (!turn) throw new SessionControlInvariantError("Prompt turn was not inserted");
  eventValues.push({
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sequence: ++sequence,
    type: "turn.queued",
    turnId,
    payload: { turnId, triggerEventId: acceptedEventId, source: input.source },
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
  const liveCurrentTurnId = supersession.liveCurrentTurnId;
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
  const eventRows = await db.insert(schema.sessionEvents).values(eventValues).returning();
  const queueVersion = session.queueVersion + 1;
  await db
    .update(schema.sessions)
    .set({
      resources: mergeResourceRefs(session.resources as ResourceRef[], input.resources),
      tools: mergeToolRefs(session.tools as ToolRef[], input.tools),
      activeTurnId: input.delivery === "steer" ? liveCurrentTurnId : session.activeTurnId,
      status: nextStatus,
      queueVersion,
      queueHeadPosition: 0,
      queueTailPosition: ordered.length,
      lastSequence: sequence,
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, input.sessionId));
  if (draft) {
    await db.delete(schema.composerDrafts).where(eq(schema.composerDrafts.id, draft.id));
  }
  const wakeRevision = await registerSessionWorkflowWakeInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    temporalWorkflowId: workflowId,
    reason: input.delivery === "steer" ? "prompt_steer" : "prompt_send",
  });
  await db.insert(schema.auditEvents).values({
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
  });
  const eventIds = eventRows.map((event) => event.id);
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    controlRevision: resumed.revision,
    queueVersion,
    turnVersion: turn.version,
    ...(draft ? { draftRevision: draft.revision } : {}),
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
            executionPolicy: turnExecutionPolicyAuditMetadata(
              input.turnExecutionPolicy,
              turnId,
            ),
          }
        : {}),
    },
  });
  return {
    receipt,
    queueVersion,
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
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    targetSessionId: string;
    actor: Extract<SessionCommandActor, { type: "agent_attempt" }>;
    operationKey: string;
    text: string;
  },
): Promise<AgentInternalUpdateCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "share");
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
  const session = await lockSession(db, input.workspaceId, input.targetSessionId);
  if (session.status === "cancelled") {
    throw new QueueCommandConflictError(
      "QUEUE_PROMPT_STARTED",
      "Cancelled session cannot accept an Agent message",
      { queueVersion: session.queueVersion },
    );
  }
  const effective = await evaluateSessionControl(db, input.workspaceId, input.targetSessionId, {
    lock: "share",
  });
  const now = new Date();
  const [update] = await db
    .insert(schema.sessionSystemUpdates)
    .values({
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
      },
      state: "pending",
    })
    .returning({ id: schema.sessionSystemUpdates.id });
  if (!update) throw new SessionControlInvariantError("Agent message was not inserted");
  const [event] = await db
    .insert(schema.sessionEvents)
    .values({
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
    })
    .returning({ id: schema.sessionEvents.id });
  if (!event) throw new SessionControlInvariantError("Agent message event was not inserted");
  const workflowId = session.temporalWorkflowId ?? `session-${session.id}`;
  const runnable = session.activeTurnId === null && effective.state === "active";
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
      lastSequence: session.lastSequence + 1,
      ...(runnable ? { status: "queued" as const } : {}),
      updatedAt: now,
    })
    .where(eq(schema.sessions.id, input.targetSessionId));
  await db.insert(schema.auditEvents).values({
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
  });
  const receipt = await updateSessionCommandReceiptResult(db, reserved.receipt.id, {
    result: {
      updateId: update.id,
      eventIds: [event.id],
      wakeRevision: wake?.wakeRevision ?? null,
      workflowId,
      effectiveState: effective.state,
    },
  });
  return {
    receipt,
    updateId: update.id,
    eventIds: [event.id],
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
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    targetSessionId: string;
    actor: Extract<SessionCommandActor, { type: "agent_attempt" }>;
    operationKey: string;
    instruction: string;
  },
): Promise<AgentInternalUpdateCommandResult> {
  await lockWorkspaceInferenceControl(db, input.workspaceId, "update");
  const reserved = await reserveSessionCommandReceipt(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    actor: input.actor,
    action: "agent.steer",
    targetSessionId: input.targetSessionId,
    targetTurnId: null,
    operationKey: input.operationKey,
    canonicalRequestHash: canonicalSessionCommandHash({ instruction: input.instruction }),
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
  await assertAgentCommandAuthorityInTransaction(db, {
    workspaceId: input.workspaceId,
    actor: input.actor,
    targetSessionId: input.targetSessionId,
    action: "steer",
  });
  const resumed = await autoResumeSessionBranchInTransaction(db, {
    workspaceId: input.workspaceId,
    sessionId: input.targetSessionId,
    actor: `attempt:${input.actor.attemptId}`,
    reason: "agent_steer",
  });
  const session = await lockSession(db, input.workspaceId, input.targetSessionId);
  if (session.status === "cancelled") {
    throw new QueueCommandConflictError(
      "QUEUE_PROMPT_STARTED",
      "Cancelled session cannot be Steered",
      { queueVersion: session.queueVersion },
    );
  }
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
  await db
    .update(schema.sessionSystemUpdates)
    .set({ state: "superseded" })
    .where(
      and(
        eq(schema.sessionSystemUpdates.workspaceId, input.workspaceId),
        eq(schema.sessionSystemUpdates.sessionId, input.targetSessionId),
        eq(schema.sessionSystemUpdates.kind, "agent_steer_instruction"),
        inArray(schema.sessionSystemUpdates.state, ["pending", "deferred"]),
      ),
    );
  const now = new Date();
  const [update] = await db
    .insert(schema.sessionSystemUpdates)
    .values({
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
      },
      state: "pending",
    })
    .returning({ id: schema.sessionSystemUpdates.id });
  if (!update) throw new SessionControlInvariantError("Agent Steer instruction was not inserted");
  let sequence = supersession.lastSequence;
  const events: Array<typeof schema.sessionEvents.$inferInsert> = [];
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
  const insertedEvents = await db.insert(schema.sessionEvents).values(events).returning({
    id: schema.sessionEvents.id,
  });
  const workflowId = session.temporalWorkflowId ?? `session-${session.id}`;
  const wakeRevision = await registerSessionWorkflowWakeInTransaction(db, {
    accountId: input.accountId,
    workspaceId: input.workspaceId,
    sessionId: input.targetSessionId,
    temporalWorkflowId: workflowId,
    reason: "agent_steer",
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
  await db.insert(schema.auditEvents).values({
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
  });
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
