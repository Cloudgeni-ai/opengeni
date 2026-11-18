/**
 * What the session proxy keeps from the browser: the Opengeni credits a
 * turn or a chat-completions call charged. They are the product's billing
 * data, read by its server with its own credentials, not something to show
 * the person chatting:
 *
 * - a turn's `usage` (`{ creditsMicros, tokens, breakdown }`) on terminal turn
 *   events and on turns;
 * - `usage.cost` on chat-completions responses and their final chunk.
 *
 * Bodies that carry neither pass through untouched (a substring check before
 * any parse), so ordinary reads and streams cost nothing extra.
 */

const TURN_USAGE_MARK = '"creditsMicros"';
const COMPLETION_COST_MARK = '"cost"';

function mayCarryUsage(text: string): boolean {
  return text.includes(TURN_USAGE_MARK) || text.includes(COMPLETION_COST_MARK);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Removes turn usage and completion cost in place; true when anything changed. */
export function stripCreditUsage(value: unknown): boolean {
  if (Array.isArray(value)) {
    let changed = false;
    for (const item of value) changed = stripCreditUsage(item) || changed;
    return changed;
  }
  if (!isRecord(value)) return false;
  let changed = false;
  const usage = value.usage;
  if (isRecord(usage)) {
    if ("creditsMicros" in usage) {
      delete value.usage;
      changed = true;
    } else if (
      "cost" in usage &&
      (value.object === "chat.completion" || value.object === "chat.completion.chunk")
    ) {
      delete usage.cost;
      changed = true;
    }
  }
  for (const child of Object.values(value)) {
    if (typeof child === "object" && child !== null) {
      changed = stripCreditUsage(child) || changed;
    }
  }
  return changed;
}

/** A JSON body without credit usage, or the same text when it has none. */
export function stripCreditUsageFromJsonText(text: string): string {
  if (!mayCarryUsage(text)) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  return stripCreditUsage(parsed) ? JSON.stringify(parsed) : text;
}

function stripLine(line: string): string {
  // `data:` lines carry the JSON; every other field passes through.
  if (!line.startsWith("data:") || !mayCarryUsage(line)) return line;
  const spaced = line.startsWith("data: ");
  const body = line.slice(spaced ? 6 : 5);
  const carriageReturn = body.endsWith("\r");
  const json = carriageReturn ? body.slice(0, -1) : body;
  const stripped = stripCreditUsageFromJsonText(json);
  if (stripped === json) return line;
  return `${spaced ? "data: " : "data:"}${stripped}${carriageReturn ? "\r" : ""}`;
}

/**
 * An event stream without credit usage. Lines pass through as soon as they
 * end, so events are not delayed; only a line still being received is held.
 */
export function stripCreditUsageFromEventStream(
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
        controller.enqueue(encoder.encode(complete.split("\n").map(stripLine).join("\n")));
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending.length > 0) controller.enqueue(encoder.encode(stripLine(pending)));
      },
    }),
  );
}

/** The event without the turn's credit usage (a copy only when it has one). */
export function withoutTurnCreditUsage<T extends { payload?: unknown }>(event: T): T {
  const payload = event.payload;
  if (!isRecord(payload) || !isRecord(payload.usage) || !("creditsMicros" in payload.usage)) {
    return event;
  }
  const { usage: _usage, ...rest } = payload;
  return { ...event, payload: rest };
}
