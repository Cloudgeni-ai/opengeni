import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

type ControlActivities = Omit<typeof activities, "runAgentTurn">;

export const activity = proxyActivities<ControlActivities>({
  startToCloseTimeout: "30 days",
  retry: { maximumAttempts: 1 },
});

export function turnTaskQueue(baseTaskQueue: string): string {
  return `${baseTaskQueue}-turns`;
}

export function turnActivityForTaskQueue(baseTaskQueue: string) {
  return proxyActivities<Pick<typeof activities, "runAgentTurn">>({
    taskQueue: turnTaskQueue(baseTaskQueue),
    // Agent segments legitimately run for days. A started turn heartbeats;
    // queued activities remain queued truthfully until a capped turn worker
    // accepts them and performs the atomic claim.
    startToCloseTimeout: "30 days",
    heartbeatTimeout: "2 minutes",
    retry: { maximumAttempts: 1 },
  });
}

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
