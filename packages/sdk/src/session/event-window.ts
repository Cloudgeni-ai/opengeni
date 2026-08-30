import type { SessionEvent } from "../types";

const BROWSER_EVENT_TYPE_MAX_BYTES = 256;
const BROWSER_EVENT_ID_MAX_BYTES = 256;
const BROWSER_EVENT_CLIENT_ID_MAX_BYTES = 4 * 1024;
const BROWSER_EVENT_DUPLICATE_REASON_MAX_BYTES = 4 * 1024;
const BROWSER_EVENT_PAYLOAD_PREVIEW_MAX_BYTES = 48 * 1024;
const BROWSER_EVENT_PAYLOAD_IDENTITY_FIELDS = [
  "id",
  "callId",
  "call_id",
  "name",
  "toolName",
  "status",
  "code",
  "isError",
  "stream",
  "commandId",
  "sequence",
  "coalescedUntil",
  "coalescedCount",
  "firstSequence",
  "lastSequence",
] as const;

export const SESSION_EVENT_BROWSER_MAX_BYTES = 8 * 1024 * 1024;
export const SESSION_EVENT_BROWSER_MAX_COUNT = 10_000;
export const SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES = 96 * 1024;
export const SESSION_EVENT_BROWSER_PENDING_MAX_BYTES = 1024 * 1024;
export const SESSION_EVENT_BROWSER_PENDING_MAX_COUNT = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type BrowserSessionEventWindow = Readonly<{
  events: readonly SessionEvent[];
  bytes: number;
  truncated: boolean;
}>;

export function eventResumeSequence(event: SessionEvent): number {
  const payload = asRecord(event.payload);
  const coalescedUntil = Number(payload.coalescedUntil);
  return Math.max(event.sequence, Number.isFinite(coalescedUntil) ? Math.floor(coalescedUntil) : 0);
}

export function mergeSessionEvents(
  current: readonly SessionEvent[],
  incoming: readonly SessionEvent[],
): SessionEvent[] {
  const bySequence = new Map<number, SessionEvent>();
  for (const event of current) bySequence.set(event.sequence, event);
  for (const event of incoming) bySequence.set(event.sequence, event);
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}

/**
 * Keep one direction-aware count+byte-bounded browser window. Newest mode
 * retains the live suffix; oldest mode retains the history prefix.
 */
export function boundSessionEventWindow(
  events: readonly SessionEvent[],
  options: {
    maxBytes?: number | undefined;
    maxCount?: number | undefined;
    direction?: "newest" | "oldest" | undefined;
  } = {},
): BrowserSessionEventWindow {
  const maxBytes = Math.max(1024, options.maxBytes ?? SESSION_EVENT_BROWSER_MAX_BYTES);
  const maxCount = Math.max(1, Math.floor(options.maxCount ?? SESSION_EVENT_BROWSER_MAX_COUNT));
  const safe = events.map(boundSessionEvent);
  const selected: SessionEvent[] = [];
  let bytes = 2;
  const direction = options.direction ?? "newest";
  const start = direction === "newest" ? safe.length - 1 : 0;
  const end = direction === "newest" ? Math.max(-1, safe.length - maxCount - 1) : safe.length;
  const step = direction === "newest" ? -1 : 1;
  for (let index = start; index !== end && selected.length < maxCount; index += step) {
    const event = safe[index]!;
    const eventBytes = sessionEventWindowBytes(event);
    const separator = selected.length === 0 ? 0 : 1;
    if (bytes + separator + eventBytes > maxBytes) break;
    selected.push(event);
    bytes += separator + eventBytes;
  }
  if (direction === "newest") selected.reverse();
  return Object.freeze({
    events: Object.freeze(selected),
    bytes,
    truncated: selected.length < safe.length,
  });
}

export const boundBrowserSessionEventWindow = boundSessionEventWindow;

