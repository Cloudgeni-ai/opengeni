import { deprecatePatch, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const reaperActivity = proxyActivities<
  Pick<
    typeof activities,
    | "reapExpiredFileUploads"
    | "maintainRetainedScreenshots"
    | "maintainBrowserStateArtifacts"
    | "recoverVideoGenerationWorkflows"
    | "recoverSessionTitleWorkflows"
    | "recoverRecordingWorkflows"
    | "applyRecordingRetention"
    | "reconcileRecentModelCallFacts"
  >
>({
  startToCloseTimeout: "5 minutes",
  retry: { maximumAttempts: 1 },
});

/** One bounded provider/DB sweep; the Temporal Schedule owns the cadence. */
export async function fileUploadReaperWorkflow(): Promise<void> {
  await reaperActivity.reapExpiredFileUploads();
  await reaperActivity.maintainRetainedScreenshots();
  await reaperActivity.maintainBrowserStateArtifacts();
  await reaperActivity.recoverVideoGenerationWorkflows();
  // These bounded sweeps have no surviving pre-patch histories. Keep deprecated
  // markers for rolling replay with the previous worker; remove them only after
  // all deployments run this release and non-deprecated histories have closed.
  deprecatePatch("independent-session-title-recovery-v1");
  await reaperActivity.recoverSessionTitleWorkflows();
  deprecatePatch("recording-workflow-recovery-v1");
  await reaperActivity.recoverRecordingWorkflows();
  deprecatePatch("recording-retention-v1");
  await reaperActivity.applyRecordingRetention();
  await reaperActivity.reconcileRecentModelCallFacts();
}
