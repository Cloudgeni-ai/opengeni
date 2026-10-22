import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const storageActivity = proxyActivities<Pick<typeof activities, "maintainSessionStorage">>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 1 },
});

const archiveActivity = proxyActivities<Pick<typeof activities, "archiveIdleSessions">>({
  // The activity keeps its own soft budget below this bound.
  startToCloseTimeout: "60 minutes",
  retry: { maximumAttempts: 1 },
});

/** One bounded session storage maintenance pass; the Temporal Schedule owns the cadence. */
export async function sessionStorageMaintenanceWorkflow(): Promise<void> {
  await storageActivity.maintainSessionStorage();
  await archiveActivity.archiveIdleSessions();
}
