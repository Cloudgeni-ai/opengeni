import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const reaperActivity = proxyActivities<Pick<typeof activities, "reapExpiredFileUploads">>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** One bounded provider/DB sweep; the Temporal Schedule owns the cadence. */
export async function fileUploadReaperWorkflow(): Promise<void> {
  await reaperActivity.reapExpiredFileUploads();
}
