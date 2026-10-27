import { reconnectingCursorStream, type StreamSessionEventsOptions } from "./stream";
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
  yield* reconnectingCursorStream({
    label: "workspace control stream",
    options,
    cursor: options.after ?? 0,
    open: (cursor, signal) => transport.openStream(cursor, signal),
    read: (data, cursor) => {
      const skippedThrough = parseWorkspaceControlCursor(data);
      // Events this reader may not see (other people's private chats).
      if (skippedThrough !== null) return { cursor: Math.max(cursor, skippedThrough) };
      const event = parseWorkspaceControlEvent(data);
      return event && event.sequence > cursor ? { cursor: event.sequence, event } : null;
    },
  });
}

/**
 * Cursor-only frame: the server read through `sequence` but the events after
 * the last delivered one are not visible to this reader.
 */
export function parseWorkspaceControlCursor(data: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { type?: unknown }).type !== "workspace.control.cursor"
  )
    return null;
  const sequence = (value as { sequence?: unknown }).sequence;
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0
    ? sequence
    : null;
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
