import type { WorkspaceInteractionRevisionEvent } from "./interaction";
import { reconnectingCursorStream, type StreamSessionEventsOptions } from "./stream";
import type { WorkspaceControlEvent } from "./types";
import { parseWorkspaceControlCursor } from "./workspace-control-stream";
import { isRecord } from "@opengeni/contracts/values";

/** Transient hints have no replay cursor; every reconnection reconciles lists. */
export type WorkspaceSessionListEvent = {
  type: "workspace.sessions.changed";
  workspaceId: string;
  available: boolean;
  sessionIds: string[] | null;
  /**
   * Changed Site conversations visible to this viewer. Ordinary lists omit
   * them; only a surface that shows Site conversations needs these. A hint
   * whose `sessionIds` is empty and that carries only these changes nothing
   * for ordinary lists.
   */
  siteSessionIds?: string[];
};

export type WorkspaceLiveEvent =
  | WorkspaceControlEvent
  | WorkspaceInteractionRevisionEvent
  | WorkspaceSessionListEvent;

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
  yield* reconnectingCursorStream<{ control: number; interaction: number }, WorkspaceLiveEvent>({
    label: "workspace live stream",
    options,
    cursor: { control: options.controlAfter ?? 0, interaction: options.interactionAfter ?? 0 },
    sameCursor: (a, b) => a.control === b.control && a.interaction === b.interaction,
    open: (cursor, signal) => transport.openStream(cursor.control, cursor.interaction, signal),
    read: (data, cursor) => {
      const skippedThrough = parseWorkspaceControlCursor(data);
      if (skippedThrough !== null) {
        return { cursor: { ...cursor, control: Math.max(cursor.control, skippedThrough) } };
      }
      const event = parseWorkspaceLiveEvent(data);
      if (!event) return null;
      if (event.type === "workspace.control.changed") {
        if (event.sequence <= cursor.control) return null;
        return { cursor: { ...cursor, control: event.sequence }, event };
      }
      if (event.type === "workspace.interaction.changed") {
        if (event.sequence <= cursor.interaction) return null;
        return { cursor: { ...cursor, interaction: event.sequence }, event };
      }
      return { cursor, event };
    },
  });
}

export function parseWorkspaceLiveEvent(data: string): WorkspaceLiveEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (
    value.type === "workspace.sessions.changed" &&
    typeof value.workspaceId === "string" &&
    typeof value.available === "boolean" &&
    (value.sessionIds === null ||
      (Array.isArray(value.sessionIds) && value.sessionIds.every((id) => typeof id === "string")))
  ) {
    const { siteSessionIds, ...hint } = value as WorkspaceSessionListEvent;
    // An unexpected extension is dropped rather than failing the whole hint.
    return Array.isArray(siteSessionIds) && siteSessionIds.every((id) => typeof id === "string")
      ? { ...hint, siteSessionIds }
      : hint;
  }
  if (typeof value.sequence !== "number") return null;
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
