import type { Session } from "@/types";

export type ActiveSessionReadCandidate = Pick<
  Session,
  "id" | "workspaceId" | "unread" | "archived"
>;

export type SessionAttentionProjection = Pick<
  Session,
  "id" | "workspaceId" | "unread" | "attentionVersion" | "lastSequence"
>;

export type LocalSessionDeliveryAttention = {
  workspaceId: string;
  sessionId: string;
  failedMessageCount: number;
};

// RailShell renders exactly one desktop-or-mobile SessionList at a time.
let listener: ((projection: SessionAttentionProjection) => void) | null = null;
const localDeliveryAttention = new Map<string, LocalSessionDeliveryAttention>();
const localDeliveryListeners = new Set<() => void>();

function localDeliveryKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\u0000${sessionId}`;
}

/**
 * Project browser-local delivery failure truth into the rail without mutating
 * the durable session lifecycle or unread state. A retry, removal, or durable
 * acceptance clears the projection when the composer no longer owns a failed
 * optimistic message.
 */
export function updateLocalSessionDeliveryAttention(
  projection: LocalSessionDeliveryAttention,
): void {
  const key = localDeliveryKey(projection.workspaceId, projection.sessionId);
  const current = localDeliveryAttention.get(key);
  if (projection.failedMessageCount <= 0) {
    if (!current) return;
    localDeliveryAttention.delete(key);
  } else {
    if (current?.failedMessageCount === projection.failedMessageCount) return;
    localDeliveryAttention.set(key, projection);
  }
  for (const notify of localDeliveryListeners) notify();
}

export function localSessionDeliveryAttentionIds(workspaceId: string): ReadonlySet<string> {
  return new Set(
    [...localDeliveryAttention.values()]
      .filter((projection) => projection.workspaceId === workspaceId)
      .map((projection) => projection.sessionId),
  );
}

export function subscribeToLocalSessionDeliveryAttention(onChange: () => void): () => void {
  localDeliveryListeners.add(onChange);
  return () => localDeliveryListeners.delete(onChange);
}

function isOlder(
  current: Pick<SessionAttentionProjection, "attentionVersion" | "lastSequence">,
  projected: SessionAttentionProjection,
): boolean {
  return (
    projected.attentionVersion! < current.attentionVersion! ||
    projected.lastSequence < current.lastSequence
  );
}

/** One foreground-view receipt per exact session event frontier. */
export function sessionReadProjectionKey(sessionId: string, latestEventSequence: number): string {
  return `${sessionId}:${latestEventSequence}`;
}

/**
 * A chat is read only while the exact route is genuinely in the foreground.
 * Merely leaving a session route mounted in a background tab/window must not
 * consume its unread signal.
 */
export function shouldAcknowledgeActiveSession(input: {
  activeSessionId: string | null;
  workspaceId: string;
  session: ActiveSessionReadCandidate | null;
  documentVisible: boolean;
  windowFocused: boolean;
  liveTipLoaded: boolean;
}): boolean {
  const { session } = input;
  return Boolean(
    input.liveTipLoaded &&
    input.documentVisible &&
    input.windowFocused &&
    session &&
    !session.archived &&
    session.unread &&
    session.workspaceId === input.workspaceId &&
    session.id === input.activeSessionId,
  );
}

/**
 * Apply a same-tab attention result without allowing an older list poll to
 * resurrect a read marker. Attention revisions order explicit mutations,
 * while lastSequence orders new durable activity; either older coordinate is
 * stale. Equal coordinates let the latest mutation response replace the page
 * projection immediately. The rail calls this only after an id-keyed lookup,
 * so both arguments represent the same session.
 */
export function applySessionAttentionProjection(
  current: Session,
  projected: SessionAttentionProjection,
): Session {
  const currentVersion = current.attentionVersion!;
  const projectedVersion = projected.attentionVersion!;
  if (
    isOlder(current, projected) ||
    (current.unread === projected.unread && currentVersion === projectedVersion)
  ) {
    return current;
  }
  return { ...current, unread: projected.unread, attentionVersion: projectedVersion };
}

export function latestSessionAttentionProjection(
  current: SessionAttentionProjection | undefined,
  projected: SessionAttentionProjection,
): SessionAttentionProjection {
  return current && isOlder(current, projected) ? current : projected;
}

export function notifySessionAttentionChanged(projection: SessionAttentionProjection): void {
  listener?.(projection);
}

export function subscribeToSessionAttentionChanges(
  onChange: (projection: SessionAttentionProjection) => void,
): () => void {
  listener = onChange;
  return () => {
    if (listener === onChange) listener = null;
  };
}
