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

export function localSessionDeliveryAttentionCounts(
  workspaceId: string,
): ReadonlyMap<string, number> {
  return new Map(
    [...localDeliveryAttention.values()]
      .filter((projection) => projection.workspaceId === workspaceId)
      .map((projection) => [projection.sessionId, projection.failedMessageCount]),
  );
}

export function subscribeToLocalSessionDeliveryAttention(onChange: () => void): () => void {
  localDeliveryListeners.add(onChange);
  return () => localDeliveryListeners.delete(onChange);
}

function isOlder(
  current: Pick<SessionAttentionProjection, "unread" | "attentionVersion" | "lastSequence">,
  projected: SessionAttentionProjection,
): boolean {
  return (
    projected.attentionVersion! < current.attentionVersion! ||
    projected.lastSequence < current.lastSequence ||
    (projected.attentionVersion === current.attentionVersion &&
      projected.lastSequence === current.lastSequence &&
      !current.unread &&
      Boolean(projected.unread))
  );
}

/** One foreground-view receipt per exact session event frontier. */
export function sessionReadProjectionKey(sessionId: string, latestEventSequence: number): string {
  return `${sessionId}:${latestEventSequence}`;
}

type ActiveSessionReadEligibility = {
  activeSessionId: string | null;
  workspaceId: string;
  session: ActiveSessionReadCandidate | null;
  documentVisible: boolean;
  windowFocused: boolean;
};

/**
 * An unread chat clears as soon as its exact route is the foreground
 * destination. The durable writer receives the exact known frontier and can
 * advance again when later events render.
 */
export function shouldProjectActiveSessionRead(input: ActiveSessionReadEligibility): boolean {
  const { session } = input;
  return Boolean(
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
 * A chat is read only while the exact route is genuinely in the foreground.
 * Merely leaving a session route mounted in a background tab/window must not
 * consume its unread signal.
 */
export function shouldAcknowledgeActiveSession(input: ActiveSessionReadEligibility): boolean {
  return shouldProjectActiveSessionRead(input);
}

/**
 * Apply a same-tab attention result without allowing an older list poll to
 * resurrect a read marker. Attention revisions order explicit mutations,
 * while lastSequence orders new durable activity; either older coordinate is
 * stale. Equal coordinates let the latest mutation response replace the page
 * projection immediately. At an equal coordinate, read wins over unread: a
 * cleanup or stale render cannot resurrect a dot after the user viewed it.
 * Explicit mark-unread actions still win because they increment
 * `attentionVersion`. The rail calls this only after an id-keyed lookup, so
 * both arguments represent the same session.
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

/**
 * Apply personal attention projections to rows and their loaded ancestor
 * aggregates in one pass. Server `treeStats` count every descendant, so a
 * foreground child read must adjust each loaded ancestor immediately instead
 * of leaving a stale blue or red parent marker until the next list poll.
 */
export function applySessionAttentionProjections(
  sessions: readonly Session[],
  projections: ReadonlyMap<string, SessionAttentionProjection>,
): Session[] {
  const sourceById = new Map(sessions.map((session) => [session.id, session]));
  const projectedById = new Map(sourceById);

  for (const [sessionId, projection] of projections) {
    const source = sourceById.get(sessionId);
    if (!source) continue;
    // A descendant projection may already have adjusted this session's
    // treeStats. Apply its own attention state to that accumulated row so map
    // iteration order cannot wipe an earlier descendant delta.
    const projected = applySessionAttentionProjection(projectedById.get(sessionId)!, projection);
    projectedById.set(sessionId, projected);

    const unreadDelta = Number(projected.unread) - Number(source.unread);
    if (unreadDelta === 0) continue;
    const failedDelta = source.status === "failed" ? unreadDelta : 0;
    const visited = new Set<string>([sessionId]);
    let parentSessionId = source.parentSessionId;
    while (parentSessionId && !visited.has(parentSessionId)) {
      visited.add(parentSessionId);
      const ancestorSource = sourceById.get(parentSessionId);
      const ancestor = projectedById.get(parentSessionId);
      if (!ancestorSource || !ancestor) break;
      const stats = ancestor.treeStats;
      if (stats) {
        const unreadDescendants = Math.max(0, (stats.unreadDescendants ?? 0) + unreadDelta);
        const unreadFailedDescendants = Math.max(
          0,
          (stats.unreadFailedDescendants ?? stats.failedDescendants) + failedDelta,
        );
        projectedById.set(parentSessionId, {
          ...ancestor,
          treeStats: {
            ...stats,
            unreadDescendants,
            unreadFailedDescendants,
          },
        });
      }
      parentSessionId = ancestorSource.parentSessionId;
    }
  }

  return sessions.map((session) => projectedById.get(session.id) ?? session);
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
