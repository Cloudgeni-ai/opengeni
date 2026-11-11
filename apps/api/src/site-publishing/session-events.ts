import { siteRuntimeForwardedResponse } from "./runtime";

/**
 * The Site-safe view of a published-Site conversation's events, shared by
 * the event pages and the event stream so both deliver the same thing.
 *
 * A viewer sees the conversation, not the workspace behind it:
 * - Only the event types a chat needs are delivered: messages (with their
 *   live text deltas), tool-call receipts, turn and session lifecycle, the
 *   queue and usage notices. Their payloads keep allowlisted fields only:
 *   message text, a tool's call id and name and whether it failed (never its
 *   arguments or output), and short status codes (never error text).
 * - Every other event (reasoning, sandbox and terminal output, model and
 *   provider-account telemetry, setup, goals, memory, policy and late or
 *   duplicate deliveries) becomes a `session.event.envelope_omitted`
 *   placeholder with an empty payload. The placeholder keeps the sequence
 *   contiguous, so a client's gap detection and resume still work, and says
 *   nothing about what was there.
 * - The envelope keeps the event id, session id, sequence, coverage,
 *   occurrence time and turn id. It drops the workspace id, attempt ids and
 *   generations, duplicate diagnostics, codec and read-bound markers.
 */

const OMITTED_TYPE = "session.event.envelope_omitted";

type FieldRule = "text" | "code" | "ref" | "count" | "flag";

/** Event types a Site viewer receives, with the payload fields each keeps. */
const SITE_EVENT_PAYLOAD_FIELDS: ReadonlyMap<string, Readonly<Record<string, FieldRule>>> = new Map<
  string,
  Readonly<Record<string, FieldRule>>
>([
  ["session.created", {}],
  ["session.status.changed", { status: "code", previousStatus: "code", code: "code" }],
  ["session.title_set", { title: "text" }],
  ["session.requiresAction", {}],
  ["session.humanInput.requested", {}],
  ["session.queue.changed", { operation: "code", queueVersion: "count" }],
  ["session.queue.prompt.cancelled", {}],
  ["session.control.paused", {}],
  ["session.control.resumed", {}],
  ["session.control.steer_requested", {}],
  [OMITTED_TYPE, {}],
  ["user.message", { text: "text", delivery: "code", routing: "code" }],
  ["user.pause", {}],
  ["turn.queued", {}],
  ["turn.started", {}],
  ["turn.completed", { segmentLimit: "code", maintenance: "code" }],
  ["turn.failed", { code: "code", failureCode: "code", retryable: "flag" }],
  ["turn.cancelled", { reason: "code" }],
  ["turn.superseded", { reason: "code" }],
  [
    "agent.message.delta",
    { text: "text", messageId: "ref", phase: "code", coalescedUntil: "count" },
  ],
  ["agent.message.completed", { text: "text", messageId: "ref", phase: "code" }],
  ["agent.toolCall.created", { id: "ref", name: "ref" }],
  ["agent.toolCall.output", { id: "ref", name: "ref", error: "flag" }],
  ["usage.threshold_reached", {}],
  ["usage.exhausted", {}],
]);

/** The event types a Site viewer can receive with their content. */
export const SITE_VISIBLE_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set(
  SITE_EVENT_PAYLOAD_FIELDS.keys(),
);

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const REF = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function allowedField(rule: FieldRule, value: unknown): boolean {
  switch (rule) {
    case "text":
      return typeof value === "string";
    case "code":
      return typeof value === "string" && CODE.test(value);
    case "ref":
      return typeof value === "string" && REF.test(value);
    case "count":
      return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    case "flag":
      return typeof value === "boolean";
  }
}

export type SiteSessionEventPayloadMode = "summary" | "none";

/**
 * Project one event for a Site viewer, or null when it is not an event at all.
 * Hidden events become an omitted placeholder at the same sequence.
 */
export function siteSessionEventProjection(
  event: unknown,
  options: { payload?: SiteSessionEventPayloadMode } = {},
): Record<string, unknown> | null {
  const source = record(event);
  if (!source) return null;
  const { id, sequence } = source;
  if (typeof id !== "string" || typeof sequence !== "number" || !Number.isSafeInteger(sequence))
    return null;
  const projected: Record<string, unknown> = {
    id,
    sessionId: typeof source.sessionId === "string" ? source.sessionId : null,
    sequence,
  };
  const covered = source.coveredThrough;
  if (typeof covered === "number" && Number.isSafeInteger(covered) && covered >= sequence)
    projected.coveredThrough = covered;
  projected.occurredAt = typeof source.occurredAt === "string" ? source.occurredAt : null;
  const current =
    (source.turnAssociation === undefined ||
      source.turnAssociation === null ||
      source.turnAssociation === "current") &&
    (source.duplicateOfEventId === undefined || source.duplicateOfEventId === null);
  const type = typeof source.type === "string" ? source.type : "";
  const fields = current ? SITE_EVENT_PAYLOAD_FIELDS.get(type) : undefined;
  if (!fields) return { ...projected, type: OMITTED_TYPE, turnId: null, payload: {} };
  projected.type = type;
  projected.turnId = typeof source.turnId === "string" ? source.turnId : null;
  if (
    type === "user.message" &&
    typeof source.clientEventId === "string" &&
    source.clientEventId.length <= 256
  )
    projected.clientEventId = source.clientEventId;
  const payload: Record<string, unknown> = {};
  const body = options.payload === "none" ? null : record(source.payload);
  if (body) {
    for (const [name, rule] of Object.entries(fields))
      if (Object.hasOwn(body, name) && allowedField(rule, body[name])) payload[name] = body[name];
    // A failed tool says so without its output (an MCP error result).
    if (type === "agent.toolCall.output" && record(body.output)?.isError === true)
      payload.error = true;
  }
  projected.payload = payload;
  return projected;
}

