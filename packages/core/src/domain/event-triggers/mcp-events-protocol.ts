import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  type ClientCapabilities,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import type { McpStreamableHttpClient } from "../mcp-streamable-http-client";
import { errorMessage } from "@opengeni/contracts/values";

/**
 * The client side of the MCP Events extension (SEP-3415,
 * `io.modelcontextprotocol/events`, protocol revision 2026-07-28): the wire
 * shapes of `events/list`, `events/poll`, `events/subscribe` and
 * `events/unsubscribe`, the signed webhook bodies a server POSTs back, the
 * `Mcp-Name` routing header, and the protocol's error codes.
 *
 * Servers built for ChatGPT follow the extension's earlier design sketch,
 * which differs from SEP-3415 in two ways a client sees: it advertises
 * `capabilities.events` instead of an `extensions` entry, and it numbers its
 * errors -32011 to -32015 instead of -32023 to -32027. Both are accepted.
 * The MCP client keeps only the capabilities it knows, so a server without
 * the `extensions` entry is asked `events/list` instead of read.
 * Its webhook deliveries reuse the `eventId` as `webhook-id`, which the
 * receiver's deduplication already handles.
 */

export const MCP_EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/** Declared on every connection that uses events, so a server knows we understand them. */
export const MCP_EVENTS_CLIENT_CAPABILITIES: ClientCapabilities = {
  extensions: { [MCP_EVENTS_EXTENSION]: {} },
};

export const McpEventsErrorCode = {
  MethodNotFound: -32_601,
  InvalidParams: -32_602,
  NotFound: -32_023,
  Forbidden: -32_024,
  ResourceExhausted: -32_025,
  Unsupported: -32_026,
  CallbackEndpointError: -32_027,
} as const;

/** The same errors in the design sketch's numbering, which ChatGPT's servers use. */
export const McpEventsDraftErrorCode = {
  NotFound: -32_011,
  Forbidden: -32_012,
  ResourceExhausted: -32_013,
  Unsupported: -32_014,
  CallbackEndpointError: -32_015,
} as const;

const DRAFT_ERROR_CODES = new Map<number, number>(
  (Object.keys(McpEventsDraftErrorCode) as Array<keyof typeof McpEventsDraftErrorCode>).map(
    (name) => [McpEventsDraftErrorCode[name], McpEventsErrorCode[name]],
  ),
);

export type McpEventDeliveryMode = "poll" | "push" | "webhook";
const DELIVERY_MODES = new Set<string>(["poll", "push", "webhook"]);

const JsonObject = z.record(z.string(), z.unknown());

/** One event type a server offers, as `events/list` describes it. */
export type McpEventType = {
  name: string;
  description: string | null;
  delivery: McpEventDeliveryMode[];
  inputSchema: Record<string, unknown> | null;
  payloadSchema: Record<string, unknown> | null;
};

const McpEventTypeWire = z.looseObject({
  name: z.string().min(1).max(512),
  description: z.string().optional(),
  delivery: z.array(z.string()),
  inputSchema: JsonObject.optional(),
  payloadSchema: JsonObject.optional(),
});

