export type JsonBase64FieldShape = "string" | "first_array_string";

export type ReadJsonBase64FieldOptions = {
  fieldName: string;
  shape: JsonBase64FieldShape;
  maxResponseBytes: number;
  maxDecodedBytes: number;
  label: string;
  signal?: AbortSignal;
};

/** A bounded provider response violated the expected JSON/base64 wire contract. */
export class JsonBase64ResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonBase64ResponseError";
  }
}

/**
 * Decode one JSON base64 field directly from a response stream.
 *
 * This deliberately does not materialize the JSON envelope or encoded string.
 * It accepts only canonical base64 and returns after the first matching value,
 * cancelling the unread response tail. The caller still validates the decoded
 * media bytes; this function owns only the bounded wire representation.
 */
export async function readJsonBase64Field(
  response: Response,
  options: ReadJsonBase64FieldOptions,
): Promise<Uint8Array> {
  assertOptions(options);
  declaredResponseLength(response, options.maxResponseBytes, options.label);
  if (!response.body) {
    throw new JsonBase64ResponseError(`${options.label} returned no response body`);
  }

  const reader = response.body.getReader();
  const writer = new BoundedByteWriter(
    options.maxDecodedBytes,
    Math.min(64 * 1024, options.maxDecodedBytes),
    options.label,
  );
  const key = new TextEncoder().encode(options.fieldName);
  const quartet = new Uint8Array(4);
  let quartetLength = 0;
  let received = 0;
  let inString = false;
  let escaped = false;
  let keyCouldMatch = false;
  let keyIndex = 0;
  let awaitingColon = false;
  let awaitingValue = false;
  let awaitingArrayItem = false;
  let readingBase64 = false;
  let base64Ended = false;

  try {
    for (;;) {
      const next = await readChunk(reader, options.signal, options.label);
      if (next.done) break;
      received += next.value.byteLength;
      if (received > options.maxResponseBytes) {
        throw new JsonBase64ResponseError(`${options.label} exceeded its response byte limit`);
      }

      for (const byte of next.value) {
        if (readingBase64) {
          if (byte === 0x22) {
            if (quartetLength !== 0 || writer.length === 0) {
              throw new JsonBase64ResponseError(`${options.label} returned malformed base64`);
            }
            await reader.cancel("requested base64 field decoded").catch(() => undefined);
            return writer.value();
          }
          if (base64Ended || byte === 0x5c || !isBase64Byte(byte)) {
            throw new JsonBase64ResponseError(`${options.label} returned malformed base64`);
          }
          quartet[quartetLength++] = byte;
          if (quartetLength === 4) {
            base64Ended = decodeBase64Quartet(quartet, writer, options.label);
            quartetLength = 0;
          }
          continue;
        }

        if (inString) {
          if (escaped) {
            escaped = false;
            keyCouldMatch = false;
            continue;
          }
          if (byte === 0x5c) {
            escaped = true;
            keyCouldMatch = false;
            continue;
          }
          if (byte === 0x22) {
            inString = false;
            if (keyCouldMatch && keyIndex === key.length) awaitingColon = true;
            continue;
          }
          if (keyCouldMatch) {
            if (keyIndex < key.length && byte === key[keyIndex]) keyIndex += 1;
            else keyCouldMatch = false;
          }
          continue;
        }

        if (awaitingColon) {
          if (isJsonWhitespace(byte)) continue;
          awaitingColon = false;
          if (byte === 0x3a) {
            awaitingValue = true;
            continue;
          }
        }
        if (awaitingValue) {
          if (isJsonWhitespace(byte)) continue;
          awaitingValue = false;
          if (options.shape === "first_array_string") {
            if (byte !== 0x5b) {
              throw new JsonBase64ResponseError(
                `${options.label} returned an invalid base64 array`,
              );
            }
            awaitingArrayItem = true;
            continue;
          }
          if (byte !== 0x22) {
            throw new JsonBase64ResponseError(`${options.label} returned an invalid base64 field`);
          }
          readingBase64 = true;
          continue;
        }
        if (awaitingArrayItem) {
          if (isJsonWhitespace(byte)) continue;
          awaitingArrayItem = false;
          if (byte !== 0x22) {
            throw new JsonBase64ResponseError(`${options.label} returned no base64 array item`);
          }
          readingBase64 = true;
          continue;
        }
        if (byte === 0x22) {
          inString = true;
          escaped = false;
          keyCouldMatch = true;
          keyIndex = 0;
        }
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation can release the lock asynchronously in some fetch implementations.
    }
  }
  throw new JsonBase64ResponseError(`${options.label} returned no base64 image data`);
}

function assertOptions(options: ReadJsonBase64FieldOptions): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.fieldName)) {
    throw new TypeError("JSON base64 field name must be a simple ASCII identifier");
  }
  if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0) {
    throw new RangeError("JSON response byte limit must be a positive safe integer");
  }
  if (!Number.isSafeInteger(options.maxDecodedBytes) || options.maxDecodedBytes <= 0) {
    throw new RangeError("decoded base64 byte limit must be a positive safe integer");
  }
  if (!options.label.trim()) throw new TypeError("JSON base64 response label is empty");
}