/** Upstream SSE frames never come close to this; a stream that does is broken. */
const SSE_BUFFER_MAX_CHARS = 8 * 1024 * 1024;

function projectSseFrame(frame: string): string | null {
  const lines = frame.split("\n");
  // Comments (`: connected`, `: heartbeat`) keep the connection alive.
  if (lines.every((line) => line.startsWith(":"))) return `${frame}\n\n`;
  let id: string | null = null;
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("id:")) id = line.slice(3).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /u, ""));
  }
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    return null;
  }
  const projected = siteSessionEventProjection(parsed);
  if (!projected) return null;
  const sequence = projected.sequence as number;
  // The frame id is the sequence this frame covers (coalesced deltas cover a
  // run); keep it so a reconnect resumes after everything it covered.
  const covered = id !== null && /^\d{1,15}$/u.test(id) && Number(id) >= sequence ? id : sequence;
  return `id: ${covered}\nevent: ${projected.type as string}\ndata: ${JSON.stringify(projected)}\n\n`;
}

/** Rewrites a session event stream (SSE or a finite SSE batch) frame by frame. */
export function siteSessionEventSseTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const drain = (controller: TransformStreamDefaultController<Uint8Array>) => {
    let start = 0;
    let output = "";
    for (let end = buffer.indexOf("\n\n", start); end >= 0; end = buffer.indexOf("\n\n", start)) {
      const frame = projectSseFrame(buffer.slice(start, end));
      if (frame !== null) output += frame;
      start = end + 2;
    }
    buffer = buffer.slice(start);
    if (output) controller.enqueue(encoder.encode(output));
    if (buffer.length > SSE_BUFFER_MAX_CHARS)
      throw new Error("Session event stream frame exceeds the Site projection buffer");
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      drain(controller);
    },
  });
}

/** A forwarded event stream, answered with the Site-safe projection. */
export function siteSessionEventStreamResponse(response: Response): Response {
  const forwarded = siteRuntimeForwardedResponse(response);
  if (!forwarded.ok || !forwarded.body) return forwarded;
  const headers = new Headers(forwarded.headers);
  headers.delete("content-length");
  return new Response(forwarded.body.pipeThrough(siteSessionEventSseTransform()), {
    status: forwarded.status,
    headers,
  });
}

/** Cursor and paging facts of an event page that stay meaningful after projection. */
const PAGE_HEADERS = [
  "x-opengeni-event-direction",
  "x-opengeni-page-max-bytes",
  "x-opengeni-page-truncated",
  "x-opengeni-has-more",
  "x-opengeni-truncated-by",
  "x-opengeni-covered-first",
  "x-opengeni-covered-last",
  "x-opengeni-next-after",
  "x-opengeni-next-before",
] as const;

/** A forwarded event page, answered with the Site-safe projection. */
export async function siteSessionEventPageResponse(
  response: Response,
  options: { payload?: SiteSessionEventPayloadMode } = {},
): Promise<Response> {
  if (!response.ok) return siteRuntimeForwardedResponse(response);
  const body: unknown = await response.json().catch(() => null);
  const events = (Array.isArray(body) ? body : [])
    .map((event) => siteSessionEventProjection(event, options))
    .filter((event): event is Record<string, unknown> => event !== null);
  return siteSessionEventPage(events, options, response.headers);
}

/** A page of already projected events with monitoring-read headers. */
export function siteSessionEventPage(
  events: readonly Record<string, unknown>[],
  options: { payload?: SiteSessionEventPayloadMode } = {},
  upstream?: Headers,
): Response {
  const text = JSON.stringify(events);
  const headers = new Headers({
    "content-type": "application/json; charset=UTF-8",
    "cache-control": "no-store",
    "x-opengeni-event-mode": "monitoring",
    "x-opengeni-payload-mode": options.payload === "none" ? "none" : "summary",
    "x-opengeni-forensic-exact": "false",
    "x-opengeni-page-bytes": String(new TextEncoder().encode(text).byteLength),
  });
  for (const name of PAGE_HEADERS) {
    const value = upstream?.get(name);
    if (value !== null && value !== undefined) headers.set(name, value);
  }
  return new Response(text, { status: 200, headers });
}
