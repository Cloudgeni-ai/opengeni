import type { CSSProperties } from "react";

/**
 * The playground's two styling controls, a brand color and light or dark.
 * Each is what an integration sets on the element around `<OpenGeniChat />`:
 * `--og-*` custom properties and `data-og-theme`.
 */
export type Accent = { name: string; value: string };
export type ChatStyle = { accent: Accent; theme: "light" | "dark" };

export const ACCENTS: readonly Accent[] = [
  { name: "Teal", value: "#1f8f7a" },
  { name: "Indigo", value: "#5b4bff" },
  { name: "Peach", value: "#e07b3c" },
  { name: "Rose", value: "#cf3f73" },
];

export function defaultChatStyle(theme: "light" | "dark"): ChatStyle {
  return { accent: ACCENTS[0]!, theme };
}

/**
 * The custom properties for one style. The snippet shows the two base tokens;
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
  } as CSSProperties;
}
