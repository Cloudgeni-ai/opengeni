import { ActivityFailure, ApplicationFailure, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

export type RecordingTranscriptWorkflowInput = {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  versionId: string;
  ownerSubjectId: string;
};

export type RecordingDeletionWorkflowInput = {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  ownerSubjectId: string;
};

export function recordingTranscriptWorkflowId(versionId: string): string {
  return `recording-transcript:${versionId}`;
}

export function recordingDeletionWorkflowId(recordingId: string): string {
  return `recording-deletion:${recordingId}`;
}

/**
 * Transcribing an hour of audio can take several minutes at the provider.
 * The activity heartbeats while it waits, so a lost worker is noticed in
 * minutes; retryable provider failures back off for up to about an hour.
 */
const transcriptActivity = proxyActivities<Pick<typeof activities, "transcribeRecordingVersion">>({
  startToCloseTimeout: "2 hours",
  heartbeatTimeout: "3 minutes",
  retry: {
    initialInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumInterval: "15 minutes",
    maximumAttempts: 6,
  },
});

const settleActivity = proxyActivities<Pick<typeof activities, "failRecordingTranscript">>({
  startToCloseTimeout: "1 minute",
  retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "5 minutes" },
});

const deletionActivity = proxyActivities<Pick<typeof activities, "deleteRecordingMedia">>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    initialInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 hour",
    maximumAttempts: 50,
  },
});

function failureCode(error: unknown): string {
  let cause: unknown = error;
  while (cause instanceof ActivityFailure) cause = cause.cause;
  if (cause instanceof ApplicationFailure && cause.type) return cause.type.slice(0, 128);
  return "processing_failed";
}

/** Make one transcript version; all state lives in Postgres. */
export async function recordingTranscriptWorkflow(
  input: RecordingTranscriptWorkflowInput,
): Promise<void> {
  // One workflow per version, so the version id names its lease.
  const job = { ...input, processingOwner: input.versionId };
  try {
    await transcriptActivity.transcribeRecordingVersion(job);
  } catch (error) {
    await settleActivity.failRecordingTranscript({ ...job, errorCode: failureCode(error) });
  }
}

/** Remove a deleted recording's audio and rows. */
export async function recordingDeletionWorkflow(
  input: RecordingDeletionWorkflowInput,
): Promise<void> {
  await deletionActivity.deleteRecordingMedia(input);
}
