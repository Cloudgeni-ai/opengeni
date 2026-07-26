// apps/worker/src/activities/recording.ts — the recording finalize helper (P4.3).
//
// The "agent films itself proving the fix" finalize loop, run IN the process that
// already holds the resumed-by-id box (the agent turn's own activity). A scoped
// upload URL sends bytes box → object storage; the worker never buffers the
// recording and no bytes enter a Temporal payload.
//
// Ordering invariant (F9): the box file is deleted ONLY after the storage PUT
// confirms and the `available` row commits — so a failed upload leaves the bytes
// recoverable on the box.

import type { Settings } from "@opengeni/config";
import type { Database } from "@opengeni/db";
import { deleteRecording } from "@opengeni/db";
import type {
  RecordingCodec,
  RecordingFailedReason,
  RecordingStartedPayload,
} from "@opengeni/contracts";
import {
  contentTypeForCodec,
  deleteRecordingArtifacts,
  RecordingError,
  recordingStorageKey,
  startRecording as startRecordingOnBox,
  stopRecording as stopRecordingOnBox,
  uploadRecordingArtifact,
  type RecordingProcess,
} from "@opengeni/runtime";
import type { ObjectStorage } from "@opengeni/storage";
import { DOWNLOAD_URL_TTL_SECONDS } from "@opengeni/storage";

export type RecordingMode = "manual" | "on-turn" | "on-verify";

export type ActiveRecording = {
  recordingId: string;
  turnId: string | null;
  mode: RecordingMode;
  proc: RecordingProcess;
  dimensions: [number, number];
  framerate: number;
};

export const RECORDING_SETTLEMENT_PREP_TIMEOUT_MS = 100_000;
const RECORDING_SETTLEMENT_UPLOAD_MAX_SECONDS = 45;

