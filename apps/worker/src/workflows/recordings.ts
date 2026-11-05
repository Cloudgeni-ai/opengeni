import {
  ActivityFailure,
  ApplicationFailure,
  continueAsNew,
  proxyActivities,
  sleep,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type { BrowserRecordingVideoInput } from "../activities/browser-recordings";
import type { DictationListeningInput } from "../activities/dictation-listening";

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

export function recordingSpeakerScanWorkflowId(recordingId: string): string {
  return `recording-speaker-scan:${recordingId}`;
}

export function dictationListeningWorkflowId(recordingId: string): string {
  return `recording-dictation-listening:${recordingId}`;
}

export type DictationListeningWorkflowInput = DictationListeningInput;

export type BrowserRecordingVideoWorkflowInput = BrowserRecordingVideoInput;

export function browserRecordingVideoWorkflowId(recordingId: string): string {
  return `recording-browser-video:${recordingId}`;
}

/**
 * Transcribing an hour of audio can take several minutes at the provider,
 * and about an hour more on a small worker when a text-only model's words
 * are aligned on its CPU. The activity heartbeats while it works, so a lost
 * worker is noticed in minutes; retryable provider failures back off for up
 * to about an hour. One attempt may run as long as the transcript's own time
 * budget (recordingTranscriptBudgetMilliseconds, at most twelve hours), which
 * the activity enforces by failing the version as timed_out, so a long
 * meeting isn't cut off and started over every two hours.
 */
const transcriptActivity = proxyActivities<Pick<typeof activities, "transcribeRecordingVersion">>({
  startToCloseTimeout: "12 hours",
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

const deletionActivity = proxyActivities<
  Pick<typeof activities, "deleteRecordingMedia" | "expireDictation">
>({
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    initialInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 hour",
    maximumAttempts: 50,
  },
});

/**
 * A scan goes through a few minutes of new audio: seconds of CPU. Missing
 * one only leaves more for the final transcript, so it isn't retried long.
 */
const speakerScanActivity = proxyActivities<Pick<typeof activities, "scanRecordingSpeakers">>({
  startToCloseTimeout: "20 minutes",
  heartbeatTimeout: "2 minutes",
  retry: {
    initialInterval: "30 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 3,
  },
});

/**
 * One run listens to a dictation for up to ten minutes, heartbeating every
 * fraction of a second. A failed run only leaves more for the final
 * transcript, so it is tried again just once.
 */
const listeningActivity = proxyActivities<Pick<typeof activities, "listenToDictation">>({
  startToCloseTimeout: "15 minutes",
  heartbeatTimeout: "1 minute",
  retry: { initialInterval: "1 second", maximumAttempts: 2 },
});

/** Encoding an hour of mostly still pages takes seconds; a long busy one, minutes. */
const browserVideoActivity = proxyActivities<
  Pick<typeof activities, "createBrowserRecordingFromBundle" | "encodeBrowserRecordingVideo">
>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "10 minutes",
  retry: {
    initialInterval: "10 seconds",
    backoffCoefficient: 2,
    maximumInterval: "5 minutes",
    maximumAttempts: 6,
  },
});

const browserVideoSettleActivity = proxyActivities<Pick<typeof activities, "failBrowserRecording">>(
  {
    startToCloseTimeout: "1 minute",
    retry: { initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "5 minutes" },
  },
);

function failureCode(error: unknown): string {
  let cause: unknown = error;
  while (cause instanceof ActivityFailure) cause = cause.cause;
  if (cause instanceof ApplicationFailure && cause.type) return cause.type.slice(0, 128);
  return "processing_failed";
}

/** The innermost failure's own message, as its activity threw it. */
function failureMessage(error: unknown): string {
  let cause: unknown = error;
  while (cause instanceof ActivityFailure) cause = cause.cause;
  return cause instanceof Error && cause.message ? cause.message : "processing failed";
}

/**
 * Make one transcript version; all state lives in Postgres. A dictation is
 * then kept a day for its owner to take the text, and deleted.
 */
export async function recordingTranscriptWorkflow(
  input: RecordingTranscriptWorkflowInput,
): Promise<void> {
  // One workflow per version, so the version id names its lease.
  const job = { ...input, processingOwner: input.versionId };
  let expireAfterMilliseconds: number | undefined;
  try {
    // Histories from before dictations return no expiry, so they replay unchanged.
    expireAfterMilliseconds = (await transcriptActivity.transcribeRecordingVersion(job))
      ?.expireAfterMilliseconds;
  } catch (error) {
    const settled = await settleActivity.failRecordingTranscript({
      ...job,
      errorCode: failureCode(error),
      errorMessage: failureMessage(error),
    });
    expireAfterMilliseconds = settled?.expireAfterMilliseconds;
  }
  if (expireAfterMilliseconds !== undefined) {
    await sleep(expireAfterMilliseconds);
    await deletionActivity.expireDictation({
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      recordingId: input.recordingId,
      ownerSubjectId: input.ownerSubjectId,
    });
  }
}

/**
 * Record an agent's browser recording and make its video. The recording is
 * created here, so it never exists without this workflow to finish it.
 */
export async function browserRecordingVideoWorkflow(
  input: BrowserRecordingVideoWorkflowInput,
): Promise<void> {
  await browserVideoActivity.createBrowserRecordingFromBundle(input);
  try {
    await browserVideoActivity.encodeBrowserRecordingVideo(input);
  } catch (error) {
    await browserVideoSettleActivity.failBrowserRecording({
      ...input,
      errorCode: failureCode(error),
      errorMessage: failureMessage(error),
    });
  }
}

/** Remove a deleted recording's audio and rows. */
export async function recordingDeletionWorkflow(
  input: RecordingDeletionWorkflowInput,
): Promise<void> {
  await deletionActivity.deleteRecordingMedia(input);
}

/**
 * Hear a dictation's pieces while it is still being spoken, so when it stops
 * only its last few seconds are left. Ends with the dictation.
 */
export async function dictationListeningWorkflow(
  input: DictationListeningWorkflowInput,
): Promise<void> {
  for (let runs = 0; runs < 20; runs += 1) {
    let again = false;
    try {
      ({ again } = await listeningActivity.listenToDictation(input));
    } catch {
      // The final transcript hears what this didn't.
    }
    if (!again) return;
  }
  await continueAsNew<typeof dictationListeningWorkflow>(input);
}

/**
 * Tell a meeting's speakers apart while it is still being recorded, about
 * every half minute, so the transcript after it ends has little left to do.
 * Ends with the recording; a failed scan only leaves more for the end.
 */
export async function recordingSpeakerScanWorkflow(
  input: RecordingDeletionWorkflowInput,
): Promise<void> {
  for (let scans = 0; scans < 120; scans += 1) {
    let again = true;
    try {
      ({ again } = await speakerScanActivity.scanRecordingSpeakers(input));
    } catch {
      // Tried again on the next round, from what was kept.
    }
    if (!again) return;
    await sleep("30 seconds");
  }
  await continueAsNew<typeof recordingSpeakerScanWorkflow>(input);
}
