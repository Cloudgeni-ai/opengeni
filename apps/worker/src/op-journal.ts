// The Temporal adaptation of the op-stream durable-resume journal
// (`OpStreamJournal`, @opengeni/runtime): the runtime leaf stays
// Temporal-free; this is where its two seams bind to the activity.
//
// * `attachGeneration` — the consumer generation the runner fences zombie
//   consumers by. `Info.attempt` CANNOT serve here: `runAgentTurn` runs with
//   `maximumAttempts: 1`, so worker death is healed by the WORKFLOW
//   redispatching a NEW activity whose attempt is 1 again. The activity's
//   `currentAttemptScheduledTimestampMs` is Temporal-server-assigned and
//   strictly larger for a later dispatch (death detection is bounded below by
//   the 2-minute heartbeat timeout, far above ms resolution), so it is a
//   monotonic generation with zero workflow plumbing. Intra-activity
//   re-attaches (blip/gap heals) reuse it — the runner's equal-generation
//   replay path.
//
// * `persistSettled` — the durable-before-wire-ack ordering hook: fold the
//   settled op's frontier into the activity's shared heartbeat details and
//   flush a heartbeat BEFORE the client publishes the final ack. The shared
//   `details` object is the SAME one every other heartbeat site spreads, so a
//   later phase heartbeat re-carries the roster instead of clobbering it.

import type { Context } from "@temporalio/activity";
import type { OpStreamJournal } from "@opengeni/runtime";
import type { TurnPersistenceHandoff } from "./activities/types";

/** The activity's shared heartbeat-details object: every heartbeat call site
 *  spreads THIS one object (plus its own phase), so fields like the op-ack
 *  roster survive across sites instead of being lost to last-write-wins. */
export interface TurnHeartbeatDetails extends Record<string, unknown> {
  /** Settled-op roster: durable op id → its exit seq (the final-ack frontier). */
  opAcks: Record<string, string>;
  /** Exact bounded operation a control worker must persist before turn recovery. */
  persistenceHandoff?: TurnPersistenceHandoff;
}

export function makeTurnOpJournal(
  context: Context | null,
  details: TurnHeartbeatDetails,
): OpStreamJournal {
  return {
    attachGeneration: () => String(context?.info.currentAttemptScheduledTimestampMs ?? 1),
    persistSettled: (opId, exitSeq) => {
      details.opAcks[opId] = exitSeq;
      // Flush immediately (heartbeats are also sent on the 10s timer; this one
      // exists so the persist precedes the wire final ack, not just eventually).
      context?.heartbeat({ ...details, phase: "op_settled", at: new Date().toISOString() });
    },
  };
}
