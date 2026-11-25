import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Database } from "./database";
import * as schema from "./schema";

/** The answers a person (or the system for them) gives to a paused turn. */
export const PAUSE_RESPONSE_EVENT_TYPES = ["user.approvalDecision", "user.humanInputResponse"];

/**
 * The one rule for which recorded answer resumes a paused turn, shared by the
 * scheduler's peek and the claim that resumes the turn.
 *
 * An answer resumes the turn only when it was recorded for that same turn
 * and after the turn's current trigger. Every turn-bound answer is stamped
 * with its turn when it is accepted (the decision API only accepts an answer
 * for a call open in the live turn). Sequence alone is not enough: a message
 * queued while an earlier turn waited for approval is older than that turn's
 * decisions, so the earlier turn's decisions would otherwise read as answers
 * to the new turn's pause. Turnless answers, such as a secret-use approval
 * card, never resume a turn.
 *
 * Without `candidateEventId` this returns the answer to resume with: the
 * question answer first (one is accepted per pause and only the trigger
 * carries it), otherwise the newest decision (a resume applies the pause's
 * decisions up to its trigger together). With it, this returns the candidate
 * only if it is such an answer.
 */
export async function pauseResponseTrigger(
  tx: Database,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    /** The paused turn's current trigger event. */
    triggerEventId: string;
    candidateEventId?: string;
  },
): Promise<string | null> {
  const [current] = await tx
    .select({ sequence: schema.sessionEvents.sequence })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, input.workspaceId),
        eq(schema.sessionEvents.sessionId, input.sessionId),
        eq(schema.sessionEvents.id, input.triggerEventId),
      ),
    )
    .limit(1);
  if (!current) return null;
  const [answer] = await tx
    .select({ id: schema.sessionEvents.id })
    .from(schema.sessionEvents)
    .where(
      and(
        eq(schema.sessionEvents.workspaceId, input.workspaceId),
        eq(schema.sessionEvents.sessionId, input.sessionId),
        eq(schema.sessionEvents.turnId, input.turnId),
        inArray(schema.sessionEvents.type, PAUSE_RESPONSE_EVENT_TYPES),
        gt(schema.sessionEvents.sequence, current.sequence),
        input.candidateEventId === undefined
          ? undefined
          : eq(schema.sessionEvents.id, input.candidateEventId),
      ),
    )
    .orderBy(
      sql`(${schema.sessionEvents.type} = 'user.humanInputResponse') desc`,
      desc(schema.sessionEvents.sequence),
      desc(schema.sessionEvents.id),
    )
    .limit(1);
  return answer?.id ?? null;
}
