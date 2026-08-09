import { createHash } from "node:crypto";
import { MAX_BOUNDED_OBJECT_CHUNK_BYTES, type BoundedObjectReadPort } from "./bounded-object-read";

export type BoundedObjectWriteErrorCode =
  | "aborted"
  | "backend_failure"
  | "content_hash_mismatch"
  | "invalid_request"
  | "readback_mismatch"
  | "size_limit"
  | "truncated";

export class BoundedObjectWriteError extends Error {
  readonly code: BoundedObjectWriteErrorCode;

  constructor(code: BoundedObjectWriteErrorCode) {
    super(writeErrorMessage(code));
    this.name = "BoundedObjectWriteError";
    this.code = code;
  }
}

export interface ImmutableContentAddressedWriteSession {
  write(chunk: Uint8Array, signal?: AbortSignal): Promise<void>;
  /**
   * Atomically promotes staged bytes to an immutable content-addressed object.
   * The returned reference must resolve forever to this exact generation.
   */
  commit(input: {
    byteSize: number;
    contentHash: string;
    contentType: string;
    signal?: AbortSignal;
  }): Promise<{ opaqueReference: string }>;
  abort(): void | Promise<void>;
}

export interface ImmutableContentAddressedWriteBackend {
  begin(input: {
    contentType: string;
    signal?: AbortSignal;
  }): Promise<ImmutableContentAddressedWriteSession>;
}

export type BoundedImmutableObjectWriteResult = Readonly<{
  opaqueReference: string;
  byteSize: number;
  contentHash: string;
  contentType: string;
}>;

export interface BoundedImmutableObjectWritePort {
  write(input: {
    chunks: AsyncIterable<Uint8Array>;
    contentType: string;
    maxBytes: number;
    expectedByteSize?: number;
    expectedContentHash?: string;
    signal?: AbortSignal;
  }): Promise<BoundedImmutableObjectWriteResult>;
}

/**
 * Streams to provider staging, atomically promotes by digest, then streams the
 * immutable object back and hashes it independently before returning its
 * opaque reference. Neither direction accumulates the complete object.
 */
