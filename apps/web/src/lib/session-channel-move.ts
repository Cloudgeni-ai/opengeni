import type { Session } from "@/types";

export type SessionChannelMoveOverride = Readonly<{
  channelId: string | null;
  operation: number;
  committed: boolean;
}>;

export type SessionChannelMoveOverrides = ReadonlyMap<string, SessionChannelMoveOverride>;

/** Project one in-flight or committed move over a possibly stale list row. */
export function applySessionChannelMove(
  session: Session,
  override: SessionChannelMoveOverride | undefined,
): Session {
  if (!override || session.channelId === override.channelId) return session;
  return { ...session, channelId: override.channelId };
}

/** Install the destination before the network request starts. */
export function beginSessionChannelMove(
  current: SessionChannelMoveOverrides,
  sessionId: string,
  channelId: string | null,
  operation: number,
): SessionChannelMoveOverrides {
  return new Map(current).set(sessionId, { channelId, operation, committed: false });
}

/**
 * Preserve the successful write response over stale list requests that began
 * before the mutation committed. A superseded operation cannot replace a
 * newer projection.
 */
export function commitSessionChannelMove(
  current: SessionChannelMoveOverrides,
  sessionId: string,
  channelId: string | null,
  operation: number,
): SessionChannelMoveOverrides {
  if (current.get(sessionId)?.operation !== operation) return current;
  return new Map(current).set(sessionId, { channelId, operation, committed: true });
}

/** Roll back only the exact failed operation, never a newer move. */
export function rollbackSessionChannelMove(
  current: SessionChannelMoveOverrides,
  sessionId: string,
  operation: number,
): SessionChannelMoveOverrides {
  if (current.get(sessionId)?.operation !== operation) return current;
  const next = new Map(current);
  next.delete(sessionId);
  return next;
}

/**
 * Drop committed overlays only after a server list projection confirms the
 * destination. Pending moves and rows omitted by pagination stay projected.
 */
export function reconcileSessionChannelMoves(
  current: SessionChannelMoveOverrides,
  authoritativeSessions: readonly Session[],
): SessionChannelMoveOverrides {
  if (current.size === 0) return current;
  const authoritative = new Map(
    authoritativeSessions.map((session) => [session.id, session.channelId ?? null]),
  );
  let next: Map<string, SessionChannelMoveOverride> | null = null;
  for (const [sessionId, override] of current) {
    if (!override.committed || authoritative.get(sessionId) !== override.channelId) continue;
    next ??= new Map(current);
    next.delete(sessionId);
  }
  return next ?? current;
}