export function boundSessionEvent(event: SessionEvent): SessionEvent {
  const serialized = serialize(event);
  const originalBytes = serialized.serializable
    ? encoder.encode(serialized.value).byteLength
    : null;
  const typeIsSafe =
    utf8Bytes(event.type) <= BROWSER_EVENT_TYPE_MAX_BYTES &&
    !event.type.includes("\n") &&
    !event.type.includes("\r");
  const clientEventId = boundOptionalText(event.clientEventId, BROWSER_EVENT_CLIENT_ID_MAX_BYTES);
  const duplicateReason = boundOptionalText(
    event.duplicateReason,
    BROWSER_EVENT_DUPLICATE_REASON_MAX_BYTES,
  );
  if (
    serialized.serializable &&
    originalBytes !== null &&
    originalBytes <= SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES &&
    typeIsSafe &&
    clientEventId === event.clientEventId &&
    duplicateReason === event.duplicateReason
  ) {
    return event;
  }

  const envelopeProjection = [
    !typeIsSafe
      ? envelopeFieldProjection("type", event.type, "session.event.envelope_omitted")
      : null,
    clientEventId !== event.clientEventId
      ? envelopeFieldProjection("clientEventId", event.clientEventId, clientEventId)
      : null,
    duplicateReason !== event.duplicateReason
      ? envelopeFieldProjection("duplicateReason", event.duplicateReason, duplicateReason)
      : null,
  ].filter((field) => field !== null);
  const payloadSerialization = serialize(event.payload);
  const payloadBytes = payloadSerialization.serializable
    ? encoder.encode(payloadSerialization.value).byteLength
    : null;
  const preview = truncateUtf8Middle(
    payloadSerialization.value,
    BROWSER_EVENT_PAYLOAD_PREVIEW_MAX_BYTES,
  );
  const truncation = {
    truncated: true as const,
    surface: "browser_legacy_guard" as const,
    reason: serialized.serializable ? "event_envelope_bytes_exceeded" : "event_not_serializable",
    originalBytes,
    deliveredBytes: 0,
    omittedBytes: originalBytes,
    estimatedOriginalTokens: originalBytes === null ? null : Math.ceil(originalBytes / 4),
    estimatedDeliveredTokens: 0,
    fullEvidence: { available: false as const, reason: "not_retained" as const },
    details: [
      {
        path: "$.payload",
        kind: "payload_preview",
        originalBytes: payloadBytes,
        deliveredBytes: utf8Bytes(preview),
      },
    ],
  };
  const payload: Record<string, unknown> = {
    ...payloadIdentity(event.payload),
    preview,
    ...(envelopeProjection.length > 0
      ? {
          originalType: boundText(event.type, BROWSER_EVENT_TYPE_MAX_BYTES),
          envelopeProjection: {
            truncated: true,
            surface: "browser_legacy_guard",
            fields: envelopeProjection,
          },
        }
      : {}),
    truncation,
  };
  const bounded: SessionEvent = {
    id: boundText(event.id, BROWSER_EVENT_ID_MAX_BYTES),
    workspaceId: boundText(event.workspaceId, BROWSER_EVENT_ID_MAX_BYTES),
    sessionId: boundText(event.sessionId, BROWSER_EVENT_ID_MAX_BYTES),
    sequence: event.sequence,
    type: typeIsSafe ? event.type : "session.event.envelope_omitted",
    payload,
    occurredAt: boundText(event.occurredAt, BROWSER_EVENT_ID_MAX_BYTES),
    clientEventId,
    turnId: boundOptionalText(event.turnId, BROWSER_EVENT_ID_MAX_BYTES),
    turnGeneration: event.turnGeneration,
    turnAttemptId: boundOptionalText(event.turnAttemptId, BROWSER_EVENT_ID_MAX_BYTES),
    turnAssociation: event.turnAssociation,
    duplicateOfEventId: boundOptionalText(event.duplicateOfEventId, BROWSER_EVENT_ID_MAX_BYTES),
    duplicateReason,
  };
  settleTruncation(bounded, truncation);
  if (sessionEventWindowBytes(bounded) > SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES) {
    payload.preview = truncateUtf8Middle(String(payload.preview), 4 * 1024);
    truncation.details = truncation.details.slice(0, 1);
    settleTruncation(bounded, truncation);
  }
  if (sessionEventWindowBytes(bounded) > SESSION_EVENT_BROWSER_SINGLE_EVENT_MAX_BYTES) {
    bounded.clientEventId = null;
    bounded.duplicateReason = null;
    payload.preview = "[legacy event omitted at the browser byte boundary]";
    settleTruncation(bounded, truncation);
  }
  return bounded;
}

