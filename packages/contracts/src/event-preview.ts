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
const MAX_PREVIEW_NODES = 512;
const MAX_MEASUREMENT_NODES = 2_048;
const MAX_MEASUREMENT_DEPTH = 64;
const MAX_DETAIL_RECORDS = 24;
const APPROX_BYTES_PER_TOKEN = 4;
const encoder = new TextEncoder();

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
  | "database_read_projection"
  | "http_projection"
  | "nats_legacy_guard"
  | "sse_legacy_guard"
  | "browser_legacy_guard";

export type SessionEventPayloadTruncation = {
  truncated: true;
  surface: SessionEventBoundarySurface;
  reason:
    | "payload_bytes_exceeded"
    | "payload_not_serializable"
    | "payload_measurement_bounded"
    | "inline_media_not_retained"
    | "database_guard";
  originalBytes: number | null;
  deliveredBytes: number;
  omittedBytes: number | null;
  estimatedOriginalTokens: number | null;
  estimatedDeliveredTokens: number;
  fullEvidence: {
    available: false;
    reason: "not_retained";
  };
  details: Array<{
    path: string;
    kind:
      | "string"
      | "array"
      | "object"
      | "depth"
      | "budget"
      | "media"
      | "binary"
      | "unserializable";
    originalBytes?: number;
    deliveredBytes?: number;
    omittedEntries?: number | null;
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
  remainingNodes: number;
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
  const originalMeasurement = measureJsonBytes(payload);
  const originalBytes = originalMeasurement.bytes;

  let state = previewState(DEFAULT_STRING_BYTES, DEFAULT_ARRAY_ENTRIES, DEFAULT_OBJECT_FIELDS);
  let preview = previewValue(payload, state, "$", 0);
  if (!state.changed && originalBytes !== null && originalBytes <= maxBytes) {
    return payload;
  }

  let reason = payloadTruncationReason(originalMeasurement, state);
  let bounded = attachTruncation(preview, boundaryMetadata(surface, reason, originalBytes, state));

  if (sessionEventJsonBytes(bounded) > Math.min(maxBytes, TARGET_PAYLOAD_BYTES)) {
    state = previewState(RETRY_STRING_BYTES, RETRY_ARRAY_ENTRIES, RETRY_OBJECT_FIELDS);
    preview = previewValue(payload, state, "$", 0);
    reason = payloadTruncationReason(originalMeasurement, state);
    bounded = attachTruncation(preview, boundaryMetadata(surface, reason, originalBytes, state));
  }

  if (sessionEventJsonBytes(bounded) > maxBytes) {
    const identity = identityPreview(payload);
    state.changed = true;
    recordDetail(state, {
      path: "$",
      kind: "object",
      ...(originalBytes === null ? {} : { originalBytes }),
    });
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
    remainingNodes: MAX_PREVIEW_NODES,
  };
}

function payloadTruncationReason(
  measurement: JsonMeasurement,
  state: PreviewState,
): SessionEventPayloadTruncation["reason"] {
  if (state.sawMedia) return "inline_media_not_retained";
  return measurement.bytes === null ? measurement.reason : "payload_bytes_exceeded";
}

function previewValue(value: unknown, state: PreviewState, path: string, depth: number): unknown {
  if (state.remainingNodes <= 0) {
    state.changed = true;
    recordDetail(state, { path, kind: "budget" });
    return "[nested value omitted at audit preview traversal boundary]";
  }
  state.remainingNodes -= 1;
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
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    state.changed = true;
    recordDetail(state, { path, kind: "unserializable" });
    return `[${typeof value} value omitted at audit serialization boundary]`;
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

  if (value instanceof Date) {
    try {
      const epoch = Date.prototype.getTime.call(value);
      return Number.isFinite(epoch) ? Date.prototype.toISOString.call(value) : null;
    } catch {
      state.changed = true;
      recordDetail(state, { path, kind: "unserializable" });
      return "[Date value omitted at audit serialization boundary]";
    }
  }

  const record = value as Record<string, unknown>;
  const { entries, omitted, accessorKeys } = selectObjectEntries(record, state.objectFields);
  for (const key of accessorKeys) {
    state.changed = true;
    recordDetail(state, {
      path: `${path}.${key}`,
      kind: "unserializable",
    });
  }
  if (omitted) {
    state.changed = true;
    recordDetail(state, {
      path,
      kind: "object",
      // Counting every remaining field would defeat the traversal bound. `null`
      // is deliberate: at least one field was omitted, but its exact count is
      // unknown because the source was not fully enumerated.
      omittedEntries: null,
    });
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of entries) {
    out[key] = previewValue(entry, state, `${path}.${key}`, depth + 1);
  }
  if (omitted) {
    out.omittedFields = "additional fields omitted; exact count not measured";
  }
  return out;
}

function selectObjectEntries(
  record: Record<string, unknown>,
  maxFields: number,
): {
  entries: Array<[string, unknown]>;
  omitted: boolean;
  accessorKeys: string[];
} {
  const entries: Array<[string, unknown]> = [];
  const selected = new Set<string>();
  const accessorKeys: string[] = [];
  const select = (key: string): boolean => {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor?.enumerable) return false;
    selected.add(key);
    if ("value" in descriptor) {
      entries.push([key, descriptor.value]);
    } else {
      entries.push([key, "[accessor value omitted at audit serialization boundary]"]);
      accessorKeys.push(key);
    }
    return true;
  };
  try {
    for (const key of IDENTITY_FIELDS) {
      if (entries.length >= maxFields) break;
      select(key);
    }
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || selected.has(key)) continue;
      if (entries.length >= maxFields) {
        return { entries, omitted: true, accessorKeys };
      }
      select(key);
    }
  } catch {
    return { entries, omitted: true, accessorKeys };
  }
  return { entries, omitted: false, accessorKeys };
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
  originalBytes: number | null,
  state: PreviewState,
): SessionEventPayloadTruncation {
  return {
    truncated: true,
    surface,
    reason,
    originalBytes,
    deliveredBytes: 0,
    omittedBytes: originalBytes,
    estimatedOriginalTokens:
      originalBytes === null ? null : approximateSessionEventTokens(originalBytes),
    estimatedDeliveredTokens: 0,
    fullEvidence: { available: false, reason: "not_retained" },
    details: state.details,
  };
}

