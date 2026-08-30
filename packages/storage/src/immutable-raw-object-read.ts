import type { ObjectStorage } from "./index";

export const DEFAULT_IMMUTABLE_RAW_OBJECT_CHUNK_BYTES = 1024 * 1024;
export const MAX_IMMUTABLE_RAW_OBJECT_CHUNK_BYTES = 8 * 1024 * 1024;

export type ImmutableRawObjectReadErrorCode =
  | "aborted"
  | "backend_failure"
  | "invalid_object"
  | "invalid_request"
  | "object_changed"
  | "truncated";

export class ImmutableRawObjectReadError extends Error {
  readonly code: ImmutableRawObjectReadErrorCode;

  constructor(code: ImmutableRawObjectReadErrorCode) {
    super(messageForCode(code));
    this.name = "ImmutableRawObjectReadError";
    this.code = code;
  }
}

export type ImmutableRawObjectHead = Readonly<{
  byteSize: number;
  versionToken: string;
  contentType?: string;
}>;

export type ImmutableRawObjectRange = Readonly<{
  bytes: Uint8Array;
  versionToken: string;
}>;

export type ImmutableRawObjectRangeRequest = Readonly<{
  key: string;
  start: number;
  endInclusive: number;
  expectedVersionToken: string;
  chunkBytes?: number;
  signal?: AbortSignal;
}>;

/**
 * Narrow raw-key serving boundary for already-authorized immutable objects.
 *
 * This port does not know tenants, files, signed URLs, buckets, or credentials.
 * Callers must resolve an authorized immutable key before invoking it. Every
 * range is pinned to the exact opaque generation returned by `head`.
 */
export interface ImmutableRawObjectReader {
  head(input: { key: string; signal?: AbortSignal }): Promise<ImmutableRawObjectHead | null>;
  readRange(input: {
    key: string;
    start: number;
    endInclusive: number;
    expectedVersionToken: string;
    signal?: AbortSignal;
  }): Promise<ImmutableRawObjectRange | null>;
  streamRange(input: ImmutableRawObjectRangeRequest): ReadableStream<Uint8Array>;
}

/**
 * Adapt the provider-neutral ObjectStorage driver to the immutable serving
 * contract. There is deliberately no whole-object fallback when a backend does
 * not implement raw HEAD plus conditional ranges.
 */
export function createImmutableRawObjectReader(
  storage: Pick<ObjectStorage, "headObject" | "getObjectRange">,
): ImmutableRawObjectReader {
  if (!storage.headObject || !storage.getObjectRange) {
    throw new Error("Object storage lacks raw HEAD/conditional-range support");
  }
  const headObject = storage.headObject;
  const getObjectRange = storage.getObjectRange;

  const head: ImmutableRawObjectReader["head"] = async (input) => {
    validateKey(input.key);
    throwIfAborted(input.signal);
    const result = await scrubBackendFailure(async () => await headObject(input.key));
    throwIfAborted(input.signal);
    if (!result) return null;
    if (
      !Number.isSafeInteger(result.ContentLength) ||
      result.ContentLength! < 0 ||
      typeof result.VersionToken !== "string" ||
      result.VersionToken.length < 1 ||
      result.VersionToken.length > 2_048 ||
      (result.ContentType !== undefined && !validContentType(result.ContentType))
    ) {
      throw new ImmutableRawObjectReadError("invalid_object");
    }
    return Object.freeze({
      byteSize: result.ContentLength!,
      versionToken: result.VersionToken,
      ...(result.ContentType ? { contentType: result.ContentType } : {}),
    });
  };

  const readRange: ImmutableRawObjectReader["readRange"] = async (input) => {
    validateRange(input);
    throwIfAborted(input.signal);
    const result = await scrubBackendFailure(async () =>
      getObjectRange({
        key: input.key,
        start: input.start,
        endInclusive: input.endInclusive,
        expectedVersionToken: input.expectedVersionToken,
      }),
    );
    throwIfAborted(input.signal);
    if (!result) return null;
    if (result.versionToken !== input.expectedVersionToken) {
      throw new ImmutableRawObjectReadError("object_changed");
    }
    const expectedBytes = input.endInclusive - input.start + 1;
    if (result.bytes.byteLength !== expectedBytes) {
      throw new ImmutableRawObjectReadError("truncated");
    }
    return Object.freeze({
      bytes: result.bytes.slice(),
      versionToken: result.versionToken,
    });
  };

  return Object.freeze({
    head,
    readRange,
    streamRange(input: ImmutableRawObjectRangeRequest) {
      validateRange(input);
      const chunkBytes = input.chunkBytes ?? DEFAULT_IMMUTABLE_RAW_OBJECT_CHUNK_BYTES;
      if (
        !Number.isSafeInteger(chunkBytes) ||
        chunkBytes < 1 ||
        chunkBytes > MAX_IMMUTABLE_RAW_OBJECT_CHUNK_BYTES
      ) {
        throw new ImmutableRawObjectReadError("invalid_request");
      }
      throwIfAborted(input.signal);
      let offset = input.start;
      let cancelled = false;

      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cancelled) return;
          try {
            throwIfAborted(input.signal);
            if (offset > input.endInclusive) {
              controller.close();
              return;
            }
            const endInclusive = Math.min(input.endInclusive, offset + chunkBytes - 1);
            const range = await readRange({
              key: input.key,
              start: offset,
              endInclusive,
              expectedVersionToken: input.expectedVersionToken,
              ...(input.signal ? { signal: input.signal } : {}),
            });
            if (!range) {
              throw new ImmutableRawObjectReadError("object_changed");
            }
            offset = endInclusive + 1;
            controller.enqueue(range.bytes);
          } catch (error) {
            cancelled = true;
            controller.error(error);
          }
        },
        cancel() {
          cancelled = true;
        },
      });
    },
  });
}

function validateKey(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2_048 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new ImmutableRawObjectReadError("invalid_request");
  }
}

function validateRange(input: {
  key: string;
  start: number;
  endInclusive: number;
  expectedVersionToken: string;
}): void {
  validateKey(input.key);
  if (
    !Number.isSafeInteger(input.start) ||
    !Number.isSafeInteger(input.endInclusive) ||
    input.start < 0 ||
    input.endInclusive < input.start ||
    typeof input.expectedVersionToken !== "string" ||
    input.expectedVersionToken.length < 1 ||
    input.expectedVersionToken.length > 2_048
  ) {
    throw new ImmutableRawObjectReadError("invalid_request");
  }
}

function validContentType(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 255 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ImmutableRawObjectReadError("aborted");
}

async function scrubBackendFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ImmutableRawObjectReadError) throw error;
    throw new ImmutableRawObjectReadError("backend_failure");
  }
}

function messageForCode(code: ImmutableRawObjectReadErrorCode): string {
  switch (code) {
    case "aborted":
      return "Immutable object read was aborted";
    case "invalid_request":
      return "Immutable object read request is invalid";
    case "invalid_object":
      return "Immutable object metadata is invalid";
    case "object_changed":
      return "Immutable object changed during read";
    case "truncated":
      return "Immutable object range was truncated";
    case "backend_failure":
      return "Immutable object storage is unavailable";
  }
}