function declaredResponseLength(
  response: Response,
  maxBytes: number,
  label: string,
): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) {
    void response.body?.cancel("invalid content length").catch(() => undefined);
    throw new JsonBase64ResponseError(`${label} returned an invalid content length`);
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    void response.body?.cancel("response exceeds byte limit").catch(() => undefined);
    throw new JsonBase64ResponseError(`${label} exceeded its response byte limit`);
  }
  return length;
}

type StreamRead = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  label: string,
): Promise<StreamRead> {
  if (!signal) return await reader.read();
  if (signal.aborted) throw new DOMException(`${label} was aborted`, "AbortError");
  return await new Promise<StreamRead>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new DOMException(`${label} was aborted`, "AbortError")));
    signal.addEventListener("abort", onAbort, { once: true });
    void reader.read().then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

class BoundedByteWriter {
  private bytes: Uint8Array;
  length = 0;

  constructor(
    private readonly maxBytes: number,
    initialCapacity: number,
    private readonly label: string,
  ) {
    this.bytes = new Uint8Array(initialCapacity);
  }

  push(byte: number): void {
    if (this.length >= this.maxBytes) {
      throw new JsonBase64ResponseError(`${this.label} exceeded its decoded byte limit`);
    }
    if (this.length === this.bytes.byteLength) this.grow();
    this.bytes[this.length++] = byte;
  }

  value(): Uint8Array {
    if (this.length === this.bytes.byteLength) return this.bytes;
    return this.bytes.subarray(0, this.length);
  }

  private grow(): void {
    const capacity = Math.min(
      this.maxBytes,
      Math.max(this.bytes.byteLength + 1, this.bytes.byteLength * 2),
    );
    if (capacity <= this.bytes.byteLength) {
      throw new JsonBase64ResponseError(`${this.label} exceeded its decoded byte limit`);
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes);
    this.bytes = grown;
  }
}

function decodeBase64Quartet(
  quartet: Uint8Array,
  writer: BoundedByteWriter,
  label: string,
): boolean {
  const a = base64Sextet(quartet[0]!);
  const b = base64Sextet(quartet[1]!);
  const thirdPadding = quartet[2] === 0x3d;
  const fourthPadding = quartet[3] === 0x3d;
  if (a < 0 || b < 0 || (thirdPadding && !fourthPadding)) {
    throw new JsonBase64ResponseError(`${label} returned malformed base64`);
  }
  writer.push((a << 2) | (b >> 4));
  if (thirdPadding) {
    if ((b & 0x0f) !== 0) {
      throw new JsonBase64ResponseError(`${label} returned non-canonical base64`);
    }
    return true;
  }
  const c = base64Sextet(quartet[2]!);
  if (c < 0) throw new JsonBase64ResponseError(`${label} returned malformed base64`);
  writer.push(((b & 0x0f) << 4) | (c >> 2));
  if (fourthPadding) {
    if ((c & 0x03) !== 0) {
      throw new JsonBase64ResponseError(`${label} returned non-canonical base64`);
    }
    return true;
  }
  const d = base64Sextet(quartet[3]!);
  if (d < 0) throw new JsonBase64ResponseError(`${label} returned malformed base64`);
  writer.push(((c & 0x03) << 6) | d);
  return false;
}

function base64Sextet(byte: number): number {
  if (byte >= 0x41 && byte <= 0x5a) return byte - 0x41;
  if (byte >= 0x61 && byte <= 0x7a) return byte - 0x61 + 26;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30 + 52;
  if (byte === 0x2b) return 62;
  if (byte === 0x2f) return 63;
  return -1;
}

function isBase64Byte(byte: number): boolean {
  return base64Sextet(byte) >= 0 || byte === 0x3d;
}

function isJsonWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}
