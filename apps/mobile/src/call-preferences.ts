import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";

/**
 * Where a call started outside the app goes (Phone recents, Siri, the
 * home-screen action, a Shortcut): a fresh session, or the most recent one.
 * Calls started inside a session always talk to that session.
 */
export type OutsideCallTarget = "new" | "latest";

const KEY = "opengeni.outside-call-target";
const listeners = new Set<(value: OutsideCallTarget) => void>();
let current: OutsideCallTarget = "new";

export async function restoreOutsideCallTarget(): Promise<void> {
  const saved = await AsyncStorage.getItem(KEY).catch(() => null);
  if (saved === "new" || saved === "latest") {
    current = saved;
    for (const listener of listeners) listener(saved);
  }
}

export function getOutsideCallTarget(): OutsideCallTarget {
  return current;
}

export function setOutsideCallTarget(value: OutsideCallTarget): void {
  current = value;
  void AsyncStorage.setItem(KEY, value).catch(() => undefined);
  for (const listener of listeners) listener(value);
}

export function useOutsideCallTarget(): OutsideCallTarget {
  const [value, setValue] = useState(current);
  useEffect(() => {
    listeners.add(setValue);
    setValue(current);
    return () => {
      listeners.delete(setValue);
    };
  }, []);
  return value;
}
