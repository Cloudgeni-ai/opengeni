import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

export const activity = proxyActivities<typeof activities>({
  // Agent segments legitimately run for days (goal-bearing infrastructure
  // sessions). Dead workers are detected by the heartbeat, not this timeout,
  // so it is deliberately generous rather than a pacing bound.
  startToCloseTimeout: "30 days",
  heartbeatTimeout: "30 seconds",
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
