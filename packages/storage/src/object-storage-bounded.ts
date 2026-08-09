import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBoundedObjectReadPort,
  type BoundedObjectReadPort,
  type VersionedRangeObjectBackend,
} from "./bounded-object-read";
import {
  createBoundedImmutableObjectWritePort,
  type BoundedImmutableObjectWritePort,
  type ImmutableContentAddressedWriteBackend,
  type ImmutableContentAddressedWriteSession,
} from "./bounded-object-write";
import type { ObjectStorage } from "./index";

const SNAPSHOT_KEY_PREFIX = "editable-artifacts/snapshots/sha256/";

export type ObjectStorageBoundedPorts = Readonly<{
  read: BoundedObjectReadPort;
  write: BoundedImmutableObjectWritePort;
}>;

export type ObjectStorageBoundedPortsOptions = Readonly<{
  /** Static trusted namespace ending in `/sha256/`. */
  keyPrefix?: string;
}>;

/**
 * Bounded immutable snapshot ports over the standalone object-storage driver.
 * Reads are provider-version pinned. Writes use a canonical digest key and are
 * independently range-read and hashed by the shared verification layer.
 *
 * Provider uploads and readback are streaming. Staging uses one private local
 * file so content-addressed naming never requires retaining the object in RAM.
 * There is no whole-object fallback when a provider lacks these primitives.
 */
export function createObjectStorageBoundedPorts(
  storage: ObjectStorage,
  options: ObjectStorageBoundedPortsOptions = {},
): ObjectStorageBoundedPorts {
  if (!storage.headObject || !storage.getObjectRange || !storage.putObjectStreamIfAbsent) {
    throw new Error("Object storage lacks streaming immutable create/versioned range primitives");
  }
  const keyPrefix = validateKeyPrefix(options.keyPrefix ?? SNAPSHOT_KEY_PREFIX);
  const referenceHash = (reference: string) => hashForReference(reference, keyPrefix);
  const read = createBoundedObjectReadPort(versionedBackend(storage, referenceHash));
  const write = createBoundedImmutableObjectWritePort({
    backend: immutableWriteBackend(storage, keyPrefix),
    readback: read,
  });
  return Object.freeze({ read, write });
}

function versionedBackend(
  storage: ObjectStorage,
  hashForReferenceValue: (reference: string) => string,
): VersionedRangeObjectBackend {
  const headObject = storage.headObject!;
  const getObjectRange = storage.getObjectRange!;
  return Object.freeze({
    async describe(input: Parameters<VersionedRangeObjectBackend["describe"]>[0]) {
      const expectedHash = hashForReferenceValue(input.opaqueReference);
      throwIfAborted(input.signal);
      const head = await headObject(input.opaqueReference);
      throwIfAborted(input.signal);
      if (!head) return null;
      if (
        !Number.isSafeInteger(head.ContentLength) ||
        head.ContentLength! < 0 ||
        typeof head.VersionToken !== "string" ||
        head.VersionToken.length < 1 ||
        head.VersionToken.length > 2048 ||
        head.Metadata?.sha256 !== expectedHash
      ) {
        throw new Error("Immutable object metadata is invalid");
      }
      return Object.freeze({
        byteSize: head.ContentLength!,
        versionToken: head.VersionToken,
        immutableReference: true as const,
        ...(head.ContentType ? { contentType: head.ContentType } : {}),
      });
    },
    async readRange(input: Parameters<VersionedRangeObjectBackend["readRange"]>[0]) {
      hashForReferenceValue(input.opaqueReference);
      throwIfAborted(input.signal);
      const result = await getObjectRange({
        key: input.opaqueReference,
        start: input.start,
        endInclusive: input.endInclusive,
        expectedVersionToken: input.expectedVersionToken,
      });
      throwIfAborted(input.signal);
      if (!result) return null;
      return Object.freeze({
        bytes: result.bytes.slice(),
        versionToken: result.versionToken,
      });
    },
  });
}

