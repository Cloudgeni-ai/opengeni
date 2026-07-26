// Cross-tab invalidation for personal session pins. Postgres remains truth;
// this message carries only workspace/session ids and tells sibling tabs to
// re-read. Cross-device clients reconcile through the normal page refresh/poll.

import type { Session } from "@/types";

const SESSION_PIN_CHANNEL_PREFIX = "opengeni.session-pins";
const SESSION_PIN_STORAGE_PREFIX = "opengeni.session-pins.changed";
const outboundChannels = new Map<string, BroadcastChannel>();

type SessionPinChangeMessage = {
  type: "session-pin.changed";
  sessionId: string;
  messageId: string;
};

function channelName(workspaceId: string): string {
  return `${SESSION_PIN_CHANNEL_PREFIX}:${workspaceId}`;
}

function storageKey(workspaceId: string): string {
  return `${SESSION_PIN_STORAGE_PREFIX}:${workspaceId}`;
}

function newMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function sessionPinChangeMessage(value: unknown): SessionPinChangeMessage | null {
  const message = value as Partial<SessionPinChangeMessage> | null;
  return message?.type === "session-pin.changed" &&
    typeof message.sessionId === "string" &&
    message.sessionId.length > 0 &&
    typeof message.messageId === "string" &&
    message.messageId.length > 0
    ? (message as SessionPinChangeMessage)
    : null;
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
 * Merge list-owned personal pin and hierarchy fields into route-owned session
 * content. A route/SSE object must never overwrite a newer cross-device unpin,
 * while a list poll must never regress lifecycle state or message content.
 */
export function applySessionRailProjection(current: Session, projected: Session): Session {
  const merged = applySessionPinProjection(current, projected) ?? current;
  return projected.treeStats ? { ...merged, treeStats: projected.treeStats } : merged;
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
  const message: SessionPinChangeMessage = {
    type: "session-pin.changed",
    sessionId,
    messageId: newMessageId(),
  };
  if (typeof BroadcastChannel !== "undefined") {
    const name = channelName(workspaceId);
    try {
      let channel = outboundChannels.get(name);
      if (!channel) {
        // Closing immediately after postMessage is observably lossy in real
        // browsers. Keep one document-scoped outbound channel alive instead.
        channel = new BroadcastChannel(name);
        outboundChannels.set(name, channel);
      }
      channel.postMessage(message);
    } catch {
      // localStorage below remains the cross-document fallback.
    }
  }

  if (typeof window === "undefined") return;
  const key = storageKey(workspaceId);
  const serialized = JSON.stringify(message);
  try {
    window.localStorage.setItem(key, serialized);
    // Removing synchronously can race delivery in sibling tabs. Leave the
    // unique payload long enough to emit a storage event, then remove only the
    // value written by this notification.
    window.setTimeout(() => {
      try {
        if (window.localStorage.getItem(key) === serialized) {
          window.localStorage.removeItem(key);
        }
      } catch {
        // Storage may become unavailable after the page was backgrounded.
      }
    }, 1_000);
  } catch {
    // Private browsing and embedded contexts may deny localStorage entirely.
  }
}

export function subscribeToSessionPinChanges(
  workspaceId: string,
  onChange: (sessionId: string) => void,
): () => void {
  // BroadcastChannel and storage events can arrive in either order, and two
  // rapid mutations can interleave those transports. Remember a small bounded
  // window rather than only the immediately previous id so A, B, A still
  // invalidates exactly once per mutation without growing for the tab's life.
  const seenMessageIds = new Set<string>();
  const receive = (value: unknown): void => {
    const message = sessionPinChangeMessage(value);
    if (!message || seenMessageIds.has(message.messageId)) return;
    seenMessageIds.add(message.messageId);
    if (seenMessageIds.size > 64) {
      const oldest = seenMessageIds.values().next().value;
      if (oldest !== undefined) seenMessageIds.delete(oldest);
    }
    onChange(message.sessionId);
  };

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(channelName(workspaceId));
      channel.addEventListener("message", (event: MessageEvent<unknown>) => receive(event.data));
    } catch {
      channel = null;
    }
  }

  const key = storageKey(workspaceId);
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== key || !event.newValue) return;
    try {
      receive(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed or unrelated storage payloads.
    }
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    channel?.close();
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}
