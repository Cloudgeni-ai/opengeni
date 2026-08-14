import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const maintenanceActivity = proxyActivities<Pick<typeof activities, "maintainSiteAuthConnections">>(
  {
    startToCloseTimeout: "5 minutes",
    retry: { maximumAttempts: 1 },
  },
);

/** One bounded durable claim/dispatch sweep; the Temporal Schedule owns cadence. */
export async function siteAuthMaintenanceWorkflow(): Promise<void> {
  await maintenanceActivity.maintainSiteAuthConnections();
}
