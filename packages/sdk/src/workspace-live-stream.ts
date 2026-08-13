import { isAbortError, isRetryableStreamError, OpenGeniStreamError } from "./errors";
import type { WorkspaceInteractionRevisionEvent } from "./interaction";
import { parseSseStream } from "./sse";
import {
  jitteredDelay,
  runBeforeLive,
  type StreamSessionEventsOptions,
  withStreamInactivityTimeout,
} from "./stream";
import type { WorkspaceControlEvent } from "./types";

export type WorkspaceLiveEvent = WorkspaceControlEvent | WorkspaceInteractionRevisionEvent;

export type WorkspaceLiveStreamOptions = Omit<StreamSessionEventsOptions, "after"> & {
  controlAfter?: number;
  interactionAfter?: number;
};

export type WorkspaceLiveStreamTransport = {
  openStream: (
    controlAfter: number,
    interactionAfter: number,
    signal: AbortSignal | undefined,
  ) => Promise<ReadableStream<Uint8Array>>;
};

/** One reconnecting SSE connection with independent durable cursors. */
export async function* streamWorkspaceLiveEvents(
  transport: WorkspaceLiveStreamTransport,
  options: WorkspaceLiveStreamOptions = {},
): AsyncGenerator<WorkspaceLiveEvent, void, void> {
  const signal = options.signal;
  const reconnect = options.reconnect ?? true;
  const baseDelayMs = options.reconnectDelayMs ?? 500;
  const maxDelayMs = options.maxReconnectDelayMs ?? 10_000;
  const jitterRatio = options.reconnectJitterRatio ?? 0.2;
  const beforeLiveTimeoutMs = options.beforeLiveTimeoutMs ?? 15_000;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  const maxAttempts = options.maxReconnectAttempts ?? Number.POSITIVE_INFINITY;
  let controlCursor = options.controlAfter ?? 0;
  let interactionCursor = options.interactionAfter ?? 0;
  let failures = 0;
  let delayMs = baseDelayMs;
  let everConnected = false;

  for (;;) {
    if (signal?.aborted) return;
    options.onStateChange?.(everConnected || failures > 0 ? "reconnecting" : "connecting");
    const cursorsAtOpen = `${controlCursor}:${interactionCursor}`;
    try {
      const body = await transport.openStream(controlCursor, interactionCursor, signal);
      everConnected = true;
      failures = 0;
      delayMs = baseDelayMs;
      await runBeforeLive(options.beforeLive, beforeLiveTimeoutMs, signal);
      options.onStateChange?.("live");
      for await (const message of parseSseStream(
        withStreamInactivityTimeout(body, heartbeatTimeoutMs, signal),
      )) {
        if (signal?.aborted) return;
        const event = parseWorkspaceLiveEvent(message.data);
        if (!event) continue;
        if (event.type === "workspace.control.changed") {
          if (event.sequence <= controlCursor) continue;
          controlCursor = event.sequence;
        } else {
          if (event.sequence <= interactionCursor) continue;
          interactionCursor = event.sequence;
        }
        yield event;
      }
      if (!reconnect) return;
      if (`${controlCursor}:${interactionCursor}` === cursorsAtOpen) {
        await sleep(jitteredDelay(baseDelayMs, jitterRatio), signal);
      }
      continue;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      if (!reconnect || !isRetryableStreamError(error)) throw error;
      failures += 1;
      if (failures > maxAttempts) {
        throw new OpenGeniStreamError(
          `workspace live stream gave up after ${maxAttempts} reconnect attempts: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await sleep(jitteredDelay(delayMs, jitterRatio), signal);
    delayMs = Math.min(Math.max(delayMs * 2, baseDelayMs), maxDelayMs);
  }
}

export function parseWorkspaceLiveEvent(data: string): WorkspaceLiveEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.sequence !== "number") return null;
  if (
    value.type === "workspace.control.changed" &&
    typeof value.id === "string" &&
    Number.isSafeInteger(value.sequence)
  ) {
    return value as WorkspaceControlEvent;
  }
  if (
    value.type === "workspace.interaction.changed" &&
    typeof value.workspaceId === "string" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 0 &&
    value.revision === value.sequence &&
    typeof value.occurredAt === "string"
  ) {
    return value as WorkspaceInteractionRevisionEvent;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
