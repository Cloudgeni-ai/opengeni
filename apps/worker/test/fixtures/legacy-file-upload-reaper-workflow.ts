// Previous worker's command sequence, before retiring the three replay branches.
// Keep until every deployment has drained non-deprecated reaper histories.
import { patched, proxyActivities } from "@temporalio/workflow";

const activity = proxyActivities<{
  reapExpiredFileUploads(): Promise<void>;
  maintainRetainedScreenshots(): Promise<void>;
  maintainBrowserStateArtifacts(): Promise<void>;
  recoverVideoGenerationWorkflows(): Promise<void>;
  recoverSessionTitleWorkflows(): Promise<void>;
  recoverRecordingWorkflows(): Promise<void>;
  applyRecordingRetention(): Promise<void>;
  reconcileRecentModelCallFacts(): Promise<void>;
}>({ startToCloseTimeout: "5 minutes", retry: { maximumAttempts: 1 } });

export async function fileUploadReaperWorkflow(): Promise<void> {
  await activity.reapExpiredFileUploads();
  await activity.maintainRetainedScreenshots();
  await activity.maintainBrowserStateArtifacts();
  await activity.recoverVideoGenerationWorkflows();
  if (patched("independent-session-title-recovery-v1")) {
    await activity.recoverSessionTitleWorkflows();
  }
  if (patched("recording-workflow-recovery-v1")) {
    await activity.recoverRecordingWorkflows();
  }
  if (patched("recording-retention-v1")) {
    await activity.applyRecordingRetention();
  }
  await activity.reconcileRecentModelCallFacts();
}
