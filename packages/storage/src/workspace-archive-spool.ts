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

/** Restore classification shared with runtime without importing runtime. */
export class WorkspaceArchiveStorageError extends Error {
  constructor(
    readonly code: "archive_base64_invalid" | "archive_hash_mismatch" | "archive_hydration_failed",
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceArchiveStorageError";
  }
}

/** Creates at the caller's deterministic key; never owns/disposes the input spool. */
export async function uploadWorkspaceArchiveSpool(
  storage: ObjectStorage,
  key: string,
  spool: WorkspaceArchiveSpool,
): Promise<void> {
  requireBoundedReads(storage);
  if (!storage.putObjectStreamIfAbsent) {
    throw new WorkspaceArchiveStorageError(
      "archive_hydration_failed",
      "Workspace archive storage unsupported: streaming create-only upload required",
      false,
    );
  }
  const expected = { bytes: spool.byteSize, sha256: spool.sha256 };
  validateExpected(expected);
  let validated = false;
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
      streamFailure = error;
      throw error;
    }
  })();
  let created: boolean;
  try {
    created = await storage.putObjectStreamIfAbsent({
      key,
      contentType: "application/x-tar",
      chunks,
      byteSize: expected.bytes,
      sha256: expected.sha256,
    });
    if (created && !validated) {
      if (streamFailure) throw streamFailure;
      throw new WorkspaceArchiveStorageError(
        "archive_hydration_failed",
        "Workspace archive upload provider did not completely consume and validate the stream",
        false,
      );
    }
  } finally {
    // Providers may reject an existing key without consuming the input, or
    // terminate early. Close any opened file iterator without owning the spool.
    await chunks.return(undefined);
  }
  // A collision is not success until the actual pinned bytes match. Metadata
  // may have been written by a different/untrusted uploader.
  if (!created) await verifyRanges(storage, key, expected);
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
      "archive_base64_invalid",
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
    if (!result)
      throw new WorkspaceArchiveStorageError(
        "archive_base64_invalid",
        "Workspace archive object is missing during range read",
        false,
      );
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
      "archive_base64_invalid",
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
