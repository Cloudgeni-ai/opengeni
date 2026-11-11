import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import { Appearance } from "react-native";

/** The web app's appearance menu: follow the system, or always light or dark. */
export type AppearancePreference = "system" | "light" | "dark";

const KEY = "opengeni.appearance";
const listeners = new Set<(value: AppearancePreference) => void>();
let current: AppearancePreference = "system";

function apply(value: AppearancePreference) {
  // Overrides the whole app, so native headers, menus and sheets follow too.
  Appearance.setColorScheme(value === "system" ? "unspecified" : value);
}

/** Read the saved choice once at launch, before the first screen settles. */
export async function restoreAppearance(): Promise<void> {
  const saved = await AsyncStorage.getItem(KEY).catch(() => null);
  if (saved === "light" || saved === "dark") {
    current = saved;
    apply(saved);
    for (const listener of listeners) listener(saved);
  }
}

export function setAppearance(value: AppearancePreference): void {
  current = value;
  apply(value);
  void AsyncStorage.setItem(KEY, value).catch(() => undefined);
  for (const listener of listeners) listener(value);
}

export function useAppearancePreference(): AppearancePreference {
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
