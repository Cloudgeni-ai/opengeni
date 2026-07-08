import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

export const activity = proxyActivities<typeof activities>({
  // Agent segments legitimately run for days (goal-bearing infrastructure
  // sessions). Dead workers are detected by the heartbeat, not this timeout,
  // so it is deliberately generous rather than a pacing bound.
  startToCloseTimeout: "30 days",
  // 2 min (not 30s): the heartbeat timer fires every 10s but the Temporal SDK
  // throttles forwarded heartbeats to ~80% of this timeout, and it shares the
  // turn's event loop — a 30s timeout left only ~6s of slack, so a GC pause or
  // synchronous work assembling a large-context model request tripped a FALSE
  // worker-death (then a full redispatch, capped → could fail the session).
  // A real dead worker is still detected within 2 min, immaterial for turns
  // that legitimately run for days.
  heartbeatTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export const documentActivity = proxyActivities<Pick<typeof activities, "indexDocument">>({
  startToCloseTimeout: "30 minutes",
  retry: { maximumAttempts: 1 },
});

export function workflowFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
