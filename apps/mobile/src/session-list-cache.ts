import type { Channel, Session } from "@opengeni/sdk";
import type { PinnedSessionLists } from "@opengeni/react/session-list-model";

/**
 * The last session lists a workspace showed, kept for the app's lifetime so
 * returning to home or the sessions list paints immediately while a quiet
 * refresh runs, instead of an empty screen and a spinner.
 *
 * A chat that is open (or was just started) writes its own fresh row here, and
 * the lists below it follow at once, so they are already in their new order
 * when the person comes back, rather than reordering under their finger when
 * the refresh lands.
 */
type Lists = {
  home?: PinnedSessionLists<Session>;
  sessions?: PinnedSessionLists<Session>;
  projects?: Channel[];
};
const lists = new Map<string, Lists>();
const listeners = new Map<string, Set<(next: Lists) => void>>();

export function cachedLists(workspaceId: string | null | undefined): Lists {
  return (workspaceId && lists.get(workspaceId)) || {};
}

export function rememberLists(workspaceId: string, patch: Lists): void {
  const next = { ...lists.get(workspaceId), ...patch };
  lists.set(workspaceId, next);
  for (const listener of [...(listeners.get(workspaceId) ?? [])]) listener(next);
}

/** Follow a workspace's cached lists as they change; returns the unsubscribe. */
export function subscribeLists(workspaceId: string, listener: (next: Lists) => void): () => void {
  const set = listeners.get(workspaceId) ?? new Set();
  set.add(listener);
  listeners.set(workspaceId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(workspaceId);
  };
}

/**
 * Put one session's latest row into a pinned list: replaced where it already
 * is, or added (as the newest top-level chat) when the list doesn't have it.
 * Order is the screens' to derive from the rows, as for a fresh page.
 */
export function withSessionRow(
  current: PinnedSessionLists<Session>,
  session: Session,
): PinnedSessionLists<Session> {
  const replace = (rows: Session[]) =>
    rows.map((row) => (row.id === session.id ? { ...row, ...session } : row));
  if (current.pinned.some((row) => row.id === session.id))
    return { ...current, pinned: replace(current.pinned) };
  if (current.sessions.some((row) => row.id === session.id))
    return { ...current, sessions: replace(current.sessions) };
  // Sub-agents live under their parent, not in these lists.
  if (session.parentSessionId) return current;
  return { ...current, sessions: [session, ...current.sessions] };
}

/** Write one session's latest row into every cached list of its workspace. */
export function rememberSessionRow(session: Session): void {
  const cached = lists.get(session.workspaceId);
  if (!cached?.home && !cached?.sessions) return;
  rememberLists(session.workspaceId, {
    ...(cached.home ? { home: withSessionRow(cached.home, session) } : {}),
    ...(cached.sessions ? { sessions: withSessionRow(cached.sessions, session) } : {}),
  });
}
