const JSON_STRING_PREFIX = "opengeni_lossless_json_string_v2_81f06e15:";
const JSON_KEY_PREFIX = "opengeni_lossless_json_key_v2_7ca6071d:";
const TEXT_PREFIX = "opengeni_lossless_text_v2_c4100a62:";
const MAX_JSON_DEPTH = 512;

/**
 * Explicit out-of-band truth for values written by the lossless PostgreSQL
 * compatibility codec. Historical rows have NULL in their companion version
 * column and must never be decoded based on content shape alone.
 */
export const LOSSLESS_CONTENT_CODEC_VERSION = 1 as const;
export const LOSSLESS_CONTENT_WRITER_APPLICATION_NAME = "opengeni-lossless-v1";

export function withLosslessContentWriteVersion<
  const ContentKey extends string,
  const VersionKey extends string,
  const Value extends object,
>(
  value: Value & Record<ContentKey, unknown>,
  contentKey: ContentKey,
  versionKey: VersionKey,
): Value & Record<VersionKey, typeof LOSSLESS_CONTENT_CODEC_VERSION>;
export function withLosslessContentWriteVersion<
  const ContentKey extends string,
  const VersionKey extends string,
  const Value extends object,
>(
  value: readonly (Value & Record<ContentKey, unknown>)[],
  contentKey: ContentKey,
  versionKey: VersionKey,
): Array<Value & Record<VersionKey, typeof LOSSLESS_CONTENT_CODEC_VERSION>>;
export function withLosslessContentWriteVersion(
  value: Record<string, unknown> | readonly Record<string, unknown>[],
  contentKey: string,
  versionKey: string,
): Record<string, unknown> | Record<string, unknown>[] {
  const stamp = (entry: Record<string, unknown>) => {
    if (!Object.hasOwn(entry, contentKey)) {
      throw new Error(`Lossless content write omitted ${contentKey}`);
    }
    return { ...entry, [versionKey]: LOSSLESS_CONTENT_CODEC_VERSION };
  };
  return Array.isArray(value) ? value.map(stamp) : stamp(value as Record<string, unknown>);
}

export const LEGACY_LOSSLESS_JSON_ENVELOPE_KEY =
  "$opengeniCanonicalV8_6d9b6f48_2a3e_4d8a_9e33_7611d9d08985";
export const LEGACY_LOSSLESS_TEXT_PREFIX = "opengeni-canonical-text-v1:";
export const LOSSLESS_JSON_STRING_PREFIX = JSON_STRING_PREFIX;
export const LOSSLESS_TEXT_PREFIX = TEXT_PREFIX;

export class UnsupportedCanonicalValueError extends TypeError {
  override readonly name = "UnsupportedCanonicalValueError";
}

type TransformResult = { value: unknown; changed: boolean };

/**
 * Preserve JSON structure and SQL-queryable control keys. Only strings that
 * PostgreSQL cannot represent (or that collide with this unshipped v2 tag) are
 * encoded. Non-JSON graph values are rejected instead of silently rewritten.
 */
export function toPostgresLosslessJson(value: unknown): unknown {
  return encodeJsonValue(value, new Set<object>(), 0).value;
}

/**
 * Restore an explicitly versioned JSON value after a PostgreSQL read. A NULL
 * version denotes literal legacy/old-writer data, including strings that happen
 * to be valid active-marker encodings.
 */
export function fromPostgresLosslessJson<T>(value: T, codecVersion: number | null | undefined): T {
  return codecVersion === LOSSLESS_CONTENT_CODEC_VERSION
    ? (decodeJsonValue(value, 0).value as T)
    : value;
}

/**
 * Lossless text-column boundary for NUL, lone UTF-16, and v2-prefix text.
 * Only the unrepresentable code unit is tagged, with SQL-visible spaces around
 * the tag, so ordinary surrounding words retain their full-text-search shape.
 */
export function toPostgresLosslessText(value: string): string {
  if (isPostgresSafeString(value) && !value.includes(TEXT_PREFIX)) return value;
  let stored = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (value.startsWith(TEXT_PREFIX, index)) {
      stored += encodeTextCodeUnit(code);
      continue;
    }
    if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) {
      stored += encodeTextCodeUnit(code);
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) {
        stored += encodeTextCodeUnit(code);
        continue;
      }
      stored += value.slice(index, index + 2);
      index += 1;
      continue;
    }
    stored += value[index];
  }
  return stored;
}

/**
 * Decode only an explicitly versioned value introduced by this migration. The
 * nullable companion column, not the producer string, is the codec truth.
 */
