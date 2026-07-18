/**
 * Canonical bounded representation for `session_events.payload`.
 *
 * Session events are the lossy human/audit projection, not model memory and not
 * an evidence blob store. This helper keeps that projection useful while making
 * the loss explicit. It deliberately has no server-only dependency so the DB,
 * realtime transports, SDK/React, and tests can share one wire contract.
 */

export const SESSION_EVENT_PAYLOAD_MAX_BYTES = 64 * 1024;

const TARGET_PAYLOAD_BYTES = 60 * 1024;
const DEFAULT_STRING_BYTES = 8 * 1024;
const RETRY_STRING_BYTES = 1024;
const DEFAULT_ARRAY_ENTRIES = 40;
const RETRY_ARRAY_ENTRIES = 12;
const DEFAULT_OBJECT_FIELDS = 80;
const RETRY_OBJECT_FIELDS = 32;
const MAX_PREVIEW_DEPTH = 12;
const MAX_DETAIL_RECORDS = 24;
const APPROX_BYTES_PER_TOKEN = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const IDENTITY_FIELDS = new Set([
  "id",
  "callId",
  "call_id",
  "name",
  "toolName",
  "type",
  "status",
  "code",
  "isError",
  "stream",
  "commandId",
  "sequence",
]);

export type SessionEventBoundarySurface =
  | "durable_audit"
  | "database_guard"
  | "http_projection"
  | "nats_legacy_guard"
  | "sse_legacy_guard"
  | "browser_legacy_guard";

export type SessionEventPayloadTruncation = {
  truncated: true;
  surface: SessionEventBoundarySurface;
  reason: "payload_bytes_exceeded" | "inline_media_not_retained" | "database_guard";
  originalBytes: number;
  deliveredBytes: number;
  omittedBytes: number;
  estimatedOriginalTokens: number;
  estimatedDeliveredTokens: number;
  fullEvidence: {
    available: false;
    reason: "not_retained";
  };
  details: Array<{
    path: string;
    kind: "string" | "array" | "object" | "depth" | "media" | "binary";
    originalBytes?: number;
    deliveredBytes?: number;
    omittedEntries?: number;
    mediaType?: string;
  }>;
};

export type BoundSessionEventPayloadOptions = {
  surface?: SessionEventBoundarySurface;
  maxBytes?: number;
};

export type SessionEventMediaPreview = {
  type: "media_preview";
  mediaType: string;
  inlineBytes: number | null;
  fullOutputAvailable: false;
  preview: string;
};

type PreviewState = {
  changed: boolean;
  sawMedia: boolean;
  details: SessionEventPayloadTruncation["details"];
  stringBytes: number;
  arrayEntries: number;
  objectFields: number;
};

/** UTF-8 bytes used by the JSON wire/storage representation. */
export function sessionEventJsonBytes(value: unknown): number {
  return encoder.encode(stringifyForBoundary(value)).byteLength;
}

/** The same deliberately coarse bytes/4 token estimate used by Codex parity code. */
export function approximateSessionEventTokens(bytes: number): number {
  return Math.ceil(Math.max(0, bytes) / APPROX_BYTES_PER_TOKEN);
}

/** Truthful audit fact for inline media whose source bytes are not durably retained. */
export function sessionEventMediaPreview(
  mediaType: string,
  inlineBytes: number | null,
): SessionEventMediaPreview {
  return {
    type: "media_preview",
    mediaType: mediaType || "application/octet-stream",
    inlineBytes:
      inlineBytes === null
        ? null
        : Math.max(0, Math.floor(Number.isFinite(inlineBytes) ? inlineBytes : 0)),
    fullOutputAvailable: false,
    preview: "Inline media omitted from the audit timeline; source bytes were not retained.",
  };
}

/** Parse a base64 data URL into a compact audit fact without decoding/copying its bytes. */
export function sessionEventMediaPreviewFromDataUrl(
  value: string,
): SessionEventMediaPreview | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,/i.exec(value);
  if (!match) return null;
  const encodedLength = Math.max(0, value.length - match[0].length);
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return sessionEventMediaPreview(
    match[1] ?? "application/octet-stream",
    Math.max(0, Math.floor((encodedLength * 3) / 4) - padding),
  );
}

/** Read explicit truncation metadata from a bounded object payload. */
export function sessionEventPayloadTruncation(
  payload: unknown,
): SessionEventPayloadTruncation | null {
  if (!isPlainRecord(payload)) return null;
  const value = payload.truncation;
  if (!isPlainRecord(value) || value.truncated !== true) return null;
  return value as SessionEventPayloadTruncation;
}

/**
 * Return a byte-bounded audit payload. Unchanged ordinary payloads retain their
 * reference. Oversized strings/containers get deterministic head+tail previews;
 * inline images/binary values become metadata because `session_events` does not
 * durably retain their source bytes as independently retrievable evidence.
 */
