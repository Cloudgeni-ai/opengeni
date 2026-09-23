import {
  createContext,
  useCallback,
  useMemo,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

export type Appearance = "light" | "dark" | "system";
export const APPEARANCE_KEY = "opengeni.appearance";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export function parseAppearance(value: string | null): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

function readAppearance(): Appearance {
  try {
    return parseAppearance(window.localStorage.getItem(APPEARANCE_KEY));
  } catch {
    return "system";
  }
}

const AppearanceContext = createContext<{
  appearance: Appearance;
  resolvedTheme: "light" | "dark";
  setAppearance: (value: Appearance) => void;
}>({ appearance: "system", resolvedTheme: "dark", setAppearance: () => {} });

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, updateAppearance] = useState(readAppearance);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia(SYSTEM_DARK_QUERY).matches);
  const resolvedTheme = appearance === "system" ? (systemDark ? "dark" : "light") : appearance;

  useEffect(() => {
    const media = window.matchMedia(SYSTEM_DARK_QUERY);
    const onChange = () => setSystemDark(media.matches);
    const onStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_KEY || event.key === null) updateAppearance(readAppearance());
    };
    onChange();
    media.addEventListener("change", onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      media.removeEventListener("change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.ogTheme = resolvedTheme;
    document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
  }, [resolvedTheme]);

  const setAppearance = useCallback((value: Appearance) => {
    updateAppearance(value);
    try {
      window.localStorage.setItem(APPEARANCE_KEY, value);
    } catch {
      // A blocked storage area must not prevent changing this tab's appearance.
    }
  }, []);

  const value = useMemo(
    () => ({ appearance, resolvedTheme, setAppearance }),
    [appearance, resolvedTheme, setAppearance],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  return useContext(AppearanceContext);
}
