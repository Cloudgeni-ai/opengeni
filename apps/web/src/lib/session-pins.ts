// Cross-tab invalidation for personal session pins. Postgres remains truth;
// this message carries only workspace/session ids and tells sibling tabs to
// re-read. Cross-device clients reconcile through the normal page refresh/poll.

import type { Session } from "@/types";

const SESSION_PIN_CHANNEL_PREFIX = "opengeni.session-pins";

function channelName(workspaceId: string): string {
  return `${SESSION_PIN_CHANNEL_PREFIX}:${workspaceId}`;
}

/**
 * Merge only personal pin fields from a list/page projection into the open
 * route projection. Lifecycle and event-driven session fields remain owned by
 * the route/SSE reducer and cannot be regressed by a slower list poll.
 */
export function applySessionPinProjection(
  current: Session | null,
  projected: Pick<Session, "id" | "workspaceId" | "pinned" | "pinnedAt" | "pinVersion">,
): Session | null {
  if (!current || current.id !== projected.id || current.workspaceId !== projected.workspaceId) {
    return current;
  }
  const pinned = Boolean(projected.pinned);
  const pinnedAt = projected.pinnedAt ?? null;
  const pinVersion = projected.pinVersion ?? 0;
  // A page poll, mutation response, or legacy-replica response can finish
  // after a newer optimistic/authoritative projection is already visible.
  // Pin revisions are monotonic, so never let that older response undo the
  // newer header/list state. Equal revisions remain authoritative: they let a
  // server response replace the local optimistic timestamp for that revision.
  if (pinVersion < (current.pinVersion ?? 0)) {
    return current;
  }
  if (
    Boolean(current.pinned) === pinned &&
    (current.pinnedAt ?? null) === pinnedAt &&
    (current.pinVersion ?? 0) === pinVersion
  ) {
    return current;
  }
  return { ...current, pinned, pinnedAt, pinVersion };
}

/**
 * Reconcile the point read performed after a failed pin request.
 *
 * An optimistic first pin projects version 1 before the server responds. If the
 * request fails before commit, the authoritative point read correctly returns
 * the absent relation at version 0. The normal monotonic merge must reject an
 * arbitrary lower revision, but doing so here would leave the exact optimistic
 * projection stuck forever. Allow the lower authoritative revision only while
 * the current state is still byte-for-byte the projection installed by this
 * operation. Any intervening poll, mutation, or device response wins instead.
 */
export function reconcileFailedSessionPin(
  current: Session | null,
  optimistic: Pick<Session, "id" | "workspaceId" | "pinned" | "pinnedAt" | "pinVersion"> | null,
  authoritative: Pick<Session, "id" | "workspaceId" | "pinned" | "pinnedAt" | "pinVersion">,
): Session | null {
  if (
    !current ||
    !optimistic ||
    current.id !== optimistic.id ||
    current.workspaceId !== optimistic.workspaceId ||
    authoritative.id !== optimistic.id ||
    authoritative.workspaceId !== optimistic.workspaceId
  ) {
    return applySessionPinProjection(current, authoritative);
  }
  const stillExactOptimistic =
    Boolean(current.pinned) === Boolean(optimistic.pinned) &&
    (current.pinnedAt ?? null) === (optimistic.pinnedAt ?? null) &&
    (current.pinVersion ?? 0) === (optimistic.pinVersion ?? 0);
  if (!stillExactOptimistic) {
    return applySessionPinProjection(current, authoritative);
  }
  return {
    ...current,
    pinned: Boolean(authoritative.pinned),
    pinnedAt: authoritative.pinnedAt ?? null,
    pinVersion: authoritative.pinVersion ?? 0,
  };
}

export function notifySessionPinChanged(workspaceId: string, sessionId: string): void {
  if (typeof BroadcastChannel === "undefined") {
    return;
  }
  const channel = new BroadcastChannel(channelName(workspaceId));
  channel.postMessage({ type: "session-pin.changed", sessionId });
  channel.close();
}

export function subscribeToSessionPinChanges(
  workspaceId: string,
  onChange: (sessionId: string) => void,
): () => void {
  if (typeof BroadcastChannel === "undefined") {
    return () => undefined;
  }
  const channel = new BroadcastChannel(channelName(workspaceId));
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    const message = event.data as { type?: unknown; sessionId?: unknown } | null;
    if (message?.type === "session-pin.changed" && typeof message.sessionId === "string") {
      onChange(message.sessionId);
    }
  });
  return () => channel.close();
}