function settleDeliveredSizes(payload: Record<string, unknown>, maxBytes: number): void {
  const truncation = payload.truncation as SessionEventPayloadTruncation;
  convergeDeliveredSizes(payload, truncation);
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
    convergeDeliveredSizes(payload, truncation);
  }
}

function convergeDeliveredSizes(
  payload: Record<string, unknown>,
  truncation: SessionEventPayloadTruncation,
): void {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const deliveredBytes = sessionEventJsonBytes(payload);
    const omittedBytes =
      truncation.originalBytes === null
        ? null
        : Math.max(0, truncation.originalBytes - deliveredBytes);
    const estimatedDeliveredTokens = approximateSessionEventTokens(deliveredBytes);
    if (
      truncation.deliveredBytes === deliveredBytes &&
      truncation.omittedBytes === omittedBytes &&
      truncation.estimatedDeliveredTokens === estimatedDeliveredTokens
    ) {
      return;
    }
    truncation.deliveredBytes = deliveredBytes;
    truncation.omittedBytes = omittedBytes;
    truncation.estimatedDeliveredTokens = estimatedDeliveredTokens;
  }
  throw new RangeError("Session event byte accounting did not converge");
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
    let field: unknown;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) continue;
      field = descriptor.value;
    } catch {
      continue;
    }
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
  let omittedBytes = Math.max(0, knownBytes - maxBytes);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const marker = `…[${omittedBytes} bytes omitted]…`;
    const contentBudget = Math.max(0, maxBytes - utf8Bytes(marker));
    if (contentBudget === 0) return marker;
    const left = utf8Prefix(value, Math.floor(contentBudget / 2));
    const right = utf8Suffix(value, contentBudget - left.bytes);
    const exactOmittedBytes = Math.max(0, knownBytes - left.bytes - right.bytes);
    if (exactOmittedBytes === omittedBytes) {
      return `${value.slice(0, left.end)}${marker}${value.slice(right.start)}`;
    }
    omittedBytes = exactOmittedBytes;
  }

  const marker = `…[${omittedBytes} bytes omitted]…`;
  const contentBudget = Math.max(0, maxBytes - utf8Bytes(marker));
  const left = utf8Prefix(value, Math.floor(contentBudget / 2));
  const right = utf8Suffix(value, contentBudget - left.bytes);
  return `${value.slice(0, left.end)}${marker}${value.slice(right.start)}`;
}

