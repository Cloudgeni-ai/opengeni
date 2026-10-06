import { proxyActivities } from "@temporalio/workflow";

// An old binary has no machine-v2 workflow or activity registrations.
export async function legacyQueueProbeWorkflow() {
  return proxyActivities<{ legacyQueueProbe(): Promise<string> }>({
    startToCloseTimeout: "10 seconds",
  }).legacyQueueProbe();
}
