/**
 * Byte/token caps for the cross-session read tools (`session_events`,
 * `session_get`) exposed to manager-style agents over MCP.
 *
 * A long-lived manager session monitors its spawned workers by reading their
 * event timeline. Historical event rows may carry large model/tool output
 * previews and raw tool-call items (`agent.toolCall.created.payload.raw` /
 * `.arguments`). Those are sized for the worker's own audit view, not the
 * manager's: a single
 * `session_events` page (the DB limit caps event COUNT, not BYTES) can return
 * tens of thousands of characters, and a manager that pages a busy worker piles
 * hundreds of thousands of characters into its own context in one monitoring
 * turn — the exact "parent ingests child" blow-up that bricks the manager.
 *
 * The manager rarely needs a worker's full message deltas / tool outputs
 * verbatim; it needs status + recent progress. So these tools cap what they
 * hand back in two stages, both pure and exhaustively testable here:
 *
 *  1. PER-EVENT FIELD TRIM (`capEventPayload` / `capPayloadValue`): walk each
 *     event's payload and clamp any over-long string (and any over-large nested
 *     object, by serializing then clamping) to a per-field budget, leaving an
 *     explicit `…N chars truncated…` marker. Type-agnostic: it targets whatever
 *     field is fat (`text`, `output`, `arguments`, `raw`, `delta`, …) without
 *     enumerating event types, so a new fat event type is capped automatically.
 *
 *  2. HEAD+TAIL PAGE BUDGET (`capEventPage`): after per-event trim, if the page
 *     still exceeds the total token budget, keep a HEAD (oldest, for entry
 *     context) and a TAIL (newest, for recent progress) of events and drop the
 *     middle, inserting one synthetic marker event that says how many durable
 *     audit previews were dropped from this monitoring projection. A smaller
 *     page can inspect that sequence range, but it cannot recover generic
 *     source output that was never retained. Pagination semantics are
 *     preserved: `nextAfter` is still the real highest `sequence` returned, so
 *     the next page starts exactly where this one ended.
 *
 * Worker-side and UI consumers never go through here — they call the DB
 * functions or the REST routes directly. This module only shapes the MCP tool
 * result a manager model reads, and it is intentionally dependency-free (no DB)
 * so the cap logic can be unit-tested in isolation.
 */

import type { SessionEvent } from "@opengeni/contracts";

// ~4 chars per token is the same coarse estimate the runtime compaction path
// uses; we only need an order-of-magnitude budget, not exact tokenization.
const CHARS_PER_TOKEN = 4;

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function estimateValueTokens(value: unknown): number {
  return estimateTokensFromChars(safeStringify(value).length);
}

export type EventCapConfig = {
  // Per-event cap: max characters any single string field (or serialized
  // nested object) inside an event payload may contribute before it is clamped
  // with a truncation marker.
  perFieldChars: number;
  // Total page cap: max estimated tokens the whole returned event array may
  // occupy. When the per-event-trimmed page still exceeds this, head+tail
  // selection drops the middle.
  pageTokenBudget: number;
  // When head+tail selection kicks in, how many events to keep at each end.
  headEvents: number;
  tailEvents: number;
};

// ~2k chars (~500 tokens) per fat field keeps a status glance readable without
// shipping a worker's whole tool output. ~10k-token page budget sits in the
// 8–12k target band; head/tail of 8 keeps entry context plus recent progress.
export const DEFAULT_EVENT_CAP: EventCapConfig = {
  perFieldChars: 2_000,
  pageTokenBudget: 10_000,
  headEvents: 8,
  tailEvents: 8,
};

// ~6k chars (~1.5k tokens) for a single session detail blob: resources/tools/
// metadata are normally tiny, but agent-set metadata is unbounded, so clamp it.
export const DEFAULT_SESSION_DETAIL_CHARS = 6_000;

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncationMarker(droppedChars: number): string {
  return `…[${droppedChars} chars omitted from this monitoring projection; generic source output may not have been retained]`;
}

function clampString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  // Keep a head and a small tail of the field so both the start and the end
  // (often the most diagnostic part of a tool output / error) survive.
  const dropped = value.length - maxChars;
  const headChars = Math.max(0, Math.floor(maxChars * 0.7));
  const tailChars = Math.max(0, maxChars - headChars);
  const head = value.slice(0, headChars);
  const tail = tailChars > 0 ? value.slice(value.length - tailChars) : "";
  return `${head}${truncationMarker(dropped)}${tail}`;
}

/**
 * Recursively clamp any over-budget string or nested value inside a payload.
 * Strings longer than `perFieldChars` are head+tail clamped. Nested objects /
 * arrays whose serialized form exceeds `perFieldChars` are recursed into so the
 * clamp lands on the actual fat leaf; if recursion cannot shrink them enough
 * (e.g. thousands of tiny fields), the whole branch is replaced by its clamped
 * serialization. Plain scalars pass through untouched. A depth guard makes the
 * walk safe against pathological / cyclic structures.
 */
