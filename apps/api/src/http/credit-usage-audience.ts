import type { Context, MiddlewareHandler } from "hono";

/**
 * The Opengeni credits a turn or chat completion charged are the product's
 * billing data. A product server reads them with its own credentials; the
 * person chatting in an embedded app never does.
 *
 * Requests a session proxy relays from a browser are made as the product's
 * end user (`asUser`, an external actor) or with its server credential (an API
 * key or a delegated service token), and ask for the compact chat projection
 * (every `@opengeni/sdk` session proxy adds
 * `Accept: application/json; opengeni-session=chat`). Those reads leave out a
 * turn's `usage` and chat completions' `usage.cost`. Opengeni's own app signs
 * in as a person and keeps them, as does any server read in the full
 * projection (the default), `asUser` included.
 */

const CHAT_ACCEPT = "application/json; opengeni-session=chat";
const TURN_USAGE_MARK = '"creditsMicros"';
const TERMINAL_TURN_EVENTS = new Set([
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.superseded",
]);

/** The credentials a product server relays a browser's reads with. */
const SERVER_CREDENTIALS: ReadonlySet<string> = new Set(["api_key", "configured_key", "service"]);

const hiddenFrom = new WeakSet<Request>();

type CreditUsageGrant = {
  principalKind?: string | undefined;
  metadata?: { externalActor?: unknown } | null | undefined;
};

/** Whether this request is a browser read a product's session proxy relayed. */
export function hidesCreditUsage(c: Context, grant: CreditUsageGrant): boolean {
  // People signed in to Opengeni (its own app and Console) and agents see it.
  const relayable =
    isRecord(grant.metadata?.externalActor) ||
    (grant.principalKind !== undefined && SERVER_CREDENTIALS.has(grant.principalKind));
  if (!relayable) return false;
  c.header("Vary", "Accept", { append: true });
  return (c.req.header("accept") ?? "").split(",").some((value) => value.trim() === CHAT_ACCEPT);
}

/**
 * Notes the request's audience; `stripCreditUsageForRelayedBrowsers` then
 * removes turn usage from what the route answers.
 */
export function noteCreditUsageAudience(c: Context, grant: CreditUsageGrant): void {
  if (hidesCreditUsage(c, grant)) hiddenFrom.add(c.req.raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTurnUsage(value: unknown): boolean {
  return isRecord(value) && "creditsMicros" in value && isRecord(value.breakdown);
}

/**
 * Removes turn usage in place, true when anything changed: `payload.usage` of
 * terminal turn events and `usage` of turns (objects with a turn `status` and
 * `prompt`), wherever they sit in the body.
 */
export function stripTurnUsage(value: unknown): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) changed = stripTurnUsage(item) || changed;
    return changed;
  }
  if (!isRecord(value)) return false;
  let changed = false;
  if (
    typeof value.type === "string" &&
    TERMINAL_TURN_EVENTS.has(value.type) &&
    isRecord(value.payload) &&
    isTurnUsage(value.payload.usage)
  ) {
    delete value.payload.usage;
    changed = true;
  }
  if (typeof value.status === "string" && "prompt" in value && isTurnUsage(value.usage)) {
    delete value.usage;
    changed = true;
  }
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) changed = stripTurnUsage(child) || changed;
  }
  return changed;
}

function stripJsonText(text: string): string {
  if (!text.includes(TURN_USAGE_MARK)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return stripTurnUsage(parsed) ? JSON.stringify(parsed) : text;
}

function stripSseLine(line: string): string {
  if (!line.startsWith("data:") || !line.includes(TURN_USAGE_MARK)) return line;
  const spaced = line.startsWith("data: ");
  const body = line.slice(spaced ? 6 : 5);
  const carriageReturn = body.endsWith("\r");
  const json = carriageReturn ? body.slice(0, -1) : body;
  const stripped = stripJsonText(json);
  if (stripped === json) return line;
  return `${spaced ? "data: " : "data:"}${stripped}${carriageReturn ? "\r" : ""}`;
}

/** An event stream without turn usage; whole lines pass through as they end. */
export function stripTurnUsageFromEventStream(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const end = pending.lastIndexOf("\n");
        if (end < 0) return;
        const complete = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        controller.enqueue(encoder.encode(complete.split("\n").map(stripSseLine).join("\n")));
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending.length > 0) controller.enqueue(encoder.encode(stripSseLine(pending)));
      },
    }),
  );
}

/**
 * Rewrites the answer of a route that called `noteCreditUsageAudience` for a
 * relayed browser read. Other requests pass through untouched.
 */
export const stripCreditUsageForRelayedBrowsers: MiddlewareHandler = async (c, next) => {
  await next();
  if (!hiddenFrom.has(c.req.raw)) return;
  const response = c.res;
  if (response.body === null) return;
  const contentType = response.headers.get("content-type") ?? "";
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  let body: BodyInit;
  if (/^text\/event-stream\b/i.test(contentType)) {
    body = stripTurnUsageFromEventStream(response.body);
  } else if (/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) {
    const text = await response.text();
    const stripped = stripJsonText(text);
    if (stripped !== text) headers.delete("etag");
    body = stripped;
  } else {
    return;
  }
  // Hono copies the previous answer's headers onto a replacement; clear it
  // first so the removed length and validator stay removed.
  c.res = undefined;
  c.res = new Response(body, { status: response.status, statusText: response.statusText, headers });
};
