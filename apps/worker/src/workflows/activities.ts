import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

export const activity = proxyActivities<typeof activities>({
  startToCloseTimeout: "4 hours",
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 1 },
});

export function workflowFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