export function createBoundedImmutableObjectWritePort(input: {
  backend: ImmutableContentAddressedWriteBackend;
  readback: BoundedObjectReadPort;
}): BoundedImmutableObjectWritePort {
  return Object.freeze({
    async write(request: {
      chunks: AsyncIterable<Uint8Array>;
      contentType: string;
      maxBytes: number;
      expectedByteSize?: number;
      expectedContentHash?: string;
      signal?: AbortSignal;
    }): Promise<BoundedImmutableObjectWriteResult> {
      validateWriteRequest(request);
      throwIfAborted(request.signal);
      let session: ImmutableContentAddressedWriteSession | undefined;
      let committed = false;
      try {
        session = await scrubWriteBackend(async () =>
          input.backend.begin({
            contentType: request.contentType,
            ...(request.signal ? { signal: request.signal } : {}),
          }),
        );
        const digest = createHash("sha256");
        let byteSize = 0;
        for await (const sourceChunk of request.chunks) {
          throwIfAborted(request.signal);
          if (!(sourceChunk instanceof Uint8Array) || sourceChunk.byteLength === 0) {
            throw new BoundedObjectWriteError("truncated");
          }
          if (sourceChunk.byteLength > MAX_BOUNDED_OBJECT_CHUNK_BYTES) {
            throw new BoundedObjectWriteError("size_limit");
          }
          byteSize += sourceChunk.byteLength;
          if (byteSize > request.maxBytes) {
            throw new BoundedObjectWriteError("size_limit");
          }
          const chunk = sourceChunk.slice();
          digest.update(chunk);
          await scrubWriteBackend(async () => session!.write(chunk, request.signal));
        }
        // A backend may ignore AbortSignal and resolve the final write after the
        // caller has cancelled. Recheck before publishing staged bytes; without
        // this fence a one-chunk upload could still be committed after abort.
        throwIfAborted(request.signal);
        if (request.expectedByteSize !== undefined && byteSize !== request.expectedByteSize) {
          throw new BoundedObjectWriteError("truncated");
        }
        const contentHash = `sha256:${digest.digest("hex")}`;
        if (
          request.expectedContentHash !== undefined &&
          contentHash !== request.expectedContentHash
        ) {
          throw new BoundedObjectWriteError("content_hash_mismatch");
        }
        const promoted = await scrubWriteBackend(async () =>
          session!.commit({
            byteSize,
            contentHash,
            contentType: request.contentType,
            ...(request.signal ? { signal: request.signal } : {}),
          }),
        );
        validateOpaqueReference(promoted.opaqueReference);
        committed = true;
        // A provider may finish promotion after cancellation despite receiving
        // the signal. The immutable object can be swept, but it must never be
        // returned to a caller as a successful publication candidate.
        throwIfAborted(request.signal);

        const reader = await input.readback.open({
          opaqueReference: promoted.opaqueReference,
          maxBytes: request.maxBytes,
          expectedByteSize: byteSize,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        try {
          if (reader.contentType !== undefined && reader.contentType !== request.contentType) {
            throw new BoundedObjectWriteError("readback_mismatch");
          }
          const readbackHash = createHash("sha256");
          let readbackBytes = 0;
          for await (const chunk of reader.chunks({
            ...(request.signal ? { signal: request.signal } : {}),
          })) {
            readbackBytes += chunk.byteLength;
            if (readbackBytes > byteSize) {
              throw new BoundedObjectWriteError("readback_mismatch");
            }
            readbackHash.update(chunk);
          }
          const readbackContentHash = `sha256:${readbackHash.digest("hex")}`;
          if (readbackBytes !== byteSize || readbackContentHash !== contentHash) {
            throw new BoundedObjectWriteError("readback_mismatch");
          }
          await reader.assertUnchanged(request.signal);
          throwIfAborted(request.signal);
        } finally {
          await reader.close();
        }
        return Object.freeze({
          opaqueReference: promoted.opaqueReference,
          byteSize,
          contentHash,
          contentType: request.contentType,
        });
      } catch (error) {
        throw mapWriteFailure(error, request.signal);
      } finally {
        if (session && !committed) {
          try {
            await session.abort();
          } catch {
            // Best-effort staging cleanup; a sweeper remains the final guard.
          }
        }
      }
    },
  });
}

function validateWriteRequest(input: {
  contentType: string;
  maxBytes: number;
  expectedByteSize?: number;
  expectedContentHash?: string;
}): void {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new BoundedObjectWriteError("invalid_request");
  }
  if (
    input.expectedByteSize !== undefined &&
    (!Number.isSafeInteger(input.expectedByteSize) || input.expectedByteSize < 0)
  ) {
    throw new BoundedObjectWriteError("invalid_request");
  }
  if (
    typeof input.contentType !== "string" ||
    input.contentType.length < 1 ||
    input.contentType.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(input.contentType)
  ) {
    throw new BoundedObjectWriteError("invalid_request");
  }
  if (
    input.expectedContentHash !== undefined &&
    !/^sha256:[0-9a-f]{64}$/.test(input.expectedContentHash)
  ) {
    throw new BoundedObjectWriteError("invalid_request");
  }
}

function validateOpaqueReference(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BoundedObjectWriteError("backend_failure");
  }
}

async function scrubWriteBackend<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BoundedObjectWriteError) throw error;
    throw new BoundedObjectWriteError("backend_failure");
  }
}

function mapWriteFailure(error: unknown, signal: AbortSignal | undefined): BoundedObjectWriteError {
  if (error instanceof BoundedObjectWriteError) return error;
  if (signal?.aborted) return new BoundedObjectWriteError("aborted");
  return new BoundedObjectWriteError("backend_failure");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BoundedObjectWriteError("aborted");
}

function writeErrorMessage(code: BoundedObjectWriteErrorCode): string {
  switch (code) {
    case "aborted":
      return "Bounded object write was cancelled";
    case "backend_failure":
      return "Bounded object write failed";
    case "content_hash_mismatch":
      return "Bounded object digest does not match expected canonical bytes";
    case "invalid_request":
      return "Bounded object write request is invalid";
    case "readback_mismatch":
      return "Immutable object read-back verification failed";
    case "size_limit":
      return "Bounded object write exceeds the configured limit";
    case "truncated":
      return "Bounded object write length does not match expected canonical bytes";
  }
}
