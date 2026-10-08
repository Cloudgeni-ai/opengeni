import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ObjectStorage } from "./index";
import { DEFAULT_BOUNDED_OBJECT_CHUNK_BYTES } from "./bounded-object-read";

/** Structural runtime-compatible contract; storage must not depend on runtime. */
export type WorkspaceArchiveSpool = {
  path: string;
  byteSize: number;
  sha256: string;
  open: () => AsyncIterable<Uint8Array>;
  dispose: () => Promise<void>;
};

// Transfer granularity, not an archive size limit.
const CHUNK_BYTES = DEFAULT_BOUNDED_OBJECT_CHUNK_BYTES;
type ExpectedArchive = { bytes: number; sha256: string };

/**
 * Waits before re-verifying a fresh upload that is not yet visible. Object
 * stores without read-after-write consistency (for example replicated
 * self-hosted stores that acknowledge a write on one node) can briefly answer
 * 404 or a stale range right after a successful PUT. About 16 seconds total.
 */
export const WORKSPACE_ARCHIVE_READBACK_RETRY_DELAYS_MS: readonly number[] = [
  250, 500, 1_000, 2_000, 4_000, 8_000,
];

export type UploadWorkspaceArchiveSpoolOptions = {
  readbackRetryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

/** Restore classification shared with runtime without importing runtime. */
export class WorkspaceArchiveStorageError extends Error {
  constructor(
    readonly code: "archive_hash_mismatch" | "archive_hydration_failed" | "archive_object_missing",
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceArchiveStorageError";
  }
}

/**
 * Uploads at a caller-owned fresh unique key and independently verifies readback.
 * Unconditional PUT may overwrite: callers must never reuse published keys.
 * Never owns/disposes the input spool or deletes a failed/unpublished object.
 */
export async function uploadWorkspaceArchiveSpool(
  storage: ObjectStorage,
  key: string,
  spool: WorkspaceArchiveSpool,
  options: UploadWorkspaceArchiveSpoolOptions = {},
): Promise<void> {
  requireBoundedReads(storage);
  if (!storage.putObjectStream) {
    throw new WorkspaceArchiveStorageError(
      "archive_hydration_failed",
      "Workspace archive storage unsupported: unconditional streaming upload required",
      false,
    );
  }
  const expected = { bytes: spool.byteSize, sha256: spool.sha256 };
  validateExpected(expected);
  let validated = false;
  let streamFailed = false;
  let streamFailure: unknown;
  const chunks = (async function* () {
    const digest = createHash("sha256");
    let bytes = 0;
    try {
      for await (const chunk of spool.open()) {
        if (!(chunk instanceof Uint8Array) || chunk.byteLength > expected.bytes - bytes) {
          throw new WorkspaceArchiveStorageError(
            "archive_hash_mismatch",
            "Workspace archive upload stream has invalid size",
            false,
          );
        }
        bytes += chunk.byteLength;
        digest.update(chunk);
        yield chunk;
      }
      if (bytes !== expected.bytes || digest.digest("hex") !== expected.sha256) {
        throw new WorkspaceArchiveStorageError(
          "archive_hash_mismatch",
          "Workspace archive upload stream digest or size mismatch",
          false,
        );
      }
      validated = true;
    } catch (error) {
      streamFailed = true;
      streamFailure = error;
      throw error;
    }
  })();
  try {
    await storage.putObjectStream({
      key,
      contentType: "application/x-tar",
      chunks,
      byteSize: expected.bytes,
      sha256: expected.sha256,
    });
    if (!validated) {
      if (streamFailed) throw streamFailure;
      throw new WorkspaceArchiveStorageError(
        "archive_hydration_failed",
        "Workspace archive upload provider did not completely consume and validate the stream",
        false,
      );
    }
    // A successful PUT and SHA metadata are not proof of stored content.
    await verifyFreshUpload(storage, key, expected, options);
  } catch (error) {
    const failure = streamFailed ? streamFailure : error;
    if (failure instanceof WorkspaceArchiveStorageError) throw failure;
    throw new WorkspaceArchiveStorageError(
      "archive_hydration_failed",
      "Workspace archive upload or readback failed",
      true,
      { cause: failure },
    );
  } finally {
    // Close an early-terminated provider's iterator without owning the spool.
    await chunks.return(undefined);
  }
}

/**
 * Readback of a just-written object. Only "not visible yet" outcomes are
 * retried: a missing object or a pinned range that is temporarily unavailable.
 * Size or digest mismatches still fail immediately.
 */
async function verifyFreshUpload(
  storage: ObjectStorage,
  key: string,
  expected: ExpectedArchive,
  options: UploadWorkspaceArchiveSpoolOptions,
): Promise<void> {
  const delays = options.readbackRetryDelaysMs ?? WORKSPACE_ARCHIVE_READBACK_RETRY_DELAYS_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await verifyRanges(storage, key, expected);
      return;
    } catch (error) {
      const notVisibleYet =
        error instanceof WorkspaceArchiveStorageError &&
        (error.code === "archive_object_missing" ||
          (error.code === "archive_hydration_failed" && error.retryable));
      if (!notVisibleYet || attempt >= delays.length) throw error;
      await sleep(delays[attempt]!);
    }
  }
}

