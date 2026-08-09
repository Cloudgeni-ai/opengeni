/**
 * Version-pinned, bounded object reads for large trusted-server workloads.
 *
 * This surface deliberately deals in opaque references. Provider keys, bucket
 * names, signed URLs, and provider diagnostics stay behind the backend
 * callback and are never included in returned values or public errors.
 */

export const DEFAULT_BOUNDED_OBJECT_CHUNK_BYTES = 1024 * 1024;
export const MAX_BOUNDED_OBJECT_CHUNK_BYTES = 8 * 1024 * 1024;

export type BoundedObjectReadErrorCode =
  | "aborted"
  | "backend_failure"
  | "invalid_request"
  | "object_changed"
  | "object_missing"
  | "size_limit"
  | "truncated";

export class BoundedObjectReadError extends Error {
  readonly code: BoundedObjectReadErrorCode;

  constructor(code: BoundedObjectReadErrorCode) {
    super(messageForCode(code));
    this.name = "BoundedObjectReadError";
    this.code = code;
  }
}

export type VersionedObjectDescription = Readonly<{
  byteSize: number;
  /** Opaque provider generation/etag token. It never crosses this package. */
  versionToken: string;
  /**
   * Explicit adapter assertion that the opaque reference resolves forever to
   * this provider generation (for example a version id or immutable
   * content-addressed object). Mutable raw keys must never set this flag.
   */
  immutableReference: true;
  contentType?: string;
}>;

export type VersionedObjectRange = Readonly<{
  bytes: Uint8Array;
  versionToken: string;
}>;

/**
 * Provider adapter used by the range reader. Implementations should use a
 * provider-native generation/version/If-Match condition whenever available.
 * Returning a different version is treated as replacement, never as data.
 */
export interface VersionedRangeObjectBackend {
  describe(input: {
    opaqueReference: string;
    signal?: AbortSignal;
  }): Promise<VersionedObjectDescription | null>;
  readRange(input: {
    opaqueReference: string;
    start: number;
    endInclusive: number;
    expectedVersionToken: string;
    signal?: AbortSignal;
  }): Promise<VersionedObjectRange | null>;
  close?(input: { opaqueReference: string }): void | Promise<void>;
}