export function boundSessionEventPayload<T>(
  payload: T,
  options: BoundSessionEventPayloadOptions = {},
): T {
  const maxBytes = Math.max(1024, Math.floor(options.maxBytes ?? SESSION_EVENT_PAYLOAD_MAX_BYTES));
  const surface = options.surface ?? "durable_audit";
  const originalBytes = sessionEventJsonBytes(payload);

  let state = previewState(DEFAULT_STRING_BYTES, DEFAULT_ARRAY_ENTRIES, DEFAULT_OBJECT_FIELDS);
  let preview = previewValue(payload, state, "$", 0);
  if (!state.changed && originalBytes <= maxBytes) return payload;

  let reason: SessionEventPayloadTruncation["reason"] = state.sawMedia
    ? "inline_media_not_retained"
    : "payload_bytes_exceeded";
  let bounded = attachTruncation(preview, boundaryMetadata(surface, reason, originalBytes, state));

  if (sessionEventJsonBytes(bounded) > Math.min(maxBytes, TARGET_PAYLOAD_BYTES)) {
    state = previewState(RETRY_STRING_BYTES, RETRY_ARRAY_ENTRIES, RETRY_OBJECT_FIELDS);
    preview = previewValue(payload, state, "$", 0);
    reason = state.sawMedia ? "inline_media_not_retained" : "payload_bytes_exceeded";
    bounded = attachTruncation(preview, boundaryMetadata(surface, reason, originalBytes, state));
  }

  if (sessionEventJsonBytes(bounded) > maxBytes) {
    const identity = identityPreview(payload);
    state.changed = true;
    recordDetail(state, { path: "$", kind: "object", originalBytes });
    bounded = attachTruncation(
      {
        ...identity,
        preview: "[event payload omitted: bounded audit preview exceeded the storage envelope]",
      },
      boundaryMetadata(surface, reason, originalBytes, state),
    );
  }

  settleDeliveredSizes(bounded, maxBytes);
  return bounded as T;
}

function previewState(
  stringBytes: number,
  arrayEntries: number,
  objectFields: number,
): PreviewState {
  return {
    changed: false,
    sawMedia: false,
    details: [],
    stringBytes,
    arrayEntries,
    objectFields,
  };
}

function previewValue(value: unknown, state: PreviewState, path: string, depth: number): unknown {
  if (typeof value === "string") {
    const media = inlineMediaFact(value);
    if (media) {
      state.changed = true;
      state.sawMedia = true;
      recordDetail(state, {
        path,
        kind: "media",
        originalBytes: utf8Bytes(value),
        deliveredBytes: sessionEventJsonBytes(media),
        mediaType: media.mediaType,
      });
      return media;
    }
    const originalBytes = utf8Bytes(value);
    if (originalBytes <= state.stringBytes) return value;
    state.changed = true;
    const delivered = truncateUtf8Middle(value, state.stringBytes, originalBytes);
    recordDetail(state, {
      path,
      kind: "string",
      originalBytes,
      deliveredBytes: utf8Bytes(delivered),
    });
    return delivered;
  }
  if (value === null || typeof value !== "object") return value;

  const binary = binaryFact(value);
  if (binary) {
    state.changed = true;
    recordDetail(state, {
      path,
      kind: "binary",
      originalBytes: binary.originalBytes,
      deliveredBytes: sessionEventJsonBytes(binary.preview),
    });
    return binary.preview;
  }

  if (depth >= MAX_PREVIEW_DEPTH) {
    state.changed = true;
    recordDetail(state, { path, kind: "depth" });
    return "[nested value omitted at audit preview depth boundary]";
  }

  if (Array.isArray(value)) {
    const keep = Math.max(2, state.arrayEntries);
    if (value.length <= keep) {
      return value.map((entry, index) =>
        previewValue(entry, state, `${path}[${index}]`, depth + 1),
      );
    }
    state.changed = true;
    const head = Math.ceil(keep / 2);
    const tail = Math.floor(keep / 2);
    const omitted = value.length - head - tail;
    recordDetail(state, { path, kind: "array", omittedEntries: omitted });
    return [
      ...value
        .slice(0, head)
        .map((entry, index) => previewValue(entry, state, `${path}[${index}]`, depth + 1)),
      { omittedEntries: omitted, preview: "[middle array entries omitted]" },
      ...value
        .slice(value.length - tail)
        .map((entry, index) =>
          previewValue(entry, state, `${path}[${value.length - tail + index}]`, depth + 1),
        ),
    ];
  }

  const record = value as Record<string, unknown>;
  const entries = orderedObjectEntries(record);
  const kept = entries.slice(0, state.objectFields);
  if (entries.length > kept.length) {
    state.changed = true;
    recordDetail(state, {
      path,
      kind: "object",
      omittedEntries: entries.length - kept.length,
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of kept) {
    out[key] = previewValue(entry, state, `${path}.${key}`, depth + 1);
  }
  if (entries.length > kept.length) {
    out.omittedFields = entries.length - kept.length;
  }
  return out;
}

function orderedObjectEntries(record: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(record);
  return [
    ...entries.filter(([key]) => IDENTITY_FIELDS.has(key)),
    ...entries.filter(([key]) => !IDENTITY_FIELDS.has(key)),
  ];
}

function attachTruncation(
  preview: unknown,
  truncation: SessionEventPayloadTruncation,
): Record<string, unknown> {
  if (isPlainRecord(preview)) {
    // `truncation` is reserved boundary metadata. A producer-supplied value is
    // intentionally replaced when the boundary actually omits content.
    return { ...preview, truncation };
  }
  return { value: preview, truncation };
}

function boundaryMetadata(
  surface: SessionEventBoundarySurface,
  reason: SessionEventPayloadTruncation["reason"],
  originalBytes: number,
  state: PreviewState,
): SessionEventPayloadTruncation {
  return {
    truncated: true,
    surface,
    reason,
    originalBytes,
    deliveredBytes: 0,
    omittedBytes: originalBytes,
    estimatedOriginalTokens: approximateSessionEventTokens(originalBytes),
    estimatedDeliveredTokens: 0,
    fullEvidence: { available: false, reason: "not_retained" },
    details: state.details,
  };
}

function settleDeliveredSizes(payload: Record<string, unknown>, maxBytes: number): void {
  const truncation = payload.truncation as SessionEventPayloadTruncation;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const deliveredBytes = sessionEventJsonBytes(payload);
    truncation.deliveredBytes = deliveredBytes;
    truncation.omittedBytes = Math.max(0, truncation.originalBytes - deliveredBytes);
    truncation.estimatedDeliveredTokens = approximateSessionEventTokens(deliveredBytes);
  }
  // This should only be reachable when a caller supplies an unusually tiny
  // custom maxBytes. Preserve explicit metadata over an accidental overshoot.
  if (sessionEventJsonBytes(payload) > maxBytes) {
    payload.preview = "[event payload omitted at audit byte boundary]";
    for (const key of Object.keys(payload)) {
      if (key !== "preview" && key !== "truncation" && IDENTITY_FIELDS.has(key) === false) {
        delete payload[key];
      }
    }
    truncation.details = truncation.details.slice(0, 4);
    truncation.deliveredBytes = sessionEventJsonBytes(payload);
    truncation.omittedBytes = Math.max(0, truncation.originalBytes - truncation.deliveredBytes);
    truncation.estimatedDeliveredTokens = approximateSessionEventTokens(truncation.deliveredBytes);
  }
}

function recordDetail(
  state: PreviewState,
  detail: SessionEventPayloadTruncation["details"][number],
): void {
  if (state.details.length < MAX_DETAIL_RECORDS) state.details.push(detail);
}

function identityPreview(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of IDENTITY_FIELDS) {
    const field = value[key];
    if (typeof field === "string") {
      out[key] = truncateUtf8Middle(field, 256, utf8Bytes(field));
    } else if (typeof field === "number" || typeof field === "boolean" || field === null) {
      out[key] = field;
    }
  }
  return out;
}

