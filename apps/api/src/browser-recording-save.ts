import type { BrowserRecordingSummary } from "@opengeni/contracts";
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
  /** The bundle bytes, or null while the browser host is still uploading. */
  bundle: Uint8Array | null;
};

/**
 * Stops a recording and moves its bundle into storage at `bundleKey`.
 *
 * With `scheduleDeletion`, the browser host uploads in the background and
 * this waits at most {@link BROWSER_RECORDING_UPLOAD_WAIT_MS}: a slow link
 * returns `bundle: null`, and calling again joins the same upload. The staged
 * keys are scheduled for deletion first, so nothing is left behind if no
 * caller comes back. Without it, or with a controller that predates
 * background uploads, this waits for the whole upload in one call.
 */
export async function stageBrowserRecordingBundle(input: {
  sessionClient: Pick<
    BrowserControlSessionClient,
    "stopRecording" | "uploadRecording" | "exportRecording"
  >;
  objectStorage: Pick<ObjectStorage, "createPutUrl" | "getObjectBytes" | "maxSinglePutSizeBytes">;
  recordingId: string;
  bundleKey: string;
  /** Keys to delete with the bundle once they can no longer be in use. */
  stagedKeys: readonly string[];
  audience: "public" | "sandbox";
  uploadTtlSeconds: number;
  scheduleDeletion?: ((objectKeys: string[], deleteAfter: Date) => Promise<void>) | undefined;
  now?: () => number;
}): Promise<StagedBrowserRecording> {
  const { sessionClient, objectStorage, recordingId, bundleKey } = input;
  const recording = await sessionClient.stopRecording(recordingId);
  const expected = recording.bundle;
  if (!expected) {
    throw new InteractionResourceStateError("The recording has nothing to save");
  }
  if (expected.sizeBytes > objectStorage.maxSinglePutSizeBytes) {
    throw new HTTPException(413, {
      message: `browser recording exceeds single PUT limit of ${objectStorage.maxSinglePutSizeBytes} bytes`,
    });
  }
  const now = input.now ?? Date.now;
  await input.scheduleDeletion?.(
    [bundleKey, ...input.stagedKeys],
    new Date(now() + BROWSER_RECORDING_STAGING_TTL_MS),
  );
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
  const read = async () =>
    await retryWhileMissing(async () => await objectStorage.getObjectBytes(bundleKey));
  if ((await transfer(false)) === "uploading") return { recording, bundle: null };
  let bundle = await read();
  // An upload the controller finished earlier whose object has since been
  // deleted: upload it again.
  if (!bundle) {
    if ((await transfer(true)) === "uploading") return { recording, bundle: null };
    bundle = await read();
  }
  if (!bundle) {
    throw new HTTPException(503, { message: "browser recording bundle is not available" });
  }
  return { recording, bundle: bundle.bytes };
}