export interface BoundedObjectRead {
  readonly byteSize: number;
  readonly contentType: string | undefined;
  /** A read handle is intentionally single-use. */
  chunks(input?: { chunkBytes?: number; signal?: AbortSignal }): AsyncIterable<Uint8Array>;
  /** Revalidate the immutable provider generation after all consumers finish. */
  assertUnchanged(signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface BoundedObjectReadPort {
  open(input: {
    opaqueReference: string;
    maxBytes: number;
    expectedByteSize?: number;
    signal?: AbortSignal;
  }): Promise<BoundedObjectRead>;
}

/**
 * Adds uniform limits, exact-range checks, replacement fencing, cancellation,
 * and diagnostic scrubbing around a provider-specific range backend.
 */
export function createBoundedObjectReadPort(
  backend: VersionedRangeObjectBackend,
): BoundedObjectReadPort {
  return Object.freeze({
    async open(input: {
      opaqueReference: string;
      maxBytes: number;
      expectedByteSize?: number;
      signal?: AbortSignal;
    }): Promise<BoundedObjectRead> {
      validateReference(input.opaqueReference);
      assertPositiveSafeInteger(input.maxBytes);
      if (input.expectedByteSize !== undefined) {
        assertNonnegativeSafeInteger(input.expectedByteSize);
      }
      throwIfAborted(input.signal);
      const description = await scrubBackendFailure(async () =>
        backend.describe({
          opaqueReference: input.opaqueReference,
          ...(input.signal ? { signal: input.signal } : {}),
        }),
      );
      // Provider adapters are allowed to receive AbortSignal, but correctness
      // cannot depend on every SDK honouring it while an I/O promise is active.
      throwIfAborted(input.signal);
      if (!description) throw new BoundedObjectReadError("object_missing");
      validateDescription(description);
      if (description.byteSize > input.maxBytes) {
        throw new BoundedObjectReadError("size_limit");
      }
      if (input.expectedByteSize !== undefined && description.byteSize !== input.expectedByteSize) {
        throw new BoundedObjectReadError("truncated");
      }
      return new VersionPinnedBoundedObjectRead(backend, input.opaqueReference, description);
    },
  });
}

class VersionPinnedBoundedObjectRead implements BoundedObjectRead {
  readonly byteSize: number;
  readonly contentType: string | undefined;
  readonly #backend: VersionedRangeObjectBackend;
  readonly #opaqueReference: string;
  readonly #versionToken: string;
  #claimed = false;
  #closed = false;

  constructor(
    backend: VersionedRangeObjectBackend,
    opaqueReference: string,
    description: VersionedObjectDescription,
  ) {
    this.#backend = backend;
    this.#opaqueReference = opaqueReference;
    this.#versionToken = description.versionToken;
    this.byteSize = description.byteSize;
    this.contentType = description.contentType;
  }

  chunks(
    input: {
      chunkBytes?: number;
      signal?: AbortSignal;
    } = {},
  ): AsyncIterable<Uint8Array> {
    if (this.#closed || this.#claimed) {
      throw new BoundedObjectReadError("invalid_request");
    }
    const chunkBytes = input.chunkBytes ?? DEFAULT_BOUNDED_OBJECT_CHUNK_BYTES;
    assertPositiveSafeInteger(chunkBytes);
    if (chunkBytes > MAX_BOUNDED_OBJECT_CHUNK_BYTES) {
      throw new BoundedObjectReadError("size_limit");
    }
    this.#claimed = true;
    return this.#streamChunks(chunkBytes, input.signal);
  }

  async *#streamChunks(
    chunkBytes: number,
    signal: AbortSignal | undefined,
  ): AsyncIterableIterator<Uint8Array> {
    let offset = 0;
    let completed = false;
    try {
      while (offset < this.byteSize) {
        throwIfAborted(signal);
        if (this.#closed) {
          throw new BoundedObjectReadError("invalid_request");
        }
        const endInclusive = Math.min(this.byteSize - 1, offset + chunkBytes - 1);
        const range = await scrubBackendFailure(async () =>
          this.#backend.readRange({
            opaqueReference: this.#opaqueReference,
            start: offset,
            endInclusive,
            expectedVersionToken: this.#versionToken,
            ...(signal ? { signal } : {}),
          }),
        );
        throwIfAborted(signal);
        if (!range) {
          throw new BoundedObjectReadError("object_changed");
        }
        if (range.versionToken !== this.#versionToken) {
          throw new BoundedObjectReadError("object_changed");
        }
        const expectedLength = endInclusive - offset + 1;
        if (range.bytes.byteLength !== expectedLength) {
          throw new BoundedObjectReadError("truncated");
        }
        offset += range.bytes.byteLength;
        // Detach consumers from mutable provider buffers.
        yield range.bytes.slice();
      }
      throwIfAborted(signal);
      completed = true;
    } finally {
      // Keep a successfully consumed handle live for the mandatory final
      // generation check. Early return, failure, and cancellation clean up
      // immediately; normal callers close after assertUnchanged().
      if (!completed) await this.close();
    }
  }

  async assertUnchanged(signal?: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new BoundedObjectReadError("invalid_request");
    }
    throwIfAborted(signal);
    const current = await scrubBackendFailure(async () =>
      this.#backend.describe({
        opaqueReference: this.#opaqueReference,
        ...(signal ? { signal } : {}),
      }),
    );
    throwIfAborted(signal);
    if (
      !current ||
      current.versionToken !== this.#versionToken ||
      current.byteSize !== this.byteSize
    ) {
      throw new BoundedObjectReadError("object_changed");
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#backend.close) return;
    try {
      await this.#backend.close({ opaqueReference: this.#opaqueReference });
    } catch {
      // Cleanup is best-effort and must not replace the verification result.
    }
  }
}

async function scrubBackendFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof BoundedObjectReadError) throw error;
    throw new BoundedObjectReadError("backend_failure");
  }
}

function validateReference(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new BoundedObjectReadError("invalid_request");
  }
}

function validateDescription(value: VersionedObjectDescription): void {
  assertNonnegativeSafeInteger(value.byteSize);
  if (value.immutableReference !== true) {
    throw new BoundedObjectReadError("backend_failure");
  }
  if (
    typeof value.versionToken !== "string" ||
    value.versionToken.length < 1 ||
    value.versionToken.length > 2048
  ) {
    throw new BoundedObjectReadError("backend_failure");
  }
  if (
    value.contentType !== undefined &&
    (value.contentType.length < 1 || value.contentType.length > 256)
  ) {
    throw new BoundedObjectReadError("backend_failure");
  }
}

function assertPositiveSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BoundedObjectReadError("invalid_request");
  }
}

function assertNonnegativeSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BoundedObjectReadError("invalid_request");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new BoundedObjectReadError("aborted");
}

function messageForCode(code: BoundedObjectReadErrorCode): string {
  switch (code) {
    case "aborted":
      return "Bounded object read was cancelled";
    case "backend_failure":
      return "Bounded object read failed";
    case "invalid_request":
      return "Bounded object read request is invalid";
    case "object_changed":
      return "Bounded object changed during verification";
    case "object_missing":
      return "Bounded object is unavailable";
    case "size_limit":
      return "Bounded object exceeds the configured limit";
    case "truncated":
      return "Bounded object length does not match its immutable metadata";
  }
}
