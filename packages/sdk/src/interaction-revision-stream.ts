import type { WorkspaceInteractionRevisionEvent } from "./interaction";
import { reconnectingCursorStream, type StreamSessionEventsOptions } from "./stream";
import { isRecord } from "@opengeni/contracts/values";

export type WorkspaceInteractionRevisionStreamTransport = {
  openStream: (
    after: number,
    signal: AbortSignal | undefined,
  ) => Promise<ReadableStream<Uint8Array>>;
};

/**
 * Reconnecting latest-revision stream. Revisions may skip because intermediate
 * invalidations carry no independent evidence; every delivered value means
 * "refetch any interaction resources older than this cursor".
 */
export async function* streamWorkspaceInteractionRevisions(
  transport: WorkspaceInteractionRevisionStreamTransport,
  options: StreamSessionEventsOptions = {},
): AsyncGenerator<WorkspaceInteractionRevisionEvent, void, void> {
  yield* reconnectingCursorStream({
    label: "workspace interaction stream",
    options,
    cursor: options.after ?? 0,
    open: (cursor, signal) => transport.openStream(cursor, signal),
    read: (data, cursor) => {
      const event = parseWorkspaceInteractionRevision(data);
      return event && event.sequence > cursor ? { cursor: event.sequence, event } : null;
    },
  });
}

function parseWorkspaceInteractionRevision(data: string): WorkspaceInteractionRevisionEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.type !== "workspace.interaction.changed" ||
    typeof value.workspaceId !== "string" ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    value.revision !== value.sequence ||
    typeof value.occurredAt !== "string"
  ) {
    return null;
  }
  return value as WorkspaceInteractionRevisionEvent;
}
