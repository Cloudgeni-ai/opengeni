import { ApplicationFailure, Context } from "@temporalio/activity";
import {
  browserRecordingActionLogObjectKey,
  browserRecordingVideoObjectKey,
  claimBrowserRecordingVideo,
  completeBrowserRecordingVideo,
  createBrowserRecording,
  failBrowserRecordingVideo,
  RecordingNotFoundError,
} from "@opengeni/db";
import type { RecordingVisibility } from "@opengeni/contracts";
import { createHash } from "node:crypto";
import { BrowserRecordingVideoError, encodeBrowserRecording } from "./browser-recording-video";
import type { ControlActivityServices } from "./types";

/**
 * Making an agent's browser recording into a recording. The API starts this
 * once the browser host has uploaded the frame bundle, so the recording, its
 * one video track and the bundle chunk only ever exist with a workflow that
 * makes the video. Every step runs as the recording's owner.
 */
export type BrowserRecordingVideoInput = {
  accountId: string;
  workspaceId: string;
  recordingId: string;
  ownerSubjectId: string;
  visibility: RecordingVisibility;
  startedAt: string;
  durationMilliseconds: number;
  bundle: { byteLength: number; sha256: string };
};

export type BrowserRecordingVideoActivityOptions = {
  heartbeat?: (details?: unknown) => void;
  cancellationSignal?: () => AbortSignal | undefined;
};

function activityContext(): Context | null {
  try {
    return Context.current();
  } catch {
    return null;
  }
}

export function createBrowserRecordingActivities(
  services: () => Promise<ControlActivityServices>,
  options: BrowserRecordingVideoActivityOptions = {},
) {
  const heartbeat = (details?: unknown) => {
    if (options.heartbeat) options.heartbeat(details);
    else activityContext()?.heartbeat(details);
  };
  const cancellation = () =>
    options.cancellationSignal
      ? options.cancellationSignal()
      : activityContext()?.cancellationSignal;

  /** The recording with its track and bundle chunk; repeating it changes nothing. */
  async function createBrowserRecordingFromBundle(input: BrowserRecordingVideoInput): Promise<void> {
    const { db } = await services();
    await createBrowserRecording(db, {
      accountId: input.accountId,
      workspaceId: input.workspaceId,
      subjectId: input.ownerSubjectId,
      recordingId: input.recordingId,
      visibility: input.visibility,
      startedAt: new Date(input.startedAt),
      durationMilliseconds: input.durationMilliseconds,
      bundle: input.bundle,
    });
  }

  /**
   * Encode the bundle into the track's MP4 and save the action log beside
   * it, then delete the bundle: the video and action log are what the
   * recording keeps. A bundle that is not a recording, or has no frames,
   * fails for good; anything else throws so Temporal retries.
   */
  async function encodeBrowserRecordingVideo(
    input: BrowserRecordingVideoInput,
  ): Promise<{ outcome: "complete" | "skipped" }> {
    const { db, objectStorage, settings } = await services();
    const actor = {
      workspaceId: input.workspaceId,
      subjectId: input.ownerSubjectId,
      recordingId: input.recordingId,
    };
    const job = await claimBrowserRecordingVideo(db, actor);
    if (!job) return { outcome: "skipped" };
    if (!objectStorage) {
      throw ApplicationFailure.retryable("Object storage is unavailable", "storage_unavailable");
    }
    const stored = await objectStorage.getObjectBytes(job.bundle.objectKey);
    if (!stored) {
      // The bundle is staged with a deletion deadline; once it is gone the
      // video can never be made.
      throw ApplicationFailure.nonRetryable("The recording's bundle is gone", "bundle_missing");
    }
    if (createHash("sha256").update(stored.bytes).digest("hex") !== job.bundle.sha256) {
      throw ApplicationFailure.nonRetryable(
        "The recording's bundle does not match its digest",
        "bundle_mismatch",
      );
    }
    heartbeat({ phase: "encoding" });
    const signal = cancellation();
    let encoded;
    try {
      encoded = await encodeBrowserRecording({
        bundle: stored.bytes,
        ffmpegPath: settings.voiceInputFfmpegPath,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (error instanceof BrowserRecordingVideoError) {
        throw error.code === "encode_failed"
          ? ApplicationFailure.retryable(error.message, error.code)
          : ApplicationFailure.nonRetryable(error.message, error.code);
      }
      throw error;
    }
    const videoKey = browserRecordingVideoObjectKey(actor);
    const videoSha256 = createHash("sha256").update(encoded.video).digest("hex");
    await objectStorage.putObject({
      key: videoKey,
      contentType: "video/mp4",
      body: encoded.video,
      sha256: videoSha256,
    });
    await objectStorage.putObject({
      key: browserRecordingActionLogObjectKey(actor),
      contentType: "application/json",
      body: encoded.actionLog,
      sha256: createHash("sha256").update(encoded.actionLog).digest("hex"),
    });
    const completed = await completeBrowserRecordingVideo(db, {
      ...actor,
      video: {
        objectKey: videoKey,
        bytes: encoded.video.byteLength,
        sha256: videoSha256,
        durationMilliseconds: encoded.durationMs,
        width: encoded.width,
        height: encoded.height,
        frameCount: encoded.frameCount,
      },
    });
    // A recording deleted meanwhile removes the bundle with its other objects.
    if (completed) await objectStorage.deleteObject(job.bundle.objectKey);
    return { outcome: "complete" };
  }

  async function failBrowserRecording(
    input: BrowserRecordingVideoInput & { errorCode: string; errorMessage: string },
  ): Promise<void> {
    const { db } = await services();
    await failBrowserRecordingVideo(db, {
      workspaceId: input.workspaceId,
      subjectId: input.ownerSubjectId,
      recordingId: input.recordingId,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    }).catch((error: unknown) => {
      if (!(error instanceof RecordingNotFoundError)) throw error;
    });
  }

  return { createBrowserRecordingFromBundle, encodeBrowserRecordingVideo, failBrowserRecording };
}