export function fromPostgresLosslessText(
  value: string,
  codecVersion: number | null | undefined,
): string {
  return codecVersion === LOSSLESS_CONTENT_CODEC_VERSION
    ? value.replaceAll(
        new RegExp(` ${TEXT_PREFIX}([0-9a-f]{4}); `, "g"),
        (_match, encoded: string) => String.fromCharCode(Number.parseInt(encoded, 16)),
      )
    : value;
}

function encodeTextCodeUnit(code: number): string {
  return ` ${TEXT_PREFIX}${code.toString(16).padStart(4, "0")}; `;
}

function encodeJsonValue(value: unknown, ancestors: Set<object>, depth: number): TransformResult {
  if (depth > MAX_JSON_DEPTH) {
    throw new UnsupportedCanonicalValueError(
      `Canonical JSON exceeds the maximum supported depth of ${MAX_JSON_DEPTH}`,
    );
  }
  if (value === null || typeof value === "boolean") return { value, changed: false };
  if (typeof value === "string") {
    if (isPostgresSafeString(value) && !value.startsWith(JSON_STRING_PREFIX)) {
      return { value, changed: false };
    }
    return { value: `${JSON_STRING_PREFIX}${encodeUtf16(value)}`, changed: true };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new UnsupportedCanonicalValueError(
        "Canonical JSON requires finite non-negative-zero numbers",
      );
    }
    return { value, changed: false };
  }
  if (
    typeof value === "undefined" ||
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new UnsupportedCanonicalValueError(`Canonical JSON cannot contain ${typeof value}`);
  }
  if (!isPlainObject(value) && !Array.isArray(value)) {
    throw new UnsupportedCanonicalValueError("Canonical JSON requires arrays and plain objects");
  }
  if (ancestors.has(value)) {
    throw new UnsupportedCanonicalValueError("Canonical JSON cannot contain cyclic references");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new UnsupportedCanonicalValueError("Canonical JSON cannot contain symbol keys");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      let changed = false;
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new UnsupportedCanonicalValueError(
            "Canonical JSON arrays cannot contain holes, accessors, or hidden elements",
          );
        }
        const encoded = encodeJsonValue(descriptor.value, ancestors, depth + 1);
        output.push(encoded.value);
        changed ||= encoded.changed;
      }
      return changed ? { value: output, changed: true } : { value, changed: false };
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const output: Record<string, unknown> = {};
    let changed = false;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new UnsupportedCanonicalValueError(
          "Canonical JSON objects cannot contain accessors or hidden properties",
        );
      }
      const encodedKey =
        isPostgresSafeString(key) && !key.startsWith(JSON_KEY_PREFIX)
          ? key
          : `${JSON_KEY_PREFIX}${encodeUtf16(key)}`;
      if (Object.prototype.hasOwnProperty.call(output, encodedKey)) {
        throw new UnsupportedCanonicalValueError("Canonical JSON key encoding collided");
      }
      const encodedValue = encodeJsonValue(descriptor.value, ancestors, depth + 1);
      output[encodedKey] = encodedValue.value;
      changed ||= encodedKey !== key || encodedValue.changed;
    }
    return changed ? { value: output, changed: true } : { value, changed: false };
  } finally {
    ancestors.delete(value);
  }
}

function decodeJsonValue(value: unknown, depth: number): TransformResult {
  if (depth > MAX_JSON_DEPTH) return { value, changed: false };
  if (typeof value === "string") {
    const decoded = decodeTaggedString(value, JSON_STRING_PREFIX);
    return decoded === null ? { value, changed: false } : { value: decoded, changed: true };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let changed = false;
    for (const entry of value) {
      const decoded = decodeJsonValue(entry, depth + 1);
      output.push(decoded.value);
      changed ||= decoded.changed;
    }
    return changed ? { value: output, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  const output: Record<string, unknown> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(value)) {
    const decodedKey = decodeTaggedString(key, JSON_KEY_PREFIX) ?? key;
    if (Object.prototype.hasOwnProperty.call(output, decodedKey)) {
      return { value, changed: false };
    }
    const decodedValue = decodeJsonValue(entry, depth + 1);
    output[decodedKey] = decodedValue.value;
    changed ||= decodedKey !== key || decodedValue.changed;
  }
  return changed ? { value: output, changed: true } : { value, changed: false };
}

function encodeUtf16(value: string): string {
  const bytes = Buffer.allocUnsafe(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    bytes.writeUInt16LE(value.charCodeAt(index), index * 2);
  }
  return bytes.toString("base64");
}

function decodeTaggedString(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const encoded = value.slice(prefix.length);
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength % 2 !== 0 || bytes.toString("base64") !== encoded) return null;
  let decoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 2) {
    decoded += String.fromCharCode(bytes.readUInt16LE(offset));
  }
  return decoded;
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