export async function withRecordingPreparationTimeout(
  preparation: Promise<PreparedRecordingSettlement>,
  timeoutResult: PreparedRecordingSettlement,
  timeoutMs = RECORDING_SETTLEMENT_PREP_TIMEOUT_MS,
): Promise<PreparedRecordingSettlement> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      preparation,
      new Promise<PreparedRecordingSettlement>((resolve) => {
        timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Insert the recording row, launch ffmpeg on the box, and return the live handle.
 * Emits the `recording.started` payload (the caller publishes it on the spine).
 */
export async function beginRecording(args: {
  settings: Settings;
  db: Database;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string | null;
  recordingId: string;
  mode: RecordingMode;
  session: unknown;
  runAs?: string | undefined;
  reason?: string | null;
}): Promise<{ active: ActiveRecording; started: RecordingStartedPayload }> {
  const { settings, db } = args;
  const codec = settings.recordingDefaultCodec as RecordingCodec;
  const dimensions: [number, number] = [
    settings.streamResolutionWidth,
    settings.streamResolutionHeight,
  ];
  const framerate = settings.recordingFramerate;
  await import("@opengeni/db").then(({ insertRecording }) =>
    insertRecording(db, {
      id: args.recordingId,
      accountId: args.accountId,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      turnId: args.turnId,
      mode: args.mode,
      codec,
      width: dimensions[0],
      height: dimensions[1],
      reason: scrubFreeText(args.reason),
    }),
  );
  let proc: RecordingProcess;
  try {
    proc = await startRecordingOnBox(args.session, {
      recordingId: args.recordingId,
      codec,
      framerate,
      maxSeconds: settings.recordingMaxSeconds,
      dimensions,
      ...(args.runAs ? { runAs: args.runAs } : {}),
    });
  } catch (error) {
    await deleteRecording(db, {
      accountId: args.accountId,
      workspaceId: args.workspaceId,
      recordingId: args.recordingId,
    }).catch(() => undefined);
    throw error;
  }
  const active: ActiveRecording = {
    recordingId: args.recordingId,
    turnId: args.turnId,
    mode: args.mode,
    proc,
    dimensions,
    framerate,
  };
  const started: RecordingStartedPayload = {
    recordingId: args.recordingId,
    turnId: args.turnId,
    mode: args.mode,
    codec,
    dimensions,
    framerate,
    startedAt: new Date().toISOString(),
    reason: scrubFreeText(args.reason),
  };
  return { active, started };
}

export type PreparedRecordingSettlement =
  | {
      mutation: {
        action: "available";
        recordingId: string;
        storageKey: string;
        sizeBytes: number;
        durationSeconds: number;
      };
      deleteArtifactsAfterCommit: true;
    }
  | {
      mutation: {
        action: "failed";
        recordingId: string;
        reason: RecordingFailedReason;
        detail: string | null;
      };
      deleteArtifactsAfterCommit: false;
    }
  | {
      mutation: { action: "discard"; recordingId: string };
      deleteArtifactsAfterCommit: true;
    };

/**
 * Prepare an on-turn recording for the attempt-closing settlement. This performs
 * only bounded box/storage work; it does not mutate canonical database state and
 * never deletes the box artifact. The caller folds the returned mutation into the
 * exact attempt-fenced turn settlement, then deletes artifacts only after commit.
 * NEVER throws and never prevents turn truth from settling.
 */
export async function prepareRecordingForSettlement(args: {
  settings: Settings;
  objectStorage: ObjectStorage | null;
  workspaceId: string;
  sessionId: string;
  active: ActiveRecording;
  session: unknown;
  didComputerUse: boolean;
}): Promise<PreparedRecordingSettlement> {
  const { settings, objectStorage, active } = args;
  const codec = active.proc.codec;
  const fail = (
    reason: RecordingFailedReason,
    detail: string | null,
  ): PreparedRecordingSettlement => {
    return {
      mutation: {
        action: "failed",
        recordingId: active.recordingId,
        reason,
        detail: scrubFreeText(detail),
      },
      deleteArtifactsAfterCommit: false,
    };
  };

  const prepare = async (): Promise<PreparedRecordingSettlement> => {
    try {
      await stopRecordingOnBox(args.session, active.proc);
      if (!args.didComputerUse) {
        return {
          mutation: { action: "discard", recordingId: active.recordingId },
          deleteArtifactsAfterCommit: true,
        };
      }
      if (!objectStorage) {
        return fail("upload-failed", "object storage is not configured");
      }
      const key = recordingStorageKey(args.workspaceId, args.sessionId, active.recordingId, codec);
      const upload = await objectStorage.createPutUrl({
        key,
        contentType: contentTypeForCodec(codec),
      });
      const finalized = await uploadRecordingArtifact(args.session, active.proc, {
        url: upload.url,
        requiredHeaders: upload.requiredHeaders,
        maxBytes: settings.recordingMaxBytes,
        maxSeconds: RECORDING_SETTLEMENT_UPLOAD_MAX_SECONDS,
      });
      return {
        mutation: {
          action: "available",
          recordingId: active.recordingId,
          storageKey: key,
          sizeBytes: finalized.sizeBytes,
          durationSeconds: finalized.durationSeconds,
        },
        deleteArtifactsAfterCommit: true,
      };
    } catch (error) {
      const reason: RecordingFailedReason =
        error instanceof RecordingError ? error.reason : "upload-failed";
      return fail(reason, error instanceof Error ? error.message : String(error));
    }
  };

  return await withRecordingPreparationTimeout(
    prepare(),
    fail("upload-failed", "recording settlement preparation timed out"),
  );
}

/**
 * Compensate a start whose fenced `recording.started` event was rejected. Since
 * no canonical event was admitted, this exact recording id must leave no row,
 * process, or box artifact behind.
 */
export async function discardUnpublishedRecording(args: {
  db: Database;
  accountId: string;
  workspaceId: string;
  active: ActiveRecording;
  session: unknown;
}): Promise<void> {
  const { db, active } = args;
  try {
    await stopRecordingOnBox(args.session, active.proc).catch(() => undefined);
    await deleteRecordingArtifacts(args.session, active.proc).catch(() => undefined);
  } finally {
    await deleteRecording(db, {
      accountId: args.accountId,
      workspaceId: args.workspaceId,
      recordingId: active.recordingId,
    }).catch(() => undefined);
  }
}

export { DOWNLOAD_URL_TTL_SECONDS };

// Agent/ffmpeg-controlled free text rides redact() like every payload, but we
// also cap it here (defense in depth — a path/URL with creds shouldn't ride a
// reason/detail field unbounded; the redactor scrubs known secret shapes).
function scrubFreeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).slice(0, 2_000);
  return trimmed.length === 0 ? null : trimmed;
}
