import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const storageActivity = proxyActivities<Pick<typeof activities, "maintainSessionStorage">>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 1 },
});

/** One bounded session storage maintenance pass; the Temporal Schedule owns the cadence. */
export async function sessionStorageMaintenanceWorkflow(): Promise<void> {
  await storageActivity.maintainSessionStorage();
}
