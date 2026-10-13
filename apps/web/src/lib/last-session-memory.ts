import { useEffect } from "react";

import { isApiErrorStatus } from "@/api";

/**
 * The session a person last had open in a workspace, so "Back to sessions"
 * from Settings reopens it instead of a blank new session. Unsent text comes
 * back with it because session drafts are already saved per session.
 *
 * Tab-scoped navigation state, like the rail's group windows: sessionStorage,
 * one entry per person and workspace, so another tab keeps its own place.
 * Opening the new-session page forgets it, so Back returns to whichever of the
 * two was open last. It is only a hint: the session route forgets a session
 * that is gone, and a restored link that lands on one returns to sessions.
 */
const MEMORY_VERSION = 1;
const MAX_SESSION_ID_LENGTH = 256;

type LastSessionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

declare module "@tanstack/react-router" {
  interface HistoryState {
    /** Set only on the Settings "Back to sessions" link that reopens this session. */
    restoredSessionId?: string;
  }
}

export function lastSessionMemoryId(subjectId: string, workspaceId: string): string {
  return [
    "og.session.last",
    `v${MEMORY_VERSION}`,
    encodeURIComponent(subjectId),
    encodeURIComponent(workspaceId),
  ].join(":");
}

export function readLastSessionId(
  memoryId: string,
  storage: LastSessionStorage | null = browserSessionStorage(),
): string | null {
  if (!storage) return null;
  try {
    return boundedSessionId(storage.getItem(memoryId));
  } catch {
    return null;
  }
}

export function rememberLastSessionId(
  memoryId: string,
  sessionId: string,
  storage: LastSessionStorage | null = browserSessionStorage(),
): void {
  if (!storage || !boundedSessionId(sessionId)) return;
  try {
    if (storage.getItem(memoryId) !== sessionId) storage.setItem(memoryId, sessionId);
  } catch {
    // Quota or privacy mode: Back opens a new session, as before.
  }
}

/** Forget the remembered session; with `sessionId`, only while it is still that one. */
export function forgetLastSessionId(
  memoryId: string,
  sessionId?: string,
  storage: LastSessionStorage | null = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    if (sessionId === undefined || storage.getItem(memoryId) === sessionId) {
      storage.removeItem(memoryId);
    }
  } catch {
    // Unreadable memory is only a lost convenience.
  }
}

/** The new-session page is now the open view: Back from Settings returns to it. */
export function useForgetLastSession(subjectId: string, workspaceId: string): void {
  useEffect(() => {
    forgetLastSessionId(lastSessionMemoryId(subjectId, workspaceId));
  }, [subjectId, workspaceId]);
}

/**
 * Remembers the session route's session once it opens and forgets it once it
 * is gone (not found or no longer accessible), so Back can't lead there again.
 * When the Back link itself brought the person to a gone session, calls
 * `leave` (open a new session instead of a not-found page) and returns true
 * so the route can skip that page. Transient load failures change nothing.
 */
export function useSessionRouteMemory(input: {
  subjectId: string;
  workspaceId: string;
  sessionId: string;
  openedSessionId: string | null;
  loadError: unknown;
  restoredSessionId: string | undefined;
  leave: () => void;
}): boolean {
  const { subjectId, workspaceId, sessionId, openedSessionId, loadError, leave } = input;
  const opened = openedSessionId === sessionId;
  const unavailable =
    !opened && (isApiErrorStatus(loadError, 404) || isApiErrorStatus(loadError, 403));
  const leaving = unavailable && input.restoredSessionId === sessionId;
  useEffect(() => {
    const memoryId = lastSessionMemoryId(subjectId, workspaceId);
    if (opened) rememberLastSessionId(memoryId, sessionId);
    else if (unavailable) forgetLastSessionId(memoryId, sessionId);
  }, [opened, sessionId, subjectId, unavailable, workspaceId]);
  useEffect(() => {
    if (leaving) leave();
  }, [leave, leaving]);
  return leaving;
}

function boundedSessionId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH
    ? value
    : null;
}

function browserSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
