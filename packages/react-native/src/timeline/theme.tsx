import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TextStyle } from "react-native";
import { webColorsDark, webColorsLight, webLengths } from "../ui/web-tokens.generated";

/* ----------------------------------------------------------------------------
   Native timeline theme

   The web design tokens (generated from the web stylesheet) drive every color,
   size and radius, so the native timeline matches the web app at phone width.
   Hosts override tokens (brand colors, fonts) without forking components.
   -------------------------------------------------------------------------- */

export type WebColorToken = keyof typeof webColorsLight;
export type NativeTimelineColors = Record<WebColorToken, string>;

export interface NativeTimelineFonts {
  /** Font family per weight for the sans face; undefined → platform system font. */
  sans?: Partial<Record<"400" | "500" | "600" | "700", string>> | undefined;
  /** Font family per weight for the mono face; undefined → platform monospace. */
  mono?: Partial<Record<"400" | "500", string>> | undefined;
  /** Regular-weight italic family (custom fonts cannot be synthesized italic on iOS). */
  sansItalic?: string | undefined;
  /** Extra sans letter spacing (pt) to match the web face's metrics. */
  sansTracking?: number | undefined;
}

export interface NativeTimelineTheme {
  scheme: "light" | "dark";
  colors: NativeTimelineColors;
  size: {
    xs: number;
    sm: number;
    base: number;
    md: number;
    composer: number;
  };
  radius: { xs: number; sm: number; md: number; lg: number; xl: number; full: number };
  fonts: NativeTimelineFonts;
}

export interface NativeTimelineThemeOverrides {
  light?: Partial<NativeTimelineColors> | undefined;
  dark?: Partial<NativeTimelineColors> | undefined;
  fonts?: NativeTimelineFonts | undefined;
}

export function createNativeTimelineTheme(
  scheme: "light" | "dark",
  overrides: NativeTimelineThemeOverrides = {},
): NativeTimelineTheme {
  const base = scheme === "dark" ? webColorsDark : webColorsLight;
  return {
    scheme,
    colors: { ...base, ...(scheme === "dark" ? overrides.dark : overrides.light) },
    size: {
      xs: webLengths["font-size-xs"],
      sm: webLengths["font-size-sm"],
      base: webLengths["font-size-base"],
      md: webLengths["font-size-md"],
      composer: webLengths["font-size-composer"],
    },
    radius: {
      xs: webLengths["radius-xs"],
      sm: webLengths["radius-sm"],
      md: webLengths["radius-md"],
      lg: webLengths["radius-lg"],
      xl: webLengths["radius-xl"],
      full: webLengths["radius-full"],
    },
    fonts: overrides.fonts ?? {},
  };
}

const ThemeContext = createContext<NativeTimelineTheme>(createNativeTimelineTheme("light"));

export function NativeTimelineThemeProvider({
  scheme,
  overrides,
  children,
}: {
  scheme: "light" | "dark";
  overrides?: NativeTimelineThemeOverrides | undefined;
  children: ReactNode;
}) {
  const theme = useMemo(() => createNativeTimelineTheme(scheme, overrides), [scheme, overrides]);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useNativeTimelineTheme(): NativeTimelineTheme {
  return useContext(ThemeContext);
}

/** Text style for a web weight, resolving host font families when supplied. */
export function fontStyle(
  theme: NativeTimelineTheme,
  weight: 400 | 500 | 600 | 700 = 400,
  face: "sans" | "mono" = "sans",
): TextStyle {
  if (face === "mono") {
    const family = theme.fonts.mono?.[weight >= 500 ? "500" : "400"] ?? theme.fonts.mono?.["400"];
    return family ? { fontFamily: family } : { fontFamily: MONO_FALLBACK, fontWeight: `${weight}` };
  }
  const key = `${weight}` as "400" | "500" | "600" | "700";
  const family = theme.fonts.sans?.[key];
  const tracking = theme.fonts.sansTracking ? { letterSpacing: theme.fonts.sansTracking } : {};
  return family ? { fontFamily: family, ...tracking } : { fontWeight: key, ...tracking };
}

const MONO_FALLBACK = "Menlo";

export { MONO_FALLBACK };