export function sessionEventWindowBytes(value: unknown): number {
  return encoder.encode(serialize(value).value).byteLength;
}

function serialize(value: unknown): { value: string; serializable: boolean } {
  try {
    const serialized = JSON.stringify(value);
    return { value: serialized === undefined ? "null" : serialized, serializable: true };
  } catch {
    return {
      value: '"[unserializable event payload omitted at browser boundary]"',
      serializable: false,
    };
  }
}

function payloadIdentity(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  const identity: Record<string, unknown> = {};
  for (const field of BROWSER_EVENT_PAYLOAD_IDENTITY_FIELDS) {
    const value = record[field];
    if (typeof value === "string") {
      identity[field] = boundText(value, BROWSER_EVENT_ID_MAX_BYTES);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      identity[field] = value;
    }
  }
  return identity;
}

function envelopeFieldProjection(
  field: string,
  original: string | null | undefined,
  delivered: string | null | undefined,
): { field: string; originalBytes: number; deliveredBytes: number } {
  return {
    field,
    originalBytes: typeof original === "string" ? utf8Bytes(original) : 0,
    deliveredBytes: typeof delivered === "string" ? utf8Bytes(delivered) : 0,
  };
}

function boundOptionalText<T extends string | null | undefined>(value: T, maxBytes: number): T {
  return (typeof value === "string" ? boundText(value, maxBytes) : value) as T;
}

function boundText(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = "…[truncated]";
  const prefixBudget = Math.max(0, maxBytes - utf8Bytes(marker));
  let prefixEnd = Math.min(prefixBudget, bytes.byteLength);
  while (prefixEnd > 0 && prefixEnd < bytes.byteLength && isUtf8Continuation(bytes[prefixEnd]!)) {
    prefixEnd -= 1;
  }
  return `${decoder.decode(bytes.subarray(0, prefixEnd))}${marker}`;
}

function truncateUtf8Middle(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  const marker = `…[${bytes.byteLength - maxBytes} bytes omitted]…`;
  const contentBudget = Math.max(0, maxBytes - utf8Bytes(marker));
  const leftBudget = Math.floor(contentBudget / 2);
  const rightBudget = contentBudget - leftBudget;
  let leftEnd = Math.min(leftBudget, bytes.byteLength);
  while (leftEnd > 0 && leftEnd < bytes.byteLength && isUtf8Continuation(bytes[leftEnd]!)) {
    leftEnd -= 1;
  }
  let rightStart = Math.max(0, bytes.byteLength - rightBudget);
  while (rightStart < bytes.byteLength && isUtf8Continuation(bytes[rightStart]!)) {
    rightStart += 1;
  }
  return `${decoder.decode(bytes.subarray(0, leftEnd))}${marker}${decoder.decode(bytes.subarray(rightStart))}`;
}

function settleTruncation(
  event: SessionEvent,
  truncation: {
    originalBytes: number | null;
    deliveredBytes: number;
    omittedBytes: number | null;
    estimatedDeliveredTokens: number;
  },
): void {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const deliveredBytes = sessionEventWindowBytes(event);
    const omittedBytes =
      truncation.originalBytes === null
        ? null
        : Math.max(0, truncation.originalBytes - deliveredBytes);
    const estimatedDeliveredTokens = Math.ceil(deliveredBytes / 4);
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
  throw new RangeError("Browser event byte accounting did not converge");
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function isUtf8Continuation(value: number): boolean {
  return (value & 0xc0) === 0x80;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
