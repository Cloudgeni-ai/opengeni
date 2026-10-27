import {
  requestIdleSessionCompactionIfDue,
  type Database,
  type IdleSessionCompactionRequestResult,
} from "@opengeni/db";

/**
 * Idle checkpoint after a turn that ended at its automatic compaction
 * threshold. Without it the checkpoint runs in front of the person's next
 * message, after the provider prompt cache has gone cold (a remote_v2
 * checkpoint of a ~240k-token history takes minutes). With it, the same
 * workflow claims the checkpoint as the existing `source="compaction"`
 * maintenance execution as soon as this turn's activity returns.
 *
 * Scope is deliberately narrow because nobody may come back to the session:
 * only human/API turns (a frozen subject initiator) in root sessions. Child,
 * scheduled, goal-continuation and other service work keeps compacting at its
 * next model boundary, which it reaches only if it continues.
 */
export type IdleCompactionTurn = {
  source: string;
  initiatorKind: string;
};

export type IdleCompactionEligibility =
  | "eligible"
  | "disabled"
  | "maintenance"
  | "not_human_turn"
  | "no_threshold";

export function idleCompactionEligibility(input: {
  enabled: boolean;
  turn: IdleCompactionTurn;
  thresholdTokens: number;
}): IdleCompactionEligibility {
  if (!input.enabled) return "disabled";
  if (input.turn.source === "compaction") return "maintenance";
  if (
    (input.turn.source !== "user" && input.turn.source !== "api") ||
    input.turn.initiatorKind !== "subject"
  ) {
    return "not_human_turn";
  }
  if (!Number.isFinite(input.thresholdTokens) || input.thresholdTokens <= 0) {
    return "no_threshold";
  }
  return "eligible";
}

type IdleCompactionLogger = {
  warn: (message: string, fields?: Record<string, string>) => void;
};

/**
 * Best effort: runs after the turn's completion settlement committed, and
 * never fails, retries, or changes that completed turn. The database call
 * rechecks idle status, root session, pending request and the durable
 * provider-reported token count under the session row lock.
 */
export async function requestIdleCompactionAfterCompletedTurn(input: {
  db: Database;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  enabled: boolean;
  turn: IdleCompactionTurn;
  thresholdTokens: number;
  logger: IdleCompactionLogger;
  request?: typeof requestIdleSessionCompactionIfDue;
}): Promise<IdleSessionCompactionRequestResult | null> {
  if (idleCompactionEligibility(input) !== "eligible") return null;
  try {
    return await (input.request ?? requestIdleSessionCompactionIfDue)(input.db, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      thresholdTokens: input.thresholdTokens,
    });
  } catch (error) {
    input.logger.warn("idle context compaction request failed; next turn compacts instead", {
      sessionId: input.sessionId,
      turnId: input.turnId,
      error: error instanceof Error ? error.name : typeof error,
    });
    return null;
  }
}
