import { deserialize, serialize } from "node:v8";

const CANONICAL_MAGIC = Buffer.from("opengeni-canonical-v8-v1\0", "utf8");
export const LOSSLESS_JSON_ENVELOPE_KEY =
  "$opengeniCanonicalV8_6d9b6f48_2a3e_4d8a_9e33_7611d9d08985";
const LOSSLESS_TEXT_PREFIX = "opengeni-canonical-text-v1:";
const MAX_NATIVE_JSON_SCAN_NODES = 16_384;
const MAX_NATIVE_JSON_SCAN_DEPTH = 128;

type LosslessJsonEnvelope = {
  [LOSSLESS_JSON_ENVELOPE_KEY]: {
    version: 1;
    data: string;
  };
};

export class UnsupportedCanonicalValueError extends TypeError {
  override readonly name = "UnsupportedCanonicalValueError";
}

/** Encode one accepted JS value without JSON's string, graph, or numeric loss. */
export function serializeCanonicalValue(value: unknown): Buffer {
  assertCanonicalValueSupported(value);
  const encoded = Buffer.from(serialize(value));
  return Buffer.concat([CANONICAL_MAGIC, encoded]);
}

/** Restore a value encoded by serializeCanonicalValue. */
export function deserializeCanonicalValue(value: Uint8Array): unknown {
  const bytes = Buffer.from(value);
  if (
    bytes.byteLength <= CANONICAL_MAGIC.byteLength ||
    !bytes.subarray(0, CANONICAL_MAGIC.byteLength).equals(CANONICAL_MAGIC)
  ) {
    throw new TypeError("Unsupported canonical value encoding");
  }
  return deserialize(bytes.subarray(CANONICAL_MAGIC.byteLength));
}

/**
 * Keep ordinary JSONB rows queryable. Values JSONB cannot represent exactly are
 * stored in a closed structured-clone envelope and decoded by the Drizzle type.
 */
export function toPostgresLosslessJson(value: unknown): unknown {
  if (isNativePostgresJson(value)) return value;
  return {
    [LOSSLESS_JSON_ENVELOPE_KEY]: {
      version: 1,
      data: serializeCanonicalValue(value).toString("base64"),
    },
  } satisfies LosslessJsonEnvelope;
}

/** Decode only the exact closed envelope emitted by toPostgresLosslessJson. */
export function fromPostgresLosslessJson(value: unknown): unknown {
  if (!isLosslessJsonEnvelope(value)) return value;
  return deserializeCanonicalValue(Buffer.from(value[LOSSLESS_JSON_ENVELOPE_KEY].data, "base64"));
}

/** Lossless text-column boundary for NUL, lone UTF-16, and reserved-prefix text. */
export function toPostgresLosslessText(value: string): string {
  if (isPostgresSafeString(value) && !value.startsWith(LOSSLESS_TEXT_PREFIX)) return value;
  return `${LOSSLESS_TEXT_PREFIX}${serializeCanonicalValue(value).toString("base64")}`;
}

export function fromPostgresLosslessText(value: string): string {
  if (!value.startsWith(LOSSLESS_TEXT_PREFIX)) return value;
  const encoded = value.slice(LOSSLESS_TEXT_PREFIX.length);
  const decoded = deserializeCanonicalValue(Buffer.from(encoded, "base64"));
  if (typeof decoded !== "string") throw new TypeError("Canonical text encoding was not a string");
  return decoded;
}

function isLosslessJsonEnvelope(value: unknown): value is LosslessJsonEnvelope {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== LOSSLESS_JSON_ENVELOPE_KEY) return false;
  const envelope = value[LOSSLESS_JSON_ENVELOPE_KEY];
  if (!isPlainObject(envelope)) return false;
  const envelopeKeys = Object.keys(envelope).sort();
  return (
    envelopeKeys.length === 2 &&
    envelopeKeys[0] === "data" &&
    envelopeKeys[1] === "version" &&
    envelope.version === 1 &&
    typeof envelope.data === "string" &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(envelope.data)
  );
}

function isNativePostgresJson(root: unknown): boolean {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    const value = current.value;
    visited += 1;
    if (visited > MAX_NATIVE_JSON_SCAN_NODES || current.depth > MAX_NATIVE_JSON_SCAN_DEPTH) {
      return false;
    }
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "string") {
      if (!isPostgresSafeString(value)) return false;
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) return false;
      continue;
    }
    if (typeof value === "undefined" || typeof value === "bigint") return false;
    if (typeof value === "function" || typeof value === "symbol") {
      throw new UnsupportedCanonicalValueError(`Canonical JSON cannot contain ${typeof value}`);
    }
    if (typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) {
          throw new UnsupportedCanonicalValueError("Canonical arrays cannot contain accessors");
        }
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }

    if (!isPlainObject(value)) return false;
    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (symbolKeys.length > 0) {
      throw new UnsupportedCanonicalValueError("Canonical JSON cannot contain symbol keys");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.prototype.hasOwnProperty.call(descriptors, LOSSLESS_JSON_ENVELOPE_KEY)) return false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new UnsupportedCanonicalValueError("Canonical objects cannot contain accessors");
      }
      if (!isPostgresSafeString(key)) return false;
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return true;
}

function assertCanonicalValueSupported(root: unknown): void {
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "function" || typeof value === "symbol") {
      throw new UnsupportedCanonicalValueError(`Canonical values cannot contain ${typeof value}`);
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new UnsupportedCanonicalValueError("Canonical values cannot contain symbol keys");
    }
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new UnsupportedCanonicalValueError("Canonical values cannot contain accessors");
      }
      stack.push(descriptor.value);
    }
  }
}

function isPostgresSafeString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
