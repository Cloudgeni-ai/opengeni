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
import { deleteRecording, updateRecording } from "@opengeni/db";
import type {
  RecordingAvailablePayload,
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
  const proc = await startRecordingOnBox(args.session, {
    recordingId: args.recordingId,
    codec,
    framerate,
    maxSeconds: settings.recordingMaxSeconds,
    dimensions,
    ...(args.runAs ? { runAs: args.runAs } : {}),
  });
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

export type FinalizeOutcome =
  | { ok: true; available: RecordingAvailablePayload }
  | { ok: false; reason: RecordingFailedReason; detail: string | null };

/**
 * Stop ffmpeg, upload directly from the box, commit `available`,
 * and (only then) delete the box file (F9). Returns the available payload, or a
 * failure reason. NEVER throws — finalize runs in a turn `finally` and must not
 * mask the turn outcome.
 */
export async function finalizeRecording(args: {
  settings: Settings;
  db: Database;
  objectStorage: ObjectStorage | null;
  accountId: string;
  workspaceId: string;
  sessionId: string;
  active: ActiveRecording;
  session: unknown;
  runAs?: string | undefined;
}): Promise<FinalizeOutcome> {
  const { settings, db, objectStorage, active } = args;
  const codec = settings.recordingDefaultCodec as RecordingCodec;
  const fail = async (
    reason: RecordingFailedReason,
    detail: string | null,
  ): Promise<FinalizeOutcome> => {
    await updateRecording(db, {
      accountId: args.accountId,
      workspaceId: args.workspaceId,
      recordingId: active.recordingId,
      state: "failed",
      reason: scrubFreeText(detail),
    }).catch(() => undefined);
    return { ok: false, reason, detail: scrubFreeText(detail) };
  };

  try {
    await updateRecording(db, {
      accountId: args.accountId,
      workspaceId: args.workspaceId,
      recordingId: active.recordingId,
      state: "finalizing",
    }).catch(() => undefined);

    // 1. SIGINT ffmpeg and wait for the clean trailer.
    await stopRecordingOnBox(args.session, active.proc);

    if (!objectStorage) {
      return await fail("upload-failed", "object storage is not configured");
    }

    // 2. Mint one short-lived write URL, then upload DIRECTLY from the box. This
    // keeps worker memory independent of recording size.
    const key = recordingStorageKey(args.workspaceId, args.sessionId, active.recordingId, codec);
    let finalized: Awaited<ReturnType<typeof uploadRecordingArtifact>>;
    try {
      const upload = await objectStorage.createPutUrl({
        key,
        contentType: contentTypeForCodec(codec),
      });
      finalized = await uploadRecordingArtifact(args.session, active.proc, {
        url: upload.url,
        requiredHeaders: upload.requiredHeaders,
        maxBytes: settings.recordingMaxBytes,
      });
    } catch (uploadError) {
      if (uploadError instanceof RecordingError) throw uploadError;
      return await fail(
        "upload-failed",
        uploadError instanceof Error ? uploadError.message : String(uploadError),
      );
    }

    // 3. Commit `available` with the artifact ref.
    await updateRecording(db, {
      accountId: args.accountId,
      workspaceId: args.workspaceId,
      recordingId: active.recordingId,
      state: "available",
      storageKey: key,
      sizeBytes: finalized.sizeBytes,
      durationSeconds: finalized.durationSeconds,
    });

    // 4. ONLY NOW delete the box artifacts (F9 — never before a confirmed PUT).
    await deleteRecordingArtifacts(args.session, active.proc);

    const available: RecordingAvailablePayload = {
      recordingId: active.recordingId,
      turnId: active.turnId,
      codec,
      contentType: contentTypeForCodec(codec),
      storageKey: key,
      durationSeconds: finalized.durationSeconds,
      sizeBytes: finalized.sizeBytes,
      dimensions: active.dimensions,
    };
    return { ok: true, available };
  } catch (error) {
    const reason: RecordingFailedReason =
      error instanceof RecordingError ? error.reason : "ffmpeg-error";
    return await fail(reason, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Discard an on-turn recording that captured NO computer-use activity (a plain
 * text turn): stop ffmpeg on the box, delete the box artifacts, and remove the
 * recording row entirely. NO storage PUT and NO `recording.failed` — a clean
 * no-op. NEVER throws (it runs in the turn `finally` and must not mask the turn
 * outcome). Returns nothing; the caller emits no recording event for a discard.
 */
export async function discardRecording(args: {
  db: Database;
  accountId: string;
  workspaceId: string;
  active: ActiveRecording;
  session: unknown;
}): Promise<void> {
  const { db, active } = args;
  try {
    // Stop ffmpeg cleanly, then delete the partial artifact off the box. Both are
    // best-effort: a stuck box must not strand the discard (the box rides the
    // provider idle-timeout regardless).
    await stopRecordingOnBox(args.session, active.proc).catch(() => undefined);
    await deleteRecordingArtifacts(args.session, active.proc).catch(() => undefined);
  } finally {
    // Remove the phantom row inserted at beginRecording so a no-activity turn
    // leaves no recording trace at all.
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