function utf8Prefix(value: string, maxBytes: number): { end: number; bytes: number } {
  let end = 0;
  let bytes = 0;
  while (end < value.length) {
    const unit = utf8UnitAt(value, end);
    if (bytes + unit.bytes > maxBytes) break;
    bytes += unit.bytes;
    end += unit.codeUnits;
  }
  return { end, bytes };
}

function utf8Suffix(value: string, maxBytes: number): { start: number; bytes: number } {
  let start = value.length;
  let bytes = 0;
  while (start > 0) {
    const unit = utf8UnitBefore(value, start);
    if (bytes + unit.bytes > maxBytes) break;
    bytes += unit.bytes;
    start -= unit.codeUnits;
  }
  return { start, bytes };
}

function utf8UnitAt(value: string, index: number): { codeUnits: number; bytes: number } {
  const code = value.charCodeAt(index);
  if (code <= 0x7f) return { codeUnits: 1, bytes: 1 };
  if (code <= 0x7ff) return { codeUnits: 1, bytes: 2 };
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
    if (next >= 0xdc00 && next <= 0xdfff) {
      return { codeUnits: 2, bytes: 4 };
    }
  }
  return { codeUnits: 1, bytes: 3 };
}

function utf8UnitBefore(value: string, end: number): { codeUnits: number; bytes: number } {
  const code = value.charCodeAt(end - 1);
  if (code >= 0xdc00 && code <= 0xdfff && end >= 2) {
    const previous = value.charCodeAt(end - 2);
    if (previous >= 0xd800 && previous <= 0xdbff) {
      return { codeUnits: 2, bytes: 4 };
    }
  }
  if (code <= 0x7f) return { codeUnits: 1, bytes: 1 };
  if (code <= 0x7ff) return { codeUnits: 1, bytes: 2 };
  return { codeUnits: 1, bytes: 3 };
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length;) {
    const unit = utf8UnitAt(value, index);
    bytes += unit.bytes;
    index += unit.codeUnits;
  }
  return bytes;
}

/**
 * Count the JSON wire bytes without first allocating the complete JSON string.
 * A global node budget prevents an adversarial broad graph from moving the
 * durable 64 KiB bound into an unbounded measurement pass. `null` means exact
 * source size is unknown; callers expose that truth instead of measuring a
 * placeholder or claiming a lower bound is exact.
 */
type JsonMeasurement =
  | { bytes: number; reason: null }
  | {
      bytes: null;
      reason: "payload_not_serializable" | "payload_measurement_bounded";
    };

function measureJsonBytes(value: unknown): JsonMeasurement {
  const state: JsonMeasurementState = {
    remainingNodes: MAX_MEASUREMENT_NODES,
    seen: new WeakSet<object>(),
    failureReason: null,
  };
  try {
    const bytes = measureJsonValue(value, state, "top", 0);
    return bytes === null
      ? {
          bytes: null,
          reason: state.failureReason ?? "payload_measurement_bounded",
        }
      : { bytes, reason: null };
  } catch {
    return { bytes: null, reason: "payload_measurement_bounded" };
  }
}

type JsonMeasurementState = {
  remainingNodes: number;
  seen: WeakSet<object>;
  failureReason: "payload_not_serializable" | "payload_measurement_bounded" | null;
};

