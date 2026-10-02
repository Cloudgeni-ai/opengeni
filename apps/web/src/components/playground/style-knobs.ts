import type { CSSProperties } from "react";

/**
 * The restyle palette: what a product changes to make the embedded chat its
 * own. Every knob is an `--og-*` custom property on an ancestor of the
 * `@opengeni/react` components, the same thing an integration sets.
 */
export type Accent = { name: string; value: string };
export type Corners = { name: string; sm: number; md: number; lg: number };
export type Font = { name: string; css: string };
export type ChatStyle = {
  accent: Accent;
  corners: Corners;
  font: Font;
  theme: "light" | "dark";
};

export const ACCENTS: readonly Accent[] = [
  { name: "Teal", value: "#1f8f7a" },
  { name: "Peach", value: "#e07b3c" },
  { name: "Indigo", value: "#5b4bff" },
  { name: "Rose", value: "#cf3f73" },
  { name: "Graphite", value: "#3d4644" },
];
export const CORNERS: readonly Corners[] = [
  { name: "Sharp", sm: 2, md: 4, lg: 6 },
  { name: "Soft", sm: 6, md: 10, lg: 14 },
  { name: "Round", sm: 10, md: 18, lg: 24 },
];
export const FONTS: readonly Font[] = [
  { name: "DM Sans", css: '"DM Sans Variable", ui-sans-serif, system-ui, sans-serif' },
  { name: "Inter", css: '"Inter Variable", ui-sans-serif, system-ui, sans-serif' },
  { name: "Serif", css: 'Georgia, "Times New Roman", serif' },
  { name: "Mono", css: '"JetBrains Mono Variable", ui-monospace, monospace' },
];

export function defaultChatStyle(theme: "light" | "dark"): ChatStyle {
  return { accent: ACCENTS[0]!, corners: CORNERS[1]!, font: FONTS[0]!, theme };
}

/**
 * The custom properties for one style. Derived accent shades are set too:
 * the defaults compute them from the page's own accent.
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
    "--og-font-sans": style.font.css,
  } as CSSProperties;
}

/** The snippet a product would paste: the same properties, on its own class. */
export function chatTokensCss(style: ChatStyle): string {
  return `.my-agent {
  --og-color-accent: ${style.accent.value};
  --og-radius-md: ${style.corners.md}px;
  --og-font-sans: ${style.font.css.split(",")[0]}, sans-serif;
}`;
}
