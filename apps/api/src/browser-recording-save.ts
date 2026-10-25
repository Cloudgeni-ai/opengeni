import type { BrowserRecordingSummary, RecordingVisibility } from "@opengeni/contracts";
import type { ResolvedSessionAuthorization } from "@opengeni/core";
import {
  BrowserControlProtocolError,
  type BrowserControlSessionClient,
} from "@opengeni/runtime/sandbox";
import { retryWhileMissing, type ObjectStorage } from "@opengeni/storage";
import { InteractionResourceStateError } from "@opengeni/db";
import { HTTPException } from "hono/http-exception";

/** How long one save request waits for a recording's bundle to reach storage
 * before answering 202; the caller repeats the request to keep waiting. */
export const BROWSER_RECORDING_UPLOAD_WAIT_MS = 45_000;
export const BROWSER_RECORDING_SAVE_RETRY_AFTER_MS = 2_000;
/** A controller without resumable uploads is waited on in one request, kept
 * under the HTTP server's idle timeout. */
export const BROWSER_RECORDING_LEGACY_EXPORT_TIMEOUT_MS = 200_000;
/** Staged recording objects outlive any save that could still use them. */
export const BROWSER_RECORDING_STAGING_TTL_MS = 6 * 60 * 60 * 1_000;

export type StagedBrowserRecording = {
  recording: BrowserRecordingSummary;
  /** The stored bundle, or null while the browser host is still uploading. */
  bundle: { key: string; sizeBytes: number; sha256: string } | null;
};

/**
 * Stops a recording and moves its bundle into storage at the key
 * `bundleKey` names for it.
 *
 * With `scheduleDeletion`, the browser host uploads in the background and
 * this waits at most {@link BROWSER_RECORDING_UPLOAD_WAIT_MS}: a slow link
 * returns `bundle: null`, and calling again joins the same upload. The bundle
 * is scheduled for deletion first, so nothing is left behind if no caller
 * comes back. Without it, or with a controller that predates
 * background uploads, this waits for the whole upload in one call.
 */
export async function stageBrowserRecordingBundle(input: {
  sessionClient: Pick<
    BrowserControlSessionClient,
    "stopRecording" | "uploadRecording" | "exportRecording"
  >;
  objectStorage: Pick<
    ObjectStorage,
    "createPutUrl" | "getObjectBytes" | "headObject" | "maxSinglePutSizeBytes"
  >;
  recordingId: string;
  bundleKey: (bundle: { sizeBytes: number; sha256: string }) => string;
  audience: "public" | "sandbox";
  uploadTtlSeconds: number;
  scheduleDeletion?: ((objectKeys: string[], deleteAfter: Date) => Promise<void>) | undefined;
  now?: () => number;
}): Promise<StagedBrowserRecording> {
  const { sessionClient, objectStorage, recordingId } = input;
  const recording = await sessionClient.stopRecording(recordingId);
  const expected = recording.bundle;
  if (!expected) {
    throw new InteractionResourceStateError("The recording has nothing to save");
  }
  const bundleKey = input.bundleKey(expected);
  if (expected.sizeBytes > objectStorage.maxSinglePutSizeBytes) {
    throw new HTTPException(413, {
      message: `browser recording exceeds single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes`,
    });
  }
  const now = input.now ?? Date.now;
  await input.scheduleDeletion?.([bundleKey], new Date(now() + BROWSER_RECORDING_STAGING_TTL_MS));
  const put = await objectStorage.createPutUrl({
    key: bundleKey,
    contentType: "application/octet-stream",
    sha256: expected.sha256,
    expiresInSeconds: input.uploadTtlSeconds,
    audience: input.audience,
  });
  const upload = {
    url: put.url,
    requiredHeaders: put.requiredHeaders,
    expiresAt: put.expiresAt.toISOString(),
  };
  const transfer = async (replace: boolean): Promise<"uploading" | "uploaded"> => {
    const status = input.scheduleDeletion
      ? await sessionClient.uploadRecording({
          recordingId,
          upload,
          waitMs: BROWSER_RECORDING_UPLOAD_WAIT_MS,
          ...(replace ? { replace } : {}),
        })
      : null;
    const receipt =
      status ??
      ({
        state: "uploaded",
        ...(await sessionClient.exportRecording(
          { recordingId, upload },
          { timeoutMs: BROWSER_RECORDING_LEGACY_EXPORT_TIMEOUT_MS },
        )),
      } as const);
    if (receipt.sizeBytes !== expected.sizeBytes || receipt.sha256 !== expected.sha256) {
      throw new BrowserControlProtocolError("browser controller returned another recording export");
    }
    return receipt.state;
  };
  // The worker checks the digest when it reads the bundle; here its presence
  // is enough.
  const stored = async () =>
    (await retryWhileMissing(async () =>
      objectStorage.headObject
        ? await objectStorage.headObject(bundleKey)
        : await objectStorage.getObjectBytes(bundleKey),
    )) !== null;
  if ((await transfer(false)) === "uploading") return { recording, bundle: null };
  let present = await stored();
  // An upload the controller finished earlier whose object has since been
  // deleted: upload it again.
  if (!present) {
    if ((await transfer(true)) === "uploading") return { recording, bundle: null };
    present = await stored();
  }
  if (!present) {
    throw new HTTPException(503, { message: "browser recording bundle is not available" });
  }
  return { recording, bundle: { key: bundleKey, ...expected } };
}

/**
 * Who owns an agent's browser recording, and who can see it: it follows the
 * chat. A private chat's recording is its owner's and private; a shared
 * chat's belongs to the person the agent acts for and is shared.
 */
export function browserRecordingOwner(input: {
  authorization: ResolvedSessionAuthorization | null;
  grantSubjectId: string;
  chat: { visibility: "user_private" | "workspace_shared"; ownerSubjectId: string | null } | null;
}): { subjectId: string; visibility: RecordingVisibility } {
  const { chat } = input;
  if (chat?.visibility === "user_private" && chat.ownerSubjectId) {
    return { subjectId: chat.ownerSubjectId, visibility: "private" };
  }
  const actor = input.authorization?.actor;
  const human = actor
    ? actor.kind === "agent_attempt"
      ? actor.initiatingHumanSubjectId
      : actor.subjectId
    : null;
  return {
    subjectId: human ?? chat?.ownerSubjectId ?? input.grantSubjectId,
    visibility: "workspace",
  };
}

/** A failed video's answer: a bundle that is no recording is the caller's
 * problem; anything else is ours. */
export function browserRecordingFailureStatus(errorCode: string | null): 422 | 502 {
  return errorCode === "invalid_bundle" || errorCode === "no_frames" ? 422 : 502;
}