const ListResultWire = z.looseObject({
  events: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

/** One occurrence: an entry of a poll result or the body of a webhook delivery. */
export const McpEventOccurrence = z.looseObject({
  eventId: z.string().min(1),
  name: z.string().min(1),
  timestamp: z.string(),
  data: JsonObject,
  cursor: z.string().nullable().optional(),
});
export type McpEventOccurrence = z.infer<typeof McpEventOccurrence>;

const PollResultWire = z.looseObject({
  events: z.array(z.unknown()),
  cursor: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
  hasMore: z.boolean().optional(),
  nextPollMs: z.number().optional(),
});

const SubscribeResultWire = z.looseObject({
  id: z.string().min(1),
  refreshBefore: z.string().nullable().optional(),
  cursor: z.string().nullable().optional(),
  truncated: z.boolean().optional(),
  deliveryStatus: z
    .looseObject({
      active: z.boolean().optional(),
      lastError: z.string().nullable().optional(),
    })
    .optional(),
});

const EmptyResultWire = z.looseObject({});

export type McpEventPollResult = {
  /** The occurrences that parsed; `skipped` counts the ones that did not. */
  events: McpEventOccurrence[];
  /** The raw `events` array, kept for the delivery log. */
  rawEvents: unknown[];
  skipped: number;
  cursor: string | null;
  /** Events were skipped before this page. Ignored for types without replay. */
  truncated: boolean;
  hasMore: boolean;
  nextPollMs: number | null;
};

export type McpEventSubscribeResult = {
  id: string;
  /** When the subscription lapses unless refreshed; null when it never does. */
  refreshBefore: Date | null;
  cursor: string | null;
  truncated: boolean;
  /** The server's last delivery problem with our endpoint, as a category. */
  deliveryError: string | null;
};

export type McpEventStreamParams = {
  name: string;
  arguments: Record<string, unknown>;
};

type RequestOptions = { timeout: number; signal?: AbortSignal };

function requestOptions(options: RequestOptions) {
  return {
    timeout: options.timeout,
    maxTotalTimeout: options.timeout,
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

/**
 * Does the connected server offer events? A SEP-3415 server says so in its
 * capabilities. Any other server is asked for its first page of event types:
 * one that answers offers events however it advertises them (ChatGPT's sketch
 * uses a top-level `events` capability the MCP client does not keep), and one
 * that doesn't know the method does not.
 */
export async function serverOffersMcpEvents(
  client: McpStreamableHttpClient,
  options: RequestOptions,
): Promise<boolean> {
  const extensions = client.getServerCapabilities()?.extensions as
    | Record<string, unknown>
    | undefined;
  const settings = extensions?.[MCP_EVENTS_EXTENSION];
  if (settings !== undefined && settings !== null && typeof settings === "object") return true;
  try {
    await client.request({ method: "events/list" }, ListResultWire, requestOptions(options));
    return true;
  } catch (error) {
    if (classifyMcpEventsError(error).kind === "events_unsupported") return false;
    throw error;
  }
}

const MAX_EVENT_TYPE_PAGES = 20;
const MAX_EVENT_TYPES = 500;

/** Every event type the server offers, across pages. Malformed entries are left out. */
export async function listMcpEventTypes(
  client: McpStreamableHttpClient,
  options: RequestOptions,
): Promise<McpEventType[]> {
  const types = new Map<string, McpEventType>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_EVENT_TYPE_PAGES; page += 1) {
    const result = await client.request(
      { method: "events/list", ...(cursor ? { params: { cursor } } : {}) },
      ListResultWire,
      requestOptions(options),
    );
    for (const entry of result.events) {
      const parsed = McpEventTypeWire.safeParse(entry);
      if (!parsed.success || types.has(parsed.data.name)) continue;
      const delivery = parsed.data.delivery.filter((mode): mode is McpEventDeliveryMode =>
        DELIVERY_MODES.has(mode),
      );
      types.set(parsed.data.name, {
        name: parsed.data.name,
        description: parsed.data.description?.trim() || null,
        delivery: [...new Set(delivery)],
        inputSchema: parsed.data.inputSchema ?? null,
        payloadSchema: parsed.data.payloadSchema ?? null,
      });
      if (types.size >= MAX_EVENT_TYPES) return [...types.values()];
    }
    cursor = result.nextCursor;
    if (!cursor || seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
  }
  return [...types.values()];
}

function parseOccurrences(raw: unknown[]): { events: McpEventOccurrence[]; skipped: number } {
  const events: McpEventOccurrence[] = [];
  let skipped = 0;
  for (const entry of raw) {
    const parsed = McpEventOccurrence.safeParse(entry);
    if (parsed.success) events.push(parsed.data);
    else skipped += 1;
  }
  return { events, skipped };
}

/** One `events/poll`. A null cursor starts from now. */
export async function pollMcpEvents(
  client: McpStreamableHttpClient,
  params: McpEventStreamParams & {
    cursor: string | null;
    maxEvents: number;
    /** Replay no further back than this; sent only with a cursor. */
    maxAgeMs: number;
  },
  options: RequestOptions,
): Promise<McpEventPollResult> {
  const result = await client.request(
    {
      method: "events/poll",
      params: {
        name: params.name,
        arguments: params.arguments,
        cursor: params.cursor,
        maxEvents: params.maxEvents,
        ...(params.cursor !== null ? { maxAgeMs: params.maxAgeMs } : {}),
      },
    },
    PollResultWire,
    requestOptions(options),
  );
  const { events, skipped } = parseOccurrences(result.events);
  const cursor = result.cursor ?? null;
  return {
    events,
    rawEvents: result.events,
    skipped,
    cursor,
    // Without replay there is no position to have skipped past.
    truncated: result.truncated === true && cursor !== null,
    hasMore: result.hasMore === true,
    nextPollMs:
      typeof result.nextPollMs === "number" && Number.isFinite(result.nextPollMs)
        ? result.nextPollMs
        : null,
  };
}

function parseGrant(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Create or refresh a webhook subscription; idempotent for the same name, arguments and URL. */
export async function subscribeMcpEvents(
  client: McpStreamableHttpClient,
  params: McpEventStreamParams & {
    url: string;
    secret: string;
    cursor: string | null;
    maxAgeMs: number;
    ttlMs: number;
  },
  options: RequestOptions,
): Promise<McpEventSubscribeResult> {
  const result = await client.request(
    {
      method: "events/subscribe",
      params: {
        name: params.name,
        arguments: params.arguments,
        delivery: { mode: "webhook", url: params.url, secret: params.secret },
        cursor: params.cursor,
        ...(params.cursor !== null ? { maxAgeMs: params.maxAgeMs } : {}),
        ttlMs: params.ttlMs,
      },
    },
    SubscribeResultWire,
    requestOptions(options),
  );
  const cursor = result.cursor ?? null;
  return {
    id: result.id,
    refreshBefore: parseGrant(result.refreshBefore),
    cursor,
    truncated: result.truncated === true && cursor !== null,
    deliveryError: result.deliveryStatus?.lastError?.slice(0, 64) ?? null,
  };
}

export async function unsubscribeMcpEvents(
  client: McpStreamableHttpClient,
  params: McpEventStreamParams & { url: string },
  options: RequestOptions,
): Promise<void> {
  await client.request(
    {
      method: "events/unsubscribe",
      params: {
        name: params.name,
        arguments: params.arguments,
        delivery: { url: params.url },
      },
    },
    EmptyResultWire,
    requestOptions(options),
  );
}

const NAMED_EVENT_METHODS = new Set([
  "events/poll",
  "events/stream",
  "events/subscribe",
  "events/unsubscribe",
]);

/**
 * A header value as the Streamable HTTP transport carries it: plain when it
 * is safe printable ASCII, otherwise in the `=?base64?…?=` sentinel form.
 */
export function encodeMcpHeaderValue(value: string): string {
  const plain =
    value.length > 0 &&
    value === value.trim() &&
    /^[\t\x20-\x7e]*$/u.test(value) &&
    !/^=\?base64\?.*\?=$/u.test(value);
  return plain ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

type FetchFunction = (url: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * The extension requires `Mcp-Name` (the event name) on every named events
 * request, which the SDK sets only for its own methods. Wrap the transport's
 * fetch to add it from the JSON-RPC body.
 */
export function withMcpEventNameHeader(fetch: FetchFunction): FetchFunction {
  return async (url, init) => {
    const name = typeof init?.body === "string" ? namedEventRequest(init.body) : null;
    if (name === null) return await fetch(url, init);
    const headers = new Headers(init?.headers);
    if (!headers.has("mcp-name")) headers.set("mcp-name", encodeMcpHeaderValue(name));
    return await fetch(url, { ...init, headers });
  };
}

function namedEventRequest(body: string): string | null {
  if (!body.includes('"events/')) return null;
  try {
    const message = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } };
    return typeof message.method === "string" &&
      NAMED_EVENT_METHODS.has(message.method) &&
      typeof message.params?.name === "string"
      ? message.params.name
      : null;
  } catch {
    return null;
  }
}

/** A body a server POSTs to a webhook subscription's callback URL. */
export type McpWebhookBody =
  | { kind: "event"; occurrence: McpEventOccurrence }
  | { kind: "verification"; challenge: string }
  | { kind: "gap"; cursor: string | null }
  | { kind: "terminated"; error: { code: number; message: string; data?: unknown } }
  | { kind: "ignored"; reason: string };

const VerificationWire = z.looseObject({ type: z.literal("verification"), challenge: z.string() });
const GapWire = z.looseObject({
  type: z.literal("gap"),
  cursor: z.string().nullable().optional(),
});
const TerminatedWire = z.looseObject({
  type: z.literal("terminated"),
  error: z.looseObject({ code: z.number(), message: z.string(), data: z.unknown().optional() }),
});

/** Read a verified webhook body: an event, or a control envelope (it has a top-level `type`). */
export function readMcpWebhookBody(body: Uint8Array): McpWebhookBody {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { kind: "ignored", reason: "The body is not JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "ignored", reason: "The body is not a JSON object" };
  }
  const type = (value as { type?: unknown }).type;
  if (type === undefined) {
    const occurrence = McpEventOccurrence.safeParse(value);
    return occurrence.success
      ? { kind: "event", occurrence: occurrence.data }
      : { kind: "ignored", reason: "The body is not a valid event" };
  }
  if (type === "verification") {
    const parsed = VerificationWire.safeParse(value);
    if (parsed.success) return { kind: "verification", challenge: parsed.data.challenge };
  } else if (type === "gap") {
    const parsed = GapWire.safeParse(value);
    if (parsed.success) return { kind: "gap", cursor: parsed.data.cursor ?? null };
  } else if (type === "terminated") {
    const parsed = TerminatedWire.safeParse(value);
    if (parsed.success) return { kind: "terminated", error: parsed.data.error };
  }
  return {
    kind: "ignored",
    reason: `Unknown control message ${typeof type === "string" ? type.slice(0, 64) : "type"}`,
  };
}

/** What went wrong with an events request, in the terms the subscription loop acts on. */
export type McpEventsFailure =
  | { kind: "event_type_gone" }
  | { kind: "schema_changed" }
  | { kind: "delivery_mode_unsupported" }
  | { kind: "forbidden"; detail: string | null }
  | { kind: "invalid_arguments"; detail: string | null }
  | { kind: "callback_unreachable"; reason: string }
  | { kind: "events_unsupported" }
  | { kind: "unauthorized" }
  | { kind: "transient"; detail: string };

function errorDetail(message: string, data: unknown): string | null {
  const reason = (data as { reason?: unknown } | null | undefined)?.reason;
  const text = typeof reason === "string" && reason.trim() ? reason : message;
  return text.trim() ? text.trim().slice(0, 300) : null;
}

const JsonRpcErrorBody = z.looseObject({
  error: z.looseObject({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  }),
});

/** The JSON-RPC error an HTTP error response carries, if its body is one. */
function jsonRpcErrorIn(text: unknown): { code: number; message: string; data?: unknown } | null {
  if (typeof text !== "string" || !text.trimStart().startsWith("{")) return null;
  try {
    const parsed = JsonRpcErrorBody.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data.error : null;
  } catch {
    return null;
  }
}

/** Classify one protocol-level error (also used for a webhook `terminated` envelope). */
export function classifyMcpEventsProtocolError(error: {
  code: number;
  message: string;
  data?: unknown;
}): McpEventsFailure {
  const data = (error.data ?? null) as Record<string, unknown> | null;
  switch (DRAFT_ERROR_CODES.get(error.code) ?? error.code) {
    case McpEventsErrorCode.NotFound:
      return { kind: "event_type_gone" };
    case McpEventsErrorCode.Unsupported:
      if (data?.reason === "schema_changed") return { kind: "schema_changed" };
      if (data?.feature === "deliveryMode") return { kind: "delivery_mode_unsupported" };
      return { kind: "invalid_arguments", detail: errorDetail(error.message, data) };
    case McpEventsErrorCode.Forbidden:
      return { kind: "forbidden", detail: errorDetail(error.message, data) };
    case McpEventsErrorCode.InvalidParams:
      return { kind: "invalid_arguments", detail: errorDetail(error.message, data) };
    case McpEventsErrorCode.CallbackEndpointError:
      return {
        kind: "callback_unreachable",
        reason: typeof data?.reason === "string" ? data.reason.slice(0, 64) : "unknown",
      };
    case McpEventsErrorCode.MethodNotFound:
      return { kind: "events_unsupported" };
    default:
      return { kind: "transient", detail: `${error.code}: ${error.message}`.slice(0, 300) };
  }
}

/** Classify anything an events request can throw. */
export function classifyMcpEventsError(error: unknown): McpEventsFailure {
  if (ProtocolError.isInstance(error)) return classifyMcpEventsProtocolError(error);
  if (SdkHttpError.isInstance(error)) {
    const { status, text } = (error.data ?? {}) as { status?: unknown; text?: unknown };
    if (status === 401) return { kind: "unauthorized" };
    if (status === 403) return { kind: "forbidden", detail: null };
    // Over HTTP a JSON-RPC error can arrive with an error status, such as an
    // unknown method as 404; the error in the body says what happened.
    const rpc = jsonRpcErrorIn(text);
    if (rpc) return classifyMcpEventsProtocolError(rpc);
    return { kind: "transient", detail: `HTTP ${String(status ?? "error")}` };
  }
  if (SdkError.isInstance(error)) {
    return {
      kind: "transient",
      detail:
        error.code === SdkErrorCode.RequestTimeout
          ? "The server did not answer in time"
          : error.message.slice(0, 300),
    };
  }
  // A connect failure arrives re-expressed in the 2025 SDK's shape.
  const legacy = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  if (legacy && typeof legacy.code === "number" && typeof legacy.message === "string") {
    if (legacy.name === "McpError") {
      return classifyMcpEventsProtocolError({
        code: legacy.code,
        message: legacy.message.replace(/^MCP error -?\d+: /u, ""),
        data: (legacy as { data?: unknown }).data,
      });
    }
    if (legacy.message.startsWith("Streamable HTTP error")) {
      if (legacy.code === 401) return { kind: "unauthorized" };
      if (legacy.code === 403) return { kind: "forbidden", detail: null };
    }
  }
  const message = errorMessage(error);
  return { kind: "transient", detail: message.slice(0, 300) || "The request failed" };
}
