import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

/**
 * Where a call started outside the app goes (Phone recents, Siri, the
 * home-screen action, a Shortcut): the session you last had open (like
 * calling back the person you were talking to), a fresh session, or a session
 * you chose from its menu. Calls started inside a session always talk to that
 * session.
 */
export type OutsideCallTarget = "new" | "latest" | "pinned";

/** The session chosen to take outside calls. */
export type PinnedCallSession = { workspaceId: string; sessionId: string; title: string };

/** The session you last had open, per workspace. */
export type OpenedSession = { workspaceId: string; sessionId: string };

const KEY = "opengeni.outside-call-target";
const PINNED_KEY = "opengeni.outside-call-pinned";
const LAST_OPENED_KEY = "opengeni.last-opened-session";
type Preferences = { target: OutsideCallTarget; pinned: PinnedCallSession | null };
const listeners = new Set<(value: Preferences) => void>();
let current: OutsideCallTarget = "latest";
let pinned: PinnedCallSession | null = null;
let lastOpened: Record<string, string> = {};

function notify(): void {
  const value = { target: current, pinned };
  for (const listener of listeners) listener(value);
}

function parsePinned(raw: string | null): PinnedCallSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PinnedCallSession>;
    return typeof value.workspaceId === "string" && typeof value.sessionId === "string"
      ? {
          workspaceId: value.workspaceId,
          sessionId: value.sessionId,
          title: typeof value.title === "string" ? value.title : "",
        }
      : null;
  } catch {
    return null;
  }
}

export async function restoreOutsideCallTarget(): Promise<void> {
  const [saved, savedPinned, savedLastOpened] = await Promise.all([
    AsyncStorage.getItem(KEY).catch(() => null),
    AsyncStorage.getItem(PINNED_KEY).catch(() => null),
    AsyncStorage.getItem(LAST_OPENED_KEY).catch(() => null),
  ]);
  pinned = parsePinned(savedPinned);
  lastOpened = parseLastOpened(savedLastOpened);
  if (saved === "new" || saved === "latest" || (saved === "pinned" && pinned)) current = saved;
  notify();
}

function parseLastOpened(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** Remember the session on screen, so a call from outside the app can return to it. */
export function rememberOpenedSession(session: OpenedSession): void {
  if (lastOpened[session.workspaceId] === session.sessionId) return;
  lastOpened = { ...lastOpened, [session.workspaceId]: session.sessionId };
  void AsyncStorage.setItem(LAST_OPENED_KEY, JSON.stringify(lastOpened)).catch(() => undefined);
}

export function getLastOpenedSessionId(workspaceId: string): string | null {
  return lastOpened[workspaceId] ?? null;
}

/** Forget a remembered session that no longer exists. */
export function forgetOpenedSession(session: OpenedSession): void {
  if (lastOpened[session.workspaceId] !== session.sessionId) return;
  const { [session.workspaceId]: _removed, ...rest } = lastOpened;
  lastOpened = rest;
  void AsyncStorage.setItem(LAST_OPENED_KEY, JSON.stringify(lastOpened)).catch(() => undefined);
}

export function getOutsideCallTarget(): OutsideCallTarget {
  return current;
}

export function getPinnedCallSession(): PinnedCallSession | null {
  return pinned;
}

export function setOutsideCallTarget(value: OutsideCallTarget): void {
  if (value === "pinned" && !pinned) return;
  current = value;
  void AsyncStorage.setItem(KEY, value).catch(() => undefined);
  notify();
}

/** Outside calls go to this session from now on. */
export function pinCallSession(session: PinnedCallSession): void {
  pinned = session;
  void AsyncStorage.setItem(PINNED_KEY, JSON.stringify(session)).catch(() => undefined);
  setOutsideCallTarget("pinned");
}

/** Forget the chosen session; outside calls return to your last session again. */
export function unpinCallSession(): void {
  pinned = null;
  void AsyncStorage.removeItem(PINNED_KEY).catch(() => undefined);
  if (current === "pinned") setOutsideCallTarget("latest");
  else notify();
}

export function useOutsideCallPreferences(): Preferences {
  const [value, setValue] = useState<Preferences>({ target: current, pinned });
  useEffect(() => {
    listeners.add(setValue);
    setValue({ target: current, pinned });
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
