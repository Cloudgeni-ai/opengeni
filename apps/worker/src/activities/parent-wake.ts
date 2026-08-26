import type { Settings } from "@opengeni/config";
import type { Session, SessionGoal, SessionSystemUpdatePayload } from "@opengeni/contracts";
import {
  getSession,
  getSessionGoal,
  getSessionParentPersonalConnectionDelegations,
  getSessionParentXaiProviderAccountAuthority,
  addSessionSystemUpdateWithSourceMutation,
  claimPendingSessionSystemUpdateOutbox,
  claimPendingSessionWorkflowWakes,
  childRequiresActionDedupeKey,
  getSessionSystemUpdateOutboxByDedupeKey,
  getOrCreateSessionSystemUpdateOutbox,
  claimAutomaticSessionTitleFanout,
  markSessionWorkflowWakeFailed,
  markSessionSystemUpdateOutboxDeliveredInTransaction,
  markSessionSystemUpdateOutboxFailed,
  markAutomaticSessionTitleFanoutDelivered,
  markAutomaticSessionTitleFanoutFailed,
  sessionSystemUpdateOutboxKindPayload,
  type Database,
  type SessionSystemUpdateOutboxDelivery,
} from "@opengeni/db";
import { requireSessionEventDurableFanoutCapability, type EventBus } from "@opengeni/events";
import type { ActivityServices, WakeSessionWorkflowSignal } from "./types";

export type NotifyServices = {
  db: Database;
  bus: EventBus;
  settings: Settings;
  observability: ActivityServices["observability"];
  wakeSessionWorkflow: WakeSessionWorkflowSignal | null;
};

export type ReconcileParentSystemUpdateOverrides = Partial<{
  claimPendingSessionSystemUpdateOutbox: typeof claimPendingSessionSystemUpdateOutbox;
}>;

export type ReconcileSessionWorkflowWakeOverrides = Partial<{
  claimPendingSessionWorkflowWakes: typeof claimPendingSessionWorkflowWakes;
}>;

export type ReconcileAutomaticSessionTitleFanoutOverrides = Partial<{
  claimAutomaticSessionTitleFanout: typeof claimAutomaticSessionTitleFanout;
  markAutomaticSessionTitleFanoutDelivered: typeof markAutomaticSessionTitleFanoutDelivered;
  markAutomaticSessionTitleFanoutFailed: typeof markAutomaticSessionTitleFanoutFailed;
}>;

/**
 * Enrich and deliver the durable idle-boundary row committed by
 * settleSessionIdleWithParentOutbox. Idle has no single owning turn, so its
 * stable episode identity is the newest non-status event sequence.
 */