export function capPayloadValue(value: unknown, perFieldChars: number, depth = 0): unknown {
  if (typeof value === "string") {
    return clampString(value, perFieldChars);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  // Guard against pathological / cyclic structures: past a reasonable depth,
  // collapse to a clamped serialization.
  if (depth >= 8) {
    return clampString(safeStringify(value), perFieldChars);
  }
  const serializedLength = safeStringify(value).length;
  if (serializedLength <= perFieldChars) {
    return value;
  }
  if (Array.isArray(value)) {
    const mapped = value.map((entry) => capPayloadValue(entry, perFieldChars, depth + 1));
    if (safeStringify(mapped).length <= perFieldChars * 2) {
      return mapped;
    }
    return clampString(safeStringify(value), perFieldChars);
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = capPayloadValue(entry, perFieldChars, depth + 1);
  }
  // If recursion still left the object fat (many small fields), fall back to a
  // clamped serialization so the page budget is respected.
  if (safeStringify(out).length <= perFieldChars * 4) {
    return out;
  }
  return clampString(safeStringify(value), perFieldChars);
}

export function capEventPayload(event: SessionEvent, perFieldChars: number): SessionEvent {
  const cappedPayload = capPayloadValue(event.payload, perFieldChars);
  if (cappedPayload === event.payload) {
    return event;
  }
  return { ...event, payload: cappedPayload };
}

export type CappedEventPage = {
  events: SessionEvent[];
  // The real highest `sequence` among the events the DB returned, so the caller
  // can advance the cursor correctly even when the middle was dropped. Null
  // when the page was empty.
  nextAfter: number | null;
  truncated: boolean;
};

/**
 * Build a synthetic marker event that stands in for the dropped middle. It is
 * NOT a real persisted event; its `id` is the zero UUID and its sequence sits
 * between the kept head and tail so ordering by sequence stays monotonic. It
 * never participates in pagination (the caller derives `nextAfter` from the
 * real events, not this marker). Typed `session.status.changed` so the
 * synthetic event still validates against the `SessionEvent` contract.
 */
function buildTruncationEvent(
  template: SessionEvent,
  droppedCount: number,
  firstDroppedSequence: number,
  lastDroppedSequence: number,
  markerSequence: number,
): SessionEvent {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    workspaceId: template.workspaceId,
    sessionId: template.sessionId,
    sequence: markerSequence,
    type: "session.status.changed",
    payload: {
      _truncated: true,
      note: `${droppedCount} durable audit preview(s) (sequence ${firstDroppedSequence}–${lastDroppedSequence}) omitted from this monitoring view to keep the response bounded. Re-read that range with session_events after=${firstDroppedSequence - 1} and a smaller limit. This can recover only retained audit previews; generic source output is unavailable unless a separate artifact/file receipt retained it.`,
      droppedCount,
      omittedSequenceRange: [firstDroppedSequence, lastDroppedSequence],
    },
    occurredAt: template.occurredAt,
    clientEventId: null,
    turnId: null,
  };
}

/**
 * Apply per-event field trim then, if the page is still over budget, keep a
 * head and a tail of events and drop the middle behind a marker. `events` is
 * assumed oldest-first (as `listSessionEvents` returns).
 */
export function capEventPage(
  events: SessionEvent[],
  config: EventCapConfig = DEFAULT_EVENT_CAP,
): CappedEventPage {
  const realLast = events[events.length - 1];
  const nextAfter = realLast ? realLast.sequence : null;

  const trimmed = events.map((event) => capEventPayload(event, config.perFieldChars));

  let runningTokens = 0;
  let overBudget = false;
  for (const event of trimmed) {
    runningTokens += estimateValueTokens(event);
    if (runningTokens > config.pageTokenBudget) {
      overBudget = true;
      break;
    }
  }

  const keepCount = config.headEvents + config.tailEvents;
  if (!overBudget || trimmed.length <= keepCount + 1) {
    return { events: trimmed, nextAfter, truncated: overBudget && trimmed.length > keepCount + 1 };
  }

  const head = trimmed.slice(0, config.headEvents);
  const tail = trimmed.slice(trimmed.length - config.tailEvents);
  const droppedStart = config.headEvents;
  const droppedEnd = trimmed.length - config.tailEvents - 1;
  const droppedCount = droppedEnd - droppedStart + 1;
  const firstDroppedSequence = trimmed[droppedStart]!.sequence;
  const lastDroppedSequence = trimmed[droppedEnd]!.sequence;
  // Marker sequence sits between the kept head and tail; reusing the last head
  // sequence keeps the returned page monotonic non-decreasing by sequence.
  const markerSequence = head[head.length - 1]!.sequence;
  const marker = buildTruncationEvent(
    realLast!,
    droppedCount,
    firstDroppedSequence,
    lastDroppedSequence,
    markerSequence,
  );

  return {
    events: [...head, marker, ...tail],
    nextAfter,
    truncated: true,
  };
}

/**
 * Clamp a single session-detail object for `session_get`. Only the unbounded
 * agent-controlled fields (`metadata`, and defensively `initialMessage`) can
 * grow large; everything else is small and structural. Returns a shallow copy
 * with those fields capped when over budget, otherwise the original reference.
 */
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
