import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

/**
 * Where a call started outside the app goes (Phone recents, Siri, the
 * home-screen action, a Shortcut): a fresh session, the most recent one, or a
 * session you chose from its menu. Calls started inside a session always talk
 * to that session.
 */
export type OutsideCallTarget = "new" | "latest" | "pinned";

/** The session chosen to take outside calls. */
export type PinnedCallSession = { workspaceId: string; sessionId: string; title: string };

const KEY = "opengeni.outside-call-target";
const PINNED_KEY = "opengeni.outside-call-pinned";
type Preferences = { target: OutsideCallTarget; pinned: PinnedCallSession | null };
const listeners = new Set<(value: Preferences) => void>();
let current: OutsideCallTarget = "new";
let pinned: PinnedCallSession | null = null;

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
  const [saved, savedPinned] = await Promise.all([
    AsyncStorage.getItem(KEY).catch(() => null),
    AsyncStorage.getItem(PINNED_KEY).catch(() => null),
  ]);
  pinned = parsePinned(savedPinned);
  if (saved === "new" || saved === "latest" || (saved === "pinned" && pinned)) current = saved;
  notify();
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

/** Forget the chosen session; outside calls go to a new session again. */
export function unpinCallSession(): void {
  pinned = null;
  void AsyncStorage.removeItem(PINNED_KEY).catch(() => undefined);
  if (current === "pinned") setOutsideCallTarget("new");
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
