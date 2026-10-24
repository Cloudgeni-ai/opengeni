import { patched, proxyActivities } from "@temporalio/workflow";
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
  if (patched("independent-session-title-recovery-v1")) {
    await reaperActivity.recoverSessionTitleWorkflows();
  }
  if (patched("recording-workflow-recovery-v1")) {
    await reaperActivity.recoverRecordingWorkflows();
  }
  if (patched("recording-retention-v1")) {
    await reaperActivity.applyRecordingRetention();
  }
  await reaperActivity.reconcileRecentModelCallFacts();
}
