/**
 * The string walk shared by the secret maskers (known values and, later,
 * secret shapes): every string a masker may change.
 *
 * Binary payloads keep their exact bytes: a string that is entirely a base64
 * data URL, and the `data` of an object that also carries a MIME type (image
 * and file content). A payload of a text type (`text/*`, JSON, XML, YAML and
 * similar) is decoded, masked as text and encoded again, so a secret inside a
 * text file is masked while the payload stays valid base64.
 */

/**
 * A string that is entirely a base64 data URL (`data:image/png;base64,…`).
 * Anything else after a `data:` prefix (a plain data URL, a log line that
 * follows one) is searched like any text.
 */
const BASE64_DATA_URL =
  /^data:([\w.+-]+\/[\w.+-]+)(?:;[\w.+-]+=[\w.+-]+)*;base64,[A-Za-z0-9+/=_-]*$/u;

export function isBase64DataUrl(text: string): boolean {
  return text.startsWith("data:") && BASE64_DATA_URL.test(text);
}

const TEXT_MEDIA_TYPE =
  /^(?:text\/|application\/(?:json|ld\+json|ndjson|x-ndjson|xml|javascript|ecmascript|x-www-form-urlencoded|x-yaml|yaml|toml|x-sh|sql|graphql)$|[\w.-]+\/[\w.-]+\+(?:json|xml)$)/iu;

/** Whether a payload of this media type is text (and so is searched decoded). */
export function isTextMediaType(mediaType: string | null | undefined): boolean {
  if (typeof mediaType !== "string") return false;
  return TEXT_MEDIA_TYPE.test(mediaType.split(";")[0]!.trim());
}

const MEDIA_TYPE_KEYS = ["mimeType", "mime_type", "media_type", "mediaType"] as const;

/**
 * For the `data` of an object that also carries a MIME type (a file or image
 * payload): that media type, or null when it is not a string. Undefined when
 * the string is not such a payload.
 */
export function payloadMediaType(
  key: string | null,
  parent: Record<string, unknown> | null,
): string | null | undefined {
  if (key !== "data" || parent === null) return undefined;
  for (const name of MEDIA_TYPE_KEYS) {
    if (name in parent) {
      const mediaType = parent[name];
      return typeof mediaType === "string" ? mediaType : null;
    }
  }
  return undefined;
}

/** Base64 payloads larger than this are left as they are. */
const TEXT_PAYLOAD_MAX_CHARS = 4_000_000;
const BASE64_PAYLOAD = /^[A-Za-z0-9+/_-]*={0,2}$/u;

function decodeBase64Text(payload: string): string | null {
  if (payload.length > TEXT_PAYLOAD_MAX_CHARS || !BASE64_PAYLOAD.test(payload)) return null;
  try {
    const binary = atob(payload.replaceAll("-", "+").replaceAll("_", "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function encodeBase64Text(text: string, like: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  let encoded = btoa(binary);
  // Keep the payload's own alphabet and padding.
  if (/[-_]/u.test(like)) encoded = encoded.replaceAll("+", "-").replaceAll("/", "_");
  // An unpadded payload (its length not a multiple of four) stays unpadded.
  if (like.length % 4 !== 0) encoded = encoded.replace(/=+$/u, "");
  return encoded;
}

/**
 * `map` applied to the text a base64 payload encodes, encoded again; the
 * payload itself when it is not UTF-8 text, is too large, or `map` changes
 * nothing.
 */
export function mapBase64TextPayload(payload: string, map: (text: string) => string): string {
  const text = decodeBase64Text(payload);
  if (text === null) return payload;
  const mapped = map(text);
  return mapped === text ? payload : encodeBase64Text(mapped, payload);
}

function mapString(
  entry: string,
  key: string | null,
  parent: Record<string, unknown> | null,
  map: (text: string) => string,
): string {
  if (isBase64DataUrl(entry)) {
    const mediaType = BASE64_DATA_URL.exec(entry)?.[1];
    if (!isTextMediaType(mediaType)) return entry;
    const comma = entry.indexOf(",");
    const payload = entry.slice(comma + 1);
    const mapped = mapBase64TextPayload(payload, map);
    return mapped === payload ? entry : entry.slice(0, comma + 1) + mapped;
  }
  const mediaType = payloadMediaType(key, parent);
  if (mediaType !== undefined) {
    if (!isTextMediaType(mediaType)) return entry;
    // A text payload is base64 when it decodes; otherwise it is plain text.
    const text = decodeBase64Text(entry);
    if (text === null) return map(entry);
    const mapped = map(text);
    // Plain text that happens to be valid base64 (some tokens are): when the
    // decoded text has nothing to mask, the text as written is masked.
    if (mapped === text) return map(entry);
    return encodeBase64Text(mapped, entry);
  }
  return map(entry);
}

/**
 * Deep copy of `value` with `map` applied to every string a masker may
 * change (object keys are kept; an own `__proto__` key stays data). Binary
 * payloads are skipped and text payloads mapped decoded (see the module
 * comment). Own symbol-keyed properties are copied unmapped: they are
 * request-local marks that never reach a payload. Inputs that need no change
 * keep their identity.
 */
export function mapSecretMaskableStrings<T>(
  value: T,
  map: (text: string) => string,
  skipKey?: (key: string) => boolean,
): T {
  const visit = (
    entry: unknown,
    key: string | null,
    parent: Record<string, unknown> | null,
    depth: number,
  ): unknown => {
    if (typeof entry === "string") {
      if (key !== null && skipKey?.(key)) return entry;
      return mapString(entry, key, parent, map);
    }
    if (entry === null || typeof entry !== "object" || depth > 200) return entry;
    if (Array.isArray(entry)) {
      let changed = false;
      const next = entry.map((item) => {
        const mapped = visit(item, key, null, depth + 1);
        if (mapped !== item) changed = true;
        return mapped;
      });
      return changed ? next : entry;
    }
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== null) return entry;
    const record = entry as Record<string, unknown>;
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(record)) {
      const mapped = visit(child, childKey, record, depth + 1);
      if (mapped !== child) changed = true;
      // defineProperty keeps an own `__proto__` key as data.
      Object.defineProperty(next, childKey, {
        value: mapped,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (!changed) return entry;
    for (const symbol of Object.getOwnPropertySymbols(record)) {
      if (Object.prototype.propertyIsEnumerable.call(record, symbol))
        (next as Record<symbol, unknown>)[symbol] = (record as Record<symbol, unknown>)[symbol];
    }
    return next;
  };
  return visit(value, null, null, 0) as T;
}
