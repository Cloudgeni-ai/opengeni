/**
 * Which messages a chat's timeline shows, and where: the rules the timeline
 * and anything that reproduces it (such as a chat share link) share, so the
 * two never disagree about a queued, edited, withdrawn or steered message.
 *
 * A message the person sent enters the conversation where its turn started
 * (or directly, when it was a steer or accepted straight away). A queued
 * message that was edited, deleted or cancelled before it started never
 * appears, and one still waiting belongs only to the queue.
 */

/** The fields of a session event these rules read. */
export type TimelineOrderEvent = {
  id: string;
  type: string;
  sequence: number;
  turnId?: string | null | undefined;
  payload?: unknown | undefined;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type TurnAnchorPrescan = {
  queuedTurnByTrigger: Map<string, string>;
  startSeqByTrigger: Map<string, number>;
  cancelledBeforeStartTriggers: Set<string>;
  directChatSequenceByTrigger: Map<string, number>;
  explicitQueuedTriggers: Set<string>;
  startedTurnIds: Set<string>;
};

export function prescanTurnAnchors(events: readonly TimelineOrderEvent[]): TurnAnchorPrescan {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const queuedTurnByTrigger = new Map<string, string>();
  const startSeqByTrigger = new Map<string, number>();
  const cancelledTurnIds = new Set<string>();
  const withdrawnTurnIds = new Set<string>();
  const fallbackSeqByTurn = new Map<string, number>();
  const directChatSequenceByTrigger = new Map<string, number>();
  const explicitQueuedTriggers = new Set<string>();
  const queueSteerSequenceByTurn = new Map<string, number>();
  const startedTurnIds = new Set<string>();
  const userMessageSequenceById = new Map<string, number>();

  for (const event of ordered) {
    const payload = record(event.payload);
    const turnId = event.turnId ?? null;
    if (event.type === "user.message") {
      userMessageSequenceById.set(event.id, event.sequence);
      if (payload.routing === "queued_for_execution") {
        explicitQueuedTriggers.add(event.id);
      } else if (
        payload.routing === "accepted_for_execution" ||
        payload.routing === "accepted_for_steering"
      ) {
        directChatSequenceByTrigger.set(event.id, event.sequence);
      }
    }
    if (event.type === "user.message" && payload.delivery === "steer") {
      directChatSequenceByTrigger.set(event.id, event.sequence);
    }
    if (event.type === "session.control.steer_requested") {
      const targetTurnId = typeof payload.targetTurnId === "string" ? payload.targetTurnId : null;
      if (targetTurnId && !queueSteerSequenceByTurn.has(targetTurnId)) {
        queueSteerSequenceByTurn.set(targetTurnId, event.sequence);
      }
    }
    if (
      event.type === "session.queue.changed" &&
      (payload.operation === "edit" || payload.operation === "delete")
    ) {
      const withdrawnTurnId =
        typeof payload.turnId === "string" ? payload.turnId : (turnId ?? null);
      if (withdrawnTurnId) withdrawnTurnIds.add(withdrawnTurnId);
    }
    if (event.type === "turn.queued") {
      const triggerEventId =
        typeof payload.triggerEventId === "string" ? payload.triggerEventId : null;
      const queuedTurnId = typeof payload.turnId === "string" ? payload.turnId : turnId;
      if (triggerEventId && queuedTurnId) {
        queuedTurnByTrigger.set(triggerEventId, queuedTurnId);
        if (
          (payload.routing === "accepted_for_execution" ||
            payload.routing === "accepted_for_steering") &&
          !directChatSequenceByTrigger.has(triggerEventId)
        ) {
          directChatSequenceByTrigger.set(
            triggerEventId,
            userMessageSequenceById.get(triggerEventId) ?? event.sequence,
          );
        }
      }
      continue;
    }
    if (event.type === "turn.started") {
      const triggerEventId =
        typeof payload.triggerEventId === "string" ? payload.triggerEventId : null;
      if (triggerEventId && !startSeqByTrigger.has(triggerEventId)) {
        startSeqByTrigger.set(triggerEventId, event.sequence);
      }
      if (turnId) {
        startedTurnIds.add(turnId);
      }
    } else if (event.type === "turn.cancelled" && turnId) {
      cancelledTurnIds.add(turnId);
    }

    if (turnId && isTurnExecutionEvidence(event.type)) {
      const previous = fallbackSeqByTurn.get(turnId);
      if (previous === undefined || event.sequence < previous) {
        fallbackSeqByTurn.set(turnId, event.sequence);
      }
    }
    if (
      turnId &&
      isTurnExecutionEvidence(event.type) &&
      !(event.type === "turn.superseded" && payload.beforeAttempt === true)
    ) {
      startedTurnIds.add(turnId);
    }
  }

  for (const [triggerEventId, turnId] of queuedTurnByTrigger) {
    const queueSteerSequence = queueSteerSequenceByTurn.get(turnId);
    if (queueSteerSequence !== undefined) {
      directChatSequenceByTrigger.set(triggerEventId, queueSteerSequence);
    }
    if (!startSeqByTrigger.has(triggerEventId)) {
      const fallbackSeq = fallbackSeqByTurn.get(turnId);
      if (fallbackSeq !== undefined) {
        startSeqByTrigger.set(triggerEventId, fallbackSeq);
      }
    }
  }

  const cancelledBeforeStartTriggers = new Set<string>();
  for (const [triggerEventId, turnId] of queuedTurnByTrigger) {
    if (
      (cancelledTurnIds.has(turnId) || withdrawnTurnIds.has(turnId)) &&
      !startSeqByTrigger.has(triggerEventId) &&
      !fallbackSeqByTurn.has(turnId)
    ) {
      cancelledBeforeStartTriggers.add(triggerEventId);
    }
  }

  return {
    queuedTurnByTrigger,
    startSeqByTrigger,
    cancelledBeforeStartTriggers,
    directChatSequenceByTrigger,
    explicitQueuedTriggers,
    startedTurnIds,
  };
}

export function orderTimelineEvents<E extends TimelineOrderEvent>(
  events: readonly E[],
  prescan: TurnAnchorPrescan,
): E[] {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
  const insertions = new Map<number, E[]>();

  for (const event of ordered) {
    if (event.type !== "user.message") {
      continue;
    }
    // Steer is an accepted direction change, not waiting queue copy. Keep it
    // directly in chat across refresh/reconnect even before its turn starts.
    const directChatSequence = prescan.directChatSequenceByTrigger.get(event.id);
    if (directChatSequence !== undefined) {
      pushInsertion(insertions, directChatSequence, event);
      continue;
    }
    const queuedTurnId = prescan.queuedTurnByTrigger.get(event.id);
    if (!queuedTurnId) {
      if (prescan.explicitQueuedTriggers.has(event.id)) {
        const startSeq = prescan.startSeqByTrigger.get(event.id);
        if (startSeq !== undefined) {
          pushInsertion(insertions, startSeq, event);
        }
        continue;
      }
      pushInsertion(insertions, event.sequence, event);
      continue;
    }
    if (prescan.cancelledBeforeStartTriggers.has(event.id)) {
      continue;
    }
    const startSeq = prescan.startSeqByTrigger.get(event.id);
    if (startSeq !== undefined) {
      pushInsertion(insertions, startSeq, event);
      continue;
    }
    // A waiting prompt belongs only in the prompt queue. It enters the
    // timeline at turn.started (or the first same-turn activity fallback),
    // never as a second queued representation.
  }

  const projected: E[] = [];
  for (const event of ordered) {
    const before = insertions.get(event.sequence);
    if (before) {
      projected.push(...before);
    }
    if (event.type !== "user.message") {
      projected.push(event);
    }
  }
  return projected;
}

function pushInsertion<E>(insertions: Map<number, E[]>, sequence: number, event: E): void {
  const bucket = insertions.get(sequence);
  if (bucket) {
    bucket.push(event);
  } else {
    insertions.set(sequence, [event]);
  }
}

export function isAgentActivityEvent(type: string): boolean {
  return (
    type.startsWith("agent.") ||
    type.startsWith("sandbox.") ||
    type === "subscription.account.selected" ||
    type === "subscription.account.switched"
  );
}

/**
 * Evidence that a queued prompt crossed the execution boundary when an older
 * or partially recovered ledger is missing its canonical `turn.started`.
 * Queue/control bookkeeping intentionally does not qualify: moving, editing,
 * steering, or deleting a waiting row must never make its prompt appear in the
 * transcript as though inference had begun.
 */
export function isTurnExecutionEvidence(type: string): boolean {
  return (
    isAgentActivityEvent(type) ||
    type === "turn.completed" ||
    type === "turn.failed" ||
    // An admission refusal can settle a queued turn before it ever starts:
    // its prompt still belongs above the "usage limit reached" row.
    type === "usage.exhausted" ||
    type === "turn.superseded" ||
    type === "turn.recovery.requested" ||
    type === "turn.capacity_waiting" ||
    type === "session.requiresAction" ||
    type === "tool.auth_needed" ||
    type === "credential.auth_needed" ||
    type.startsWith("turn.startup.phase.") ||
    type.startsWith("rig.setup.") ||
    type === "codex.capacity.waiting" ||
    type === "codex.capacity.resumed" ||
    type === "codex.fleet.decision"
  );
}