/** Caller owns the returned private spool and must dispose it after use. */
export async function downloadWorkspaceArchiveSpool(
  storage: ObjectStorage,
  key: string,
  inputExpected: ExpectedArchive,
): Promise<WorkspaceArchiveSpool> {
  const expected = { bytes: inputExpected.bytes, sha256: inputExpected.sha256 };
  requireBoundedReads(storage);
  validateExpected(expected);
  const directory = await mkdtemp(join(tmpdir(), "opengeni-workspace-archive-"));
  const path = join(directory, "archive.tar");
  let handle: FileHandle | undefined;
  try {
    await chmod(directory, 0o700);
    handle = await open(path, "wx", 0o600);
    await verifyRanges(storage, key, expected, async (chunk) => {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await handle!.write(chunk, offset, chunk.byteLength - offset);
        if (bytesWritten <= 0)
          throw new WorkspaceArchiveStorageError(
            "archive_hydration_failed",
            "Workspace archive spool write made no progress",
            true,
          );
        offset += bytesWritten;
      }
    });
    await handle.close();
    handle = undefined;
    let disposed = false;
    return {
      path,
      byteSize: expected.bytes,
      sha256: expected.sha256,
      async *open() {
        if (disposed) throw new Error("Workspace archive spool is disposed");
        const stream = createReadStream(path, { highWaterMark: CHUNK_BYTES });
        try {
          for await (const chunk of stream) yield chunk as Uint8Array;
        } finally {
          stream.destroy();
        }
      },
      async dispose() {
        disposed = true;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    if (error instanceof WorkspaceArchiveStorageError) throw error;
    throw new WorkspaceArchiveStorageError(
      "archive_hydration_failed",
      "Workspace archive download failed",
      true,
      { cause: error },
    );
  }
}

function requireBoundedReads(storage: ObjectStorage): void {
  if (!storage.headObject || !storage.getObjectRange) {
    throw new WorkspaceArchiveStorageError(
      "archive_hydration_failed",
      "Workspace archive storage unsupported: versioned head/range reads required",
      false,
    );
  }
}

function validateExpected(expected: ExpectedArchive): void {
  if (
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 0 ||
    !/^[0-9a-f]{64}$/u.test(expected.sha256)
  ) {
    throw new WorkspaceArchiveStorageError(
      "archive_hydration_failed",
      "Workspace archive expected size or SHA-256 is invalid",
      false,
    );
  }
}

async function verifyRanges(
  storage: ObjectStorage,
  key: string,
  expected: ExpectedArchive,
  consume?: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const head = await storage.headObject!(key);
  if (!head)
    throw new WorkspaceArchiveStorageError(
      "archive_object_missing",
      "Workspace archive object is missing",
      false,
    );
  if (head.ContentLength !== expected.bytes)
    throw new WorkspaceArchiveStorageError(
      "archive_hash_mismatch",
      "Workspace archive object size mismatch",
      false,
    );
  const version = head.VersionToken;
  if (typeof version !== "string" || version.length === 0 || version.length > 2048) {
    throw new WorkspaceArchiveStorageError(
      "archive_hydration_failed",
      "Workspace archive storage unsupported: valid object version token required",
      false,
    );
  }
  const digest = createHash("sha256");
  let bytes = 0;
  while (bytes < expected.bytes) {
    const length = Math.min(CHUNK_BYTES, expected.bytes - bytes);
    const result = await storage.getObjectRange!({
      key,
      start: bytes,
      endInclusive: bytes + length - 1,
      expectedVersionToken: version,
    });
    if (!result) {
      // Adapters also return null for failed If-Match/generation reads. Do not
      // classify replacement as permanent loss or retry without a version pin.
      const current = await storage.headObject!(key);
      if (!current) {
        throw new WorkspaceArchiveStorageError(
          "archive_object_missing",
          "Workspace archive object is missing during range read",
          false,
        );
      }
      throw new WorkspaceArchiveStorageError(
        "archive_hydration_failed",
        current.VersionToken !== version
          ? "Workspace archive object version changed"
          : "Workspace archive pinned range is temporarily unavailable",
        true,
      );
    }
    if (result.versionToken !== version)
      throw new WorkspaceArchiveStorageError(
        "archive_hydration_failed",
        "Workspace archive object version changed",
        true,
      );
    if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== length) {
      throw new WorkspaceArchiveStorageError(
        "archive_hash_mismatch",
        "Workspace archive object range is truncated or has invalid size",
        false,
      );
    }
    digest.update(result.bytes);
    await consume?.(result.bytes);
    bytes += result.bytes.byteLength;
  }
  const finalHead = await storage.headObject!(key);
  if (!finalHead)
    throw new WorkspaceArchiveStorageError(
      "archive_object_missing",
      "Workspace archive object is missing after range read",
      false,
    );
  if (finalHead.VersionToken !== version) {
    throw new WorkspaceArchiveStorageError(
      "archive_hydration_failed",
      "Workspace archive object version changed",
      true,
    );
  }
  if (finalHead.ContentLength !== expected.bytes) {
    throw new WorkspaceArchiveStorageError(
      "archive_hash_mismatch",
      "Workspace archive object size changed",
      false,
    );
  }
  if (bytes !== expected.bytes || digest.digest("hex") !== expected.sha256) {
    throw new WorkspaceArchiveStorageError(
      "archive_hash_mismatch",
      "Workspace archive object digest or size mismatch",
      false,
    );
  }
}