function inlineMediaFact(value: string): SessionEventMediaPreview | null {
  return sessionEventMediaPreviewFromDataUrl(value);
}

function binaryFact(value: object): {
  originalBytes: number;
  preview: {
    type: "binary_preview";
    byteLength: number;
    fullOutputAvailable: false;
    preview: string;
  };
} | null {
  if (ArrayBuffer.isView(value)) {
    return {
      originalBytes: value.byteLength,
      preview: {
        type: "binary_preview",
        byteLength: value.byteLength,
        fullOutputAvailable: false,
        preview: "Inline binary value omitted from the audit timeline; bytes were not retained.",
      },
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      originalBytes: value.byteLength,
      preview: {
        type: "binary_preview",
        byteLength: value.byteLength,
        fullOutputAvailable: false,
        preview: "Inline binary value omitted from the audit timeline; bytes were not retained.",
      },
    };
  }
  return null;
}

function truncateUtf8Middle(
  value: string,
  maxBytes: number,
  knownBytes = utf8Bytes(value),
): string {
  if (knownBytes <= maxBytes) return value;
  const marker = `…[${knownBytes - maxBytes} bytes omitted]…`;
  const contentBudget = Math.max(0, maxBytes - utf8Bytes(marker));
  if (contentBudget === 0) return marker;
  const bytes = encoder.encode(value);
  const leftBudget = Math.floor(contentBudget / 2);
  const rightBudget = contentBudget - leftBudget;
  let leftEnd = Math.min(leftBudget, bytes.length);
  while (leftEnd > 0 && leftEnd < bytes.length && isUtf8Continuation(bytes[leftEnd]!)) leftEnd -= 1;
  let rightStart = Math.max(0, bytes.length - rightBudget);
  while (rightStart < bytes.length && isUtf8Continuation(bytes[rightStart]!)) rightStart += 1;
  return `${decoder.decode(bytes.subarray(0, leftEnd))}${marker}${decoder.decode(bytes.subarray(rightStart))}`;
}

function isUtf8Continuation(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function stringifyForBoundary(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  } catch {
    return JSON.stringify("[unserializable event payload omitted]");
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