function immutableWriteBackend(
  storage: ObjectStorage,
  keyPrefix: string,
): ImmutableContentAddressedWriteBackend {
  return Object.freeze({
    async begin(
      input: Parameters<ImmutableContentAddressedWriteBackend["begin"]>[0],
    ): Promise<ImmutableContentAddressedWriteSession> {
      validateContentType(input.contentType);
      throwIfAborted(input.signal);
      const stagingDirectory = await mkdtemp(join(tmpdir(), "opengeni-artifact-write-"));
      const stagingPath = join(stagingDirectory, "payload");
      let handle: FileHandle | null = null;
      try {
        await chmod(stagingDirectory, 0o700);
        throwIfAborted(input.signal);
        handle = await open(stagingPath, "wx", 0o600);
      } catch (error) {
        await rm(stagingDirectory, { recursive: true, force: true });
        throw error;
      }
      let byteSize = 0;
      let closed = false;
      let cleaned = false;
      const digest = createHash("sha256");
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        if (handle) {
          const closing = handle;
          handle = null;
          await closing.close().catch(() => undefined);
        }
        await rm(stagingDirectory, { recursive: true, force: true });
      };
      return {
        async write(chunk: Uint8Array, signal?: AbortSignal) {
          if (closed) throw new Error("Immutable write session is closed");
          throwIfAborted(signal);
          if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
            throw new Error("Immutable write chunk is invalid");
          }
          await writeAll(handle!, chunk, byteSize);
          digest.update(chunk);
          byteSize += chunk.byteLength;
        },
        async commit(commit: Parameters<ImmutableContentAddressedWriteSession["commit"]>[0]) {
          if (closed) throw new Error("Immutable write session is closed");
          closed = true;
          try {
            throwIfAborted(commit.signal);
            if (commit.contentType !== input.contentType || commit.byteSize !== byteSize) {
              throw new Error("Immutable write commit metadata changed");
            }
            const contentHash = `sha256:${digest.digest("hex")}`;
            if (contentHash !== commit.contentHash) {
              throw new Error("Immutable write digest changed");
            }
            const opaqueReference = `${keyPrefix}${contentHash.slice("sha256:".length)}`;
            const closing = handle!;
            handle = null;
            await closing.close();
            const existing = await storage.headObject!(opaqueReference);
            if (existing) {
              assertStoredObject(existing, byteSize, contentHash, input.contentType);
            } else {
              await storage.putObjectStreamIfAbsent!({
                key: opaqueReference,
                contentType: input.contentType,
                chunks: fileChunks(stagingPath, byteSize, commit.signal),
                byteSize,
                sha256: contentHash,
                ...(commit.signal ? { signal: commit.signal } : {}),
              });
              const stored = await storage.headObject!(opaqueReference);
              if (!stored) throw new Error("Immutable object was not visible after write");
              assertStoredObject(stored, byteSize, contentHash, input.contentType);
            }
            throwIfAborted(commit.signal);
            return Object.freeze({ opaqueReference });
          } finally {
            await cleanup();
          }
        },
        async abort() {
          closed = true;
          byteSize = 0;
          await cleanup();
        },
      };
    },
  });
}

function assertStoredObject(
  head: Awaited<ReturnType<NonNullable<ObjectStorage["headObject"]>>>,
  byteSize: number,
  contentHash: string,
  contentType: string,
): void {
  if (
    !head ||
    head.ContentLength !== byteSize ||
    head.Metadata?.sha256 !== contentHash ||
    head.ContentType !== contentType ||
    typeof head.VersionToken !== "string" ||
    head.VersionToken.length < 1
  ) {
    throw new Error("Immutable content-addressed object conflicts with stored metadata");
  }
}

function hashForReference(reference: string, keyPrefix: string): string {
  const match = new RegExp(`^${escapeRegExp(keyPrefix)}([0-9a-f]{64})$`, "u").exec(reference);
  if (!match) throw new Error("Immutable snapshot reference is malformed");
  return `sha256:${match[1]}`;
}

function validateKeyPrefix(value: string): string {
  if (
    typeof value !== "string" ||
    !/^editable-artifacts\/[a-z0-9/-]+\/sha256\/$/u.test(value) ||
    value.includes("//") ||
    value.includes("..")
  ) {
    throw new Error("Immutable object key prefix is invalid");
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validateContentType(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Immutable object content type is invalid");
  }
}

async function* fileChunks(
  path: string,
  expectedByteSize: number,
  signal: AbortSignal | undefined,
): AsyncIterableIterator<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(1024 * 1024);
    let offset = 0;
    while (offset < expectedByteSize) {
      throwIfAborted(signal);
      const length = Math.min(buffer.byteLength, expectedByteSize - offset);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, offset + filled);
        if (bytesRead <= 0) throw new Error("Immutable staging file was truncated");
        filled += bytesRead;
      }
      offset += filled;
      yield buffer.slice(0, filled);
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, expectedByteSize)).bytesRead !== 0) {
      throw new Error("Immutable staging file exceeded its committed size");
    }
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      position + offset,
    );
    if (bytesWritten <= 0) throw new Error("Immutable staging write was truncated");
    offset += bytesWritten;
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Object storage operation was cancelled");
}
