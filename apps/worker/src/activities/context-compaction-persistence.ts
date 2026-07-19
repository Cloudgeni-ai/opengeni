import {
  applyContextCompaction,
  recordSkippedContextCompaction,
  type Database,
} from "@opengeni/db";
import type { SessionEvent } from "@opengeni/contracts";
import type { PreparedContextCompactionPersistence } from "./types";
import { TurnAttemptFencedError } from "./turn-attempt-fenced";

export type PersistedContextCompactionResult =
  | {
      compacted: false;
      reason: string;
      events: SessionEvent[];
      requestConsumed: boolean;
    }
  | {
      compacted: true;
      supersededFrom: number;
      summaryPosition: number;
      signalTokens: number;
      thresholdTokens: number;
      estimatedTokensBefore: number;
      estimatedTokensAfter: number;
      replacementFingerprint: string;
      events: SessionEvent[];
    };

export type ContextCompactionPersistenceScope = {
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  executionGeneration: number;
  attemptId: string;
};

/**
 * Persist one already-produced compaction outcome under its exact turn fence.
 * This module is deliberately DB-only: Temporal control retries can apply or
 * confirm the receipt without importing provider/runtime/tool execution code.
 */
export async function persistPreparedContextCompaction(
  db: Database,
  scope: ContextCompactionPersistenceScope,
  prepared: PreparedContextCompactionPersistence,
): Promise<PersistedContextCompactionResult> {
  if (prepared.action === "skip") {
    const skipped = await recordSkippedContextCompaction(db, {
      ...scope,
      expectedExecutionGeneration: scope.executionGeneration,
      expectedAttemptId: scope.attemptId,
      reason: prepared.reason,
      clearRequestedCompaction: prepared.clearRequestedCompaction,
      persistenceKey: prepared.persistenceKey,
      occurredAt: new Date(prepared.occurredAt),
      eventPayload: prepared.eventPayload,
    });
    if (!skipped.recorded) {
      throw new TurnAttemptFencedError(
        `turn attempt was fenced while recording context compaction outcome: ${skipped.reason}`,
      );
    }
    return {
      compacted: false,
      reason: prepared.reason,
      events: skipped.events,
      requestConsumed: prepared.clearRequestedCompaction,
    };
  }

  const applied = await applyContextCompaction(db, {
    ...scope,
    expectedExecutionGeneration: scope.executionGeneration,
    expectedAttemptId: scope.attemptId,
    replacementItems: prepared.replacementItems,
    summaryItem: prepared.summaryItem,
    replacementInputTokens: prepared.replacementInputTokens,
    clearRequestedCompaction: prepared.clearRequestedCompaction,
    persistenceKey: prepared.persistenceKey,
    occurredAt: new Date(prepared.occurredAt),
    eventPayload: prepared.eventPayload,
  });
  if (!applied.applied) {
    throw new TurnAttemptFencedError(
      `turn attempt was fenced during context compaction: ${applied.reason}`,
    );
  }
  return {
    compacted: true,
    supersededFrom: applied.supersededFrom,
    summaryPosition: applied.summaryPosition,
    ...prepared.result,
    events: applied.events,
  };
}