export async function notifyParentOfChildIdle(
  svc: NotifyServices,
  workspaceId: string,
  childSessionId: string,
  episodeKey: string,
): Promise<void> {
  try {
    const child = await getSession(svc.db, workspaceId, childSessionId);
    if (!child || !child.parentSessionId) {
      return;
    }
    const goal = await getSessionGoal(svc.db, workspaceId, childSessionId);
    // Sacred user pause: if the MANAGER's own goal was paused by the user, the
    // wake must not tell it to "resume it now" — that instruction is exactly
    // what re-arms the loop the user just stopped. Suppress the resume nudge and
    // tell the agent to stay paused. Paired with the goal_set reactivation
    // guard so a nudge that slips through still cannot revive the goal.
    const clientEventId = `child-completion:${childSessionId}:${episodeKey}`;
    const payload = childCompletionPayload(child, goal);
    const personalConnectionDelegations = await getSessionParentPersonalConnectionDelegations(
      svc.db,
      workspaceId,
      childSessionId,
    );
    const xaiAuthority = await getSessionParentXaiProviderAccountAuthority(
      svc.db,
      workspaceId,
      childSessionId,
    );
    const outbox = await getOrCreateSessionSystemUpdateOutbox(svc.db, {
      accountId: child.accountId,
      workspaceId,
      sourceSessionId: child.id,
      targetSessionId: child.parentSessionId,
      kind: "child_terminal_result",
      classification: goal?.status === "paused" ? "action_required" : "success",
      sourceId: child.id,
      dedupeKey: clientEventId,
      summary: childCompletionSummary(child, goal, "idle"),
      payload,
      lineage: {
        childSessionId: child.id,
        parentSessionId: child.parentSessionId,
        ...(xaiAuthority.subjectId ? { xaiAuthoritySubjectId: xaiAuthority.subjectId } : {}),
      },
      personalConnectionDelegations,
      xaiProviderAccountAuthoritySnapshot: xaiAuthority.snapshot,
    });
    if (outbox.status === "delivered") {
      return;
    }
    await deliverParentSystemUpdateOutbox(svc, outbox);
  } catch (error) {
    // A durable pending outbox row survives this boundary. The global worker
    // reaper retries it; child terminal settlement never depends on this turn.
    svc.observability.error("Failed to wake parent session on worker idle boundary", {
      childSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Deliver one exact child-lifecycle outbox row already committed by the
 * child's own lifecycle transaction (turn failure, requires_action freeze,
 * ...). This layer deliberately cannot create or rewrite the row: the
 * producing transaction is the sole owner of its payload and lineage, and the
 * global reconciler remains the recovery path if immediate delivery fails.
 */
export async function deliverChildLifecycleOutboxToParent(
  svc: NotifyServices,
  workspaceId: string,
  childSessionId: string,
  dedupeKey: string,
  options: { requireRow?: boolean } = {},
): Promise<void> {
  try {
    const child = await getSession(svc.db, workspaceId, childSessionId);
    if (!child || !child.parentSessionId) return;
    const outbox = await getSessionSystemUpdateOutboxByDedupeKey(svc.db, {
      accountId: child.accountId,
      workspaceId,
      dedupeKey,
    });
    if (!outbox) {
      if (options.requireRow === false) return;
      throw new Error(`Committed child-lifecycle outbox disappeared: ${dedupeKey}`);
    }
    if (outbox.status === "delivered") return;
    await deliverParentSystemUpdateOutbox(svc, outbox);
  } catch (error) {
    svc.observability.error("Failed to deliver committed child-lifecycle notice", {
      childSessionId,
      dedupeKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Deliver the exact failure row already committed by turn settlement. This
 * layer deliberately cannot create or rewrite the row: the settlement
 * transaction is the sole owner of the failed turn id, payload, and lineage.
 */
export async function deliverFailedChildTurnToParent(
  svc: NotifyServices,
  workspaceId: string,
  childSessionId: string,
  turnId: string,
): Promise<void> {
  await deliverChildLifecycleOutboxToParent(
    svc,
    workspaceId,
    childSessionId,
    `child-completion:${childSessionId}:turn:${turnId}`,
  );
}

/**
 * Deliver the child_requires_action notice a requires_action settlement
 * committed for this exact (child, turn, generation). When the rollout flag is
 * off no row exists and this is a no-op; the reaper covers crashes after commit.
 */
export async function deliverChildRequiresActionToParent(
  svc: NotifyServices,
  workspaceId: string,
  childSessionId: string,
  input: { turnId: string; turnGeneration: number },
): Promise<void> {
  if (!svc.settings.childLifecycleNoticesEnabled) return;
  await deliverChildLifecycleOutboxToParent(
    svc,
    workspaceId,
    childSessionId,
    childRequiresActionDedupeKey({
      childSessionId,
      turnId: input.turnId,
      turnGeneration: input.turnGeneration,
    }),
    // A requires_action freeze without any human-input/approval request (or a
    // child without a parent) commits no row; that is not an error.
    { requireRow: false },
  );
}

async function deliverParentSystemUpdateOutbox(
  svc: NotifyServices,
  outbox: SessionSystemUpdateOutboxDelivery,
): Promise<void> {
  try {
    const result = await addSessionSystemUpdateWithSourceMutation(
      svc.db,
      {
        accountId: outbox.accountId,
        workspaceId: outbox.workspaceId,
        sessionId: outbox.targetSessionId,
        ...sessionSystemUpdateOutboxKindPayload(outbox),
        classification: outbox.classification,
        sourceId: outbox.sourceId,
        dedupeKey: outbox.dedupeKey,
        summary: outbox.summary,
        lineage: outbox.lineage,
        personalConnectionDelegations: outbox.personalConnectionDelegations,
        xaiProviderAccountAuthoritySnapshot: outbox.xaiProviderAccountAuthoritySnapshot,
      },
      async (tx) => {
        await markSessionSystemUpdateOutboxDeliveredInTransaction(tx, outbox);
      },
    );
    if (result.reason === "session_cancelled") {
      return;
    }
    if (result.added && result.events.length > 0) {
      await svc.bus.publish(outbox.workspaceId, outbox.targetSessionId, result.events);
    }
    if (result.shouldWake && svc.wakeSessionWorkflow) {
      if (result.workflowWakeRevision === null) {
        throw new Error("Runnable system update has no workflow wake revision");
      }
      await svc.wakeSessionWorkflow({
        accountId: outbox.accountId,
        workspaceId: outbox.workspaceId,
        sessionId: outbox.targetSessionId,
        workflowId: result.temporalWorkflowId ?? `session-${outbox.targetSessionId}`,
        wakeRevision: result.workflowWakeRevision,
      });
    }
    svc.observability.info("Delivered child lifecycle notice to parent session", {
      childSessionId: outbox.sourceSessionId,
      parentSessionId: outbox.targetSessionId,
      kind: outbox.kind,
      dedupeKey: outbox.dedupeKey,
      woke: result.shouldWake,
    });
  } catch (error) {
    await markSessionSystemUpdateOutboxFailed(
      svc.db,
      outbox,
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    throw error;
  }
}

export async function reconcilePendingParentSystemUpdates(
  svc: NotifyServices,
  limit = 100,
  overrides: ReconcileParentSystemUpdateOverrides = {},
): Promise<{ claimed: number; delivered: number; failed: number }> {
  const claimPendingSessionSystemUpdateOutboxFn =
    overrides.claimPendingSessionSystemUpdateOutbox ?? claimPendingSessionSystemUpdateOutbox;
  const rows = await claimPendingSessionSystemUpdateOutboxFn(svc.db, limit);
  let delivered = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await deliverParentSystemUpdateOutbox(svc, row);
      delivered += 1;
    } catch {
      failed += 1;
    }
  }
  return { claimed: rows.length, delivered, failed };
}

/**
 * Publish migration-created safe title events through the configured session
 * event bus. The outbox is durable and deployment-global; a crash after publish
 * but before acknowledgement can duplicate a notification, which is safe
 * because SSE consumers sequence-fence and gap-fill from the durable log.
 *
 * Managed NATS exposes the stronger bounded flush acknowledgement through
 * publishConfirmed. Embedding buses predate that optional capability, so their
 * required publish promise remains the delivery acknowledgement: resolve only
 * after accepting the batch, and reject a real transport failure so the durable
 * row stays retryable. Every supported bus also provides the mandatory paired
 * recovery capability used by API SSE streams after subscriber reconnect.
 */
export async function reconcileAutomaticSessionTitleFanout(
  svc: NotifyServices,
  limit = 100,
  overrides: ReconcileAutomaticSessionTitleFanoutOverrides = {},
): Promise<{ claimed: number; delivered: number; failed: number }> {
  requireSessionEventDurableFanoutCapability(svc.bus);
  const claim = overrides.claimAutomaticSessionTitleFanout ?? claimAutomaticSessionTitleFanout;
  const markDelivered =
    overrides.markAutomaticSessionTitleFanoutDelivered ?? markAutomaticSessionTitleFanoutDelivered;
  const markFailed =
    overrides.markAutomaticSessionTitleFanoutFailed ?? markAutomaticSessionTitleFanoutFailed;
  const rows = await claim(svc.db, limit);
  let delivered = 0;
  let failed = 0;
  const queue = [...rows];
  const workers = Array.from({ length: Math.min(20, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      try {
        if (svc.bus.isConnected?.() === false) {
          throw new Error("session event bus is disconnected");
        }
        if (svc.bus.publishConfirmed) {
          await svc.bus.publishConfirmed(row.event.workspaceId, row.event.sessionId, [row.event]);
        } else {
          await svc.bus.publish(row.event.workspaceId, row.event.sessionId, [row.event]);
        }
        await markDelivered(svc.db, row);
        delivered += 1;
      } catch (error) {
        failed += 1;
        await markFailed(svc.db, row, error instanceof Error ? error.message : String(error)).catch(
          () => undefined,
        );
      }
    }
  });
  await Promise.all(workers);
  return { claimed: rows.length, delivered, failed };
}

export async function reconcilePendingSessionWorkflowWakes(
  svc: NotifyServices,
  limit = 1_000,
  overrides: ReconcileSessionWorkflowWakeOverrides = {},
): Promise<{ claimed: number; delivered: number; failed: number }> {
  const claimPendingSessionWorkflowWakesFn =
    overrides.claimPendingSessionWorkflowWakes ?? claimPendingSessionWorkflowWakes;
  if (!svc.wakeSessionWorkflow) {
    return { claimed: 0, delivered: 0, failed: 0 };
  }
  const repairs = await claimPendingSessionWorkflowWakesFn(svc.db, limit);
  let delivered = 0;
  let failed = 0;
  const queue = [...repairs];
  const workers = Array.from({ length: Math.min(20, queue.length) }, async () => {
    for (;;) {
      const repair = queue.shift();
      if (!repair) return;
      try {
        await svc.wakeSessionWorkflow!({
          accountId: repair.accountId,
          workspaceId: repair.workspaceId,
          sessionId: repair.sessionId,
          workflowId: repair.temporalWorkflowId,
          wakeRevision: repair.wakeRevision,
          ...(repair.interruptionRequested ? { interruptionRequested: true } : {}),
        });
        delivered += 1;
      } catch (error) {
        failed += 1;
        await markSessionWorkflowWakeFailed(
          svc.db,
          repair,
          error instanceof Error ? error.message : String(error),
        ).catch(() => undefined);
      }
    }
  });
  await Promise.all(workers);
  return { claimed: repairs.length, delivered, failed };
}

function childCompletionPayload(
  child: Session,
  goal: SessionGoal | null,
): Extract<SessionSystemUpdatePayload, { type: "child_terminal_result" }> {
  return {
    type: "child_terminal_result",
    childSessionId: child.id,
    status: "idle",
    ...(goal
      ? {
          goal: {
            status: goal.status,
            text: goal.text,
            ...(goal.evidence ? { evidence: goal.evidence } : {}),
            ...(goal.rationale ? { rationale: goal.rationale } : {}),
            ...(goal.pausedReason ? { pausedReason: goal.pausedReason } : {}),
          },
        }
      : {}),
  };
}

/**
 * The worker-specific lines for one child (what happened + its goal), WITHOUT
 * the trailing "what to do next" instruction. Kept separate so N child
 * completions can be coalesced into one internal-update inference: the DB layer
 * stores each child's summary and rebuilds a single numbered digest with one
 * shared trailing instruction instead of running N model calls.
 */
export function childCompletionSummary(
  child: Session,
  goal: SessionGoal | null,
  terminalStatus: "idle" | "failed",
): string {
  const lines: string[] = [];
  if (terminalStatus === "failed") {
    lines.push(`A worker session you spawned has FAILED. Worker session id: ${child.id}.`);
  } else if (goal?.status === "completed") {
    lines.push(
      `A worker session you spawned has COMPLETED its goal. Worker session id: ${child.id}.`,
    );
  } else if (goal?.status === "paused") {
    lines.push(
      `A worker session you spawned has PAUSED its goal and gone idle. Worker session id: ${child.id}.`,
    );
  } else {
    lines.push(
      `A worker session you spawned has finished its work and gone idle. Worker session id: ${child.id}.`,
    );
  }
  if (goal) {
    lines.push(`Worker goal: ${goal.text}`);
    if (goal.status === "completed" && goal.evidence) {
      lines.push(`Completion evidence: ${goal.evidence}`);
    }
    if (goal.status === "paused" && goal.rationale) {
      lines.push(`Pause rationale: ${goal.rationale}`);
    }
  }
  return lines.join("\n");
}

/**
 * The single trailing instruction appended to a child-completion (or digest)
 * inference. Suppresses the "resume it now" nudge when the manager's own goal
 * was paused by the user (paired with the goal_set reactivation guard).
 */
export function childCompletionTrailing(parentGoalUserPaused: boolean): string {
  return parentGoalUserPaused
    ? "Read each worker's session events/notebook output for its result. This session was paused by the user — do NOT resume or replace your goal; summarize the result for the user and remain paused."
    : "Read each worker's session events/notebook output for its result, then continue. If your own goal was paused awaiting these workers, resume it now.";
}
