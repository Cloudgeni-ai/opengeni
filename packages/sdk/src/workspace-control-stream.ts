import { isAbortError, isRetryableStreamError, OpenGeniStreamError } from "./errors";
import { parseSseStream } from "./sse";
import type { StreamSessionEventsOptions } from "./stream";
import type { WorkspaceControlEvent } from "./types";

export type WorkspaceControlStreamTransport = {
  /** The server replays every durable event after the cursor before going live. */
  openStream: (
    after: number,
    signal: AbortSignal | undefined,
  ) => Promise<ReadableStream<Uint8Array>>;
};

/**
 * Reconnecting workspace invalidation stream. Control revisions are monotonic
 * but can begin above one after the one-way migration, so unlike conversation
 * events this stream intentionally permits sparse sequence values.
 */
export async function* streamWorkspaceControlEvents(
  transport: WorkspaceControlStreamTransport,
  options: StreamSessionEventsOptions = {},
): AsyncGenerator<WorkspaceControlEvent, void, void> {
  const signal = options.signal;
  const reconnect = options.reconnect ?? true;
  const baseDelayMs = options.reconnectDelayMs ?? 500;
  const maxDelayMs = options.maxReconnectDelayMs ?? 10_000;
  const maxAttempts = options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
  let cursor = options.after ?? 0;
  let failures = 0;
  let delayMs = baseDelayMs;
  let everConnected = false;

  for (;;) {
    if (signal?.aborted) return;
    options.onStateChange?.(everConnected || failures > 0 ? "reconnecting" : "connecting");
    const cursorAtOpen = cursor;
    try {
      const body = await transport.openStream(cursor, signal);
      everConnected = true;
      failures = 0;
      delayMs = baseDelayMs;
      await options.beforeLive?.();
      options.onStateChange?.("live");
      for await (const message of parseSseStream(body)) {
        if (signal?.aborted) return;
        const event = parseWorkspaceControlEvent(message.data);
        if (!event || event.sequence <= cursor) continue;
        cursor = event.sequence;
        yield event;
      }
      if (!reconnect) return;
      if (cursor === cursorAtOpen) await sleep(baseDelayMs, signal);
      continue;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      if (!reconnect || !isRetryableStreamError(error)) throw error;
      failures += 1;
      if (failures > maxAttempts) {
        throw new OpenGeniStreamError(
          `workspace control stream gave up after ${maxAttempts} reconnect attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await sleep(delayMs, signal);
    delayMs = Math.min(Math.max(delayMs * 2, baseDelayMs), maxDelayMs);
  }
}

function parseWorkspaceControlEvent(data: string): WorkspaceControlEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "workspace.control.changed" ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { sequence?: unknown }).sequence !== "number"
  ) {
    return null;
  }
  return value as WorkspaceControlEvent;
}

async function sleep(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted || delayMs <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