function measureJsonValue(
  value: unknown,
  state: JsonMeasurementState,
  position: "top" | "array" | "object",
  depth: number,
): number | null {
  if (state.remainingNodes <= 0 || depth > MAX_MEASUREMENT_DEPTH) {
    return failJsonMeasurement(state, "payload_measurement_bounded");
  }
  state.remainingNodes -= 1;
  if (value === null) return 4;
  if (typeof value === "string") return jsonStringBytes(value);
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : serialized.length;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return position === "array" ? 4 : failJsonMeasurement(state, "payload_not_serializable");
  }
  if (typeof value === "bigint") {
    return failJsonMeasurement(state, "payload_not_serializable");
  }
  if (typeof value !== "object") {
    return failJsonMeasurement(state, "payload_not_serializable");
  }
  if (value instanceof Date) {
    try {
      const epoch = Date.prototype.getTime.call(value);
      return Number.isFinite(epoch) ? jsonStringBytes(Date.prototype.toISOString.call(value)) : 4;
    } catch {
      return failJsonMeasurement(state, "payload_not_serializable");
    }
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return failJsonMeasurement(state, "payload_measurement_bounded");
  }
  if (state.seen.has(value)) {
    return failJsonMeasurement(state, "payload_not_serializable");
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        return failJsonMeasurement(state, "payload_measurement_bounded");
      }
      const toJson = Object.getOwnPropertyDescriptor(value, "toJSON");
      if (toJson && ("get" in toJson || typeof toJson.value === "function")) {
        return failJsonMeasurement(state, "payload_measurement_bounded");
      }
      if (value.length > state.remainingNodes) {
        return failJsonMeasurement(state, "payload_measurement_bounded");
      }
      let bytes = 2;
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) bytes += 1;
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor && !("value" in descriptor)) {
          return failJsonMeasurement(state, "payload_measurement_bounded");
        }
        const entry = descriptor && "value" in descriptor ? descriptor.value : undefined;
        const measured = measureJsonValue(entry, state, "array", depth + 1);
        if (measured === null) return null;
        bytes += measured;
      }
      return bytes;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return failJsonMeasurement(state, "payload_measurement_bounded");
    }
    const toJson = Object.getOwnPropertyDescriptor(value, "toJSON");
    if (toJson && ("get" in toJson || typeof toJson.value === "function")) {
      return failJsonMeasurement(state, "payload_measurement_bounded");
    }
    let bytes = 2;
    let fields = 0;
    try {
      for (const key in value as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (state.remainingNodes <= 0) {
          return failJsonMeasurement(state, "payload_measurement_bounded");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          return failJsonMeasurement(state, "payload_measurement_bounded");
        }
        const entry = descriptor.value;
        if (
          typeof entry === "undefined" ||
          typeof entry === "function" ||
          typeof entry === "symbol"
        ) {
          continue;
        }
        const measured = measureJsonValue(entry, state, "object", depth + 1);
        if (measured === null) return null;
        if (fields > 0) bytes += 1;
        bytes += jsonStringBytes(key) + 1 + measured;
        fields += 1;
      }
    } catch {
      return null;
    }
    return bytes;
  } finally {
    state.seen.delete(value);
  }
}

function failJsonMeasurement(
  state: JsonMeasurementState,
  reason: Exclude<JsonMeasurement, { bytes: number }>["reason"],
): null {
  state.failureReason ??= reason;
  return null;
}

function jsonStringBytes(value: string): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // JSON.stringify escapes lone surrogates as six ASCII bytes.
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function serializeForBoundary(value: unknown): {
  value: string;
  serializable: boolean;
} {
  try {
    const serialized = JSON.stringify(value);
    return {
      value: serialized === undefined ? "null" : serialized,
      serializable: serialized !== undefined,
    };
  } catch {
    return {
      value: JSON.stringify("[unserializable event payload omitted]"),
      serializable: false,
    };
  }
}

function stringifyForBoundary(value: unknown): string {
  return serializeForBoundary(value).value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
