import type { GetSessionOptions } from "@opengeni/sdk/core";
import type { Session } from "@/types";

type SessionChannelPointReadClient = {
  getSession: (
    workspaceId: string,
    sessionId: string,
    options?: GetSessionOptions,
  ) => Promise<Session>;
};

export type SessionChannelMoveOverride = Readonly<{
  channelId: string | null;
  operation: number;
  committed: boolean;
}>;

export type SessionChannelMoveOverrides = ReadonlyMap<string, SessionChannelMoveOverride>;

/** Await a detail-read generation whose network request starts after this call. */
export function readSessionChannelMovePoint(
  client: SessionChannelPointReadClient,
  workspaceId: string,
  sessionId: string,
  onRequestStart?: () => void,
): Promise<Session> {
  return client.getSession(workspaceId, sessionId, {
    fresh: true,
    ...(onRequestStart ? { onRequestStart } : {}),
  });
}

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

/**
 * Reconcile a committed optimistic move with an exact point read started after
 * the write. Matching state proves the list row is stale and keeps the overlay;
 * a different channel supersedes it immediately, while a missing session
 * retires the otherwise-unconfirmable override.
 */
export function reconcileSessionChannelMovePointRead(
  current: SessionChannelMoveOverrides,
  sessionId: string,
  operation: number,
  authoritative: Session | null,
): SessionChannelMoveOverrides {
  const override = current.get(sessionId);
  if (!override || override.operation !== operation || !override.committed) return current;
  if (!authoritative) {
    const next = new Map(current);
    next.delete(sessionId);
    return next;
  }
  const channelId = authoritative.channelId ?? null;
  if (channelId === override.channelId) return current;
  return new Map(current).set(sessionId, { ...override, channelId });
}
