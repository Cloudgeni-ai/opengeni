import type { CSSProperties } from "react";

/**
 * The restyle controls: what a product changes to make the embedded chat its
 * own. Every knob is an `--og-*` custom property on an ancestor of the
 * `@opengeni/react` components, the same thing an integration sets.
 */
export type Accent = { name: string; value: string };
export type Corners = { name: string; sm: number; md: number; lg: number };
export type ChatStyle = {
  accent: Accent;
  corners: Corners;
  theme: "light" | "dark";
};

export const ACCENTS: readonly Accent[] = [
  { name: "Teal", value: "#1f8f7a" },
  { name: "Indigo", value: "#5b4bff" },
  { name: "Peach", value: "#e07b3c" },
  { name: "Rose", value: "#cf3f73" },
  { name: "Graphite", value: "#3d4644" },
];
export const CORNERS: readonly Corners[] = [
  { name: "Sharp", sm: 2, md: 4, lg: 6 },
  { name: "Soft", sm: 6, md: 10, lg: 14 },
  { name: "Round", sm: 10, md: 18, lg: 24 },
];

export function defaultChatStyle(theme: "light" | "dark"): ChatStyle {
  return { accent: ACCENTS[0]!, corners: CORNERS[1]!, theme };
}

/**
 * The custom properties for one style. The snippet shows the base tokens;
 * the derived shades are set here too because the app's own stylesheet
 * computes them once, at the page root.
 */
export function chatTokens(style: ChatStyle): CSSProperties {
  const accent = style.accent.value;
  return {
    "--og-color-accent": accent,
    "--og-color-accent-strong": `color-mix(in oklch, ${accent} 82%, ${style.theme === "dark" ? "white" : "black"})`,
    "--og-color-accent-deep": `color-mix(in oklch, ${accent} 78%, black)`,
    "--og-color-accent-fg": "#ffffff",
    "--og-color-accent-soft": `color-mix(in oklch, ${accent} 14%, transparent)`,
    "--og-shadow-glow": `0 0 22px color-mix(in oklch, ${accent} 18%, transparent)`,
    "--og-color-primary": accent,
    "--og-color-primary-fg": "#ffffff",
    "--og-color-primary-border": accent,
    "--og-color-primary-hover": `color-mix(in oklch, ${accent} 88%, black)`,
    "--og-radius-sm": `${style.corners.sm}px`,
    "--og-radius-md": `${style.corners.md}px`,
    "--og-radius-lg": `${style.corners.lg}px`,
  } as CSSProperties;
}
