/**
 * Model-facing projections for cross-session monitoring tools.
 *
 * `session_events` reads are selected tail/forward and filtered in PostgreSQL;
 * this module is the independent final guard before JSON enters a manager
 * model's context. It measures the exact pretty-printed MCP text, trims fat
 * payload fields, and—only if still required—removes rows from the pagination
 * edge while preserving a usable cursor. It never manufactures an event or
 * advances across an event it did not return.
 */

import type {
  SessionEvent,
  SessionEventPayloadMode,
  SessionEventReadDirection,
  SessionEventReadMode,
} from "@opengeni/contracts";

export const SESSION_EVENT_MCP_MAX_BYTES = 64 * 1024;
export const SESSION_EVENT_MCP_FIELD_MAX_CHARS = 4_000;
export const DEFAULT_SESSION_DETAIL_CHARS = 6_000;

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncationMarker(droppedChars: number): string {
  return `…[${droppedChars} chars omitted from this model monitoring projection; request explicit forensic full mode for any retained audit preview; original source output may not have been retained]`;
}

function clampString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const dropped = value.length - maxChars;
  const headChars = Math.max(0, Math.floor(maxChars * 0.7));
  const tailChars = Math.max(0, maxChars - headChars);
  const tail = tailChars > 0 ? value.slice(value.length - tailChars) : "";
  return `${value.slice(0, headChars)}${truncationMarker(dropped)}${tail}`;
}

/** Recursively clamp fat leaves and collapse pathological containers. */
export function capPayloadValue(value: unknown, perFieldChars: number, depth = 0): unknown {
  if (typeof value === "string") return clampString(value, perFieldChars);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 8) return clampString(safeStringify(value), perFieldChars);
  const serializedLength = safeStringify(value).length;
  if (serializedLength <= perFieldChars) return value;
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => capPayloadValue(entry, perFieldChars, depth + 1));
    return safeStringify(mapped).length <= perFieldChars * 2
      ? mapped
      : clampString(safeStringify(value), perFieldChars);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = capPayloadValue(entry, perFieldChars, depth + 1);
  }
  return safeStringify(out).length <= perFieldChars * 4
    ? out
    : clampString(safeStringify(value), perFieldChars);
}

export function capEventPayload(event: SessionEvent, perFieldChars: number): SessionEvent {
  const cappedPayload = capPayloadValue(event.payload, perFieldChars);
  return cappedPayload === event.payload ? event : { ...event, payload: cappedPayload };
}

export type SessionEventMcpPageInput = {
  events: readonly SessionEvent[];
  mode: SessionEventReadMode;
  payloadMode: SessionEventPayloadMode;
  direction: SessionEventReadDirection;
  sourceHasMore: boolean;
  sourceTruncatedBy: "count" | "bytes" | null;
  after: number;
  before: number | null;
  maxBytes?: number | undefined;
};

export type SessionEventMcpPage = {
  mode: SessionEventReadMode;
  payloadMode: SessionEventPayloadMode;
  direction: SessionEventReadDirection;
  events: SessionEvent[];
  coveredSequence: { first: number; last: number } | null;
  nextAfter: number | null;
  nextBefore: number | null;
  hasMore: boolean;
  truncated: boolean;
  truncation?: {
    reasons: Array<"source_count" | "source_bytes" | "model_payload" | "model_bytes">;
    omittedSide: "before" | "after";
    resumeCursor: number | null;
  };
  bytes: number;
  maxBytes: number;
};

function prettyJsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function setMeasuredBytes(page: SessionEventMcpPage): number {
  let measured = page.bytes;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    page.bytes = measured;
    const next = prettyJsonBytes(page);
    if (next === measured) return next;
    measured = next;
  }
  page.bytes = measured;
  return prettyJsonBytes(page);
}

/**
 * Build the exact model-visible page. Returned `bytes` includes all metadata
 * and pretty-printing used by the MCP JSON adapter.
 */
export function boundSessionEventMcpPage(input: SessionEventMcpPageInput): SessionEventMcpPage {
  const maxBytes = Math.max(8 * 1024, input.maxBytes ?? SESSION_EVENT_MCP_MAX_BYTES);
  let payloadTrimmed = false;
  const events = input.events.map((event) => {
    const capped = capEventPayload(event, SESSION_EVENT_MCP_FIELD_MAX_CHARS);
    if (capped !== event) payloadTrimmed = true;
    return capped;
  });
  let modelRowsDropped = false;

  const build = (): SessionEventMcpPage => {
    const first = events[0]?.sequence ?? null;
    const last = events.at(-1)?.sequence ?? null;
    const reasons: NonNullable<SessionEventMcpPage["truncation"]>["reasons"] = [];
    if (input.sourceHasMore) {
      reasons.push(input.sourceTruncatedBy === "bytes" ? "source_bytes" : "source_count");
    }
    if (payloadTrimmed) reasons.push("model_payload");
    if (modelRowsDropped) reasons.push("model_bytes");
    const nextAfter = input.direction === "after" ? (last ?? input.after) : null;
    const nextBefore = input.direction === "before" ? (first ?? input.before) : null;
    const page: SessionEventMcpPage = {
      mode: input.mode,
      payloadMode: input.payloadMode,
      direction: input.direction,
      events: [...events],
      coveredSequence: first === null || last === null ? null : { first, last },
      nextAfter,
      nextBefore,
      hasMore: input.sourceHasMore || modelRowsDropped,
      truncated: reasons.length > 0,
      ...(reasons.length > 0
        ? {
            truncation: {
              reasons,
              omittedSide: input.direction,
              resumeCursor: input.direction === "after" ? nextAfter : nextBefore,
            },
          }
        : {}),
      bytes: 0,
      maxBytes,
    };
    setMeasuredBytes(page);
    return page;
  };

  let page = build();
  while (page.bytes > maxBytes && events.length > 0) {
    if (input.direction === "before") events.shift();
    else events.pop();
    modelRowsDropped = true;
    page = build();
  }
  if (page.bytes > maxBytes) {
    throw new RangeError(`Session-event MCP metadata exceeds its ${maxBytes}-byte envelope`);
  }
  return page;
}

/** Clamp unbounded agent-controlled fields on `session_get`. */
export function capSessionDetail<T extends { metadata?: unknown; initialMessage?: unknown }>(
  session: T,
  perFieldChars: number = DEFAULT_SESSION_DETAIL_CHARS,
): T {
  let changed = false;
  const out: T = { ...session };
  if (session.metadata !== undefined) {
    const capped = capPayloadValue(session.metadata, perFieldChars);
    if (capped !== session.metadata) {
      (out as { metadata?: unknown }).metadata = capped;
      changed = true;
    }
  }
  if (typeof session.initialMessage === "string" && session.initialMessage.length > perFieldChars) {
    (out as { initialMessage?: unknown }).initialMessage = clampString(
      session.initialMessage,
      perFieldChars,
    );
    changed = true;
  }
  return changed ? out : session;
}
