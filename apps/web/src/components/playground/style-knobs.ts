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

/** A brand color typed as hex ("#5b4bff" or "5b4bff"), or null until it is one. */
export function customAccent(value: string): Accent | null {
  const match = /^#?([0-9a-f]{6})$/iu.exec(value.trim());
  return match ? { name: "Custom", value: `#${match[1]!.toLowerCase()}` } : null;
}

export function defaultChatStyle(theme: "light" | "dark"): ChatStyle {
  return { accent: ACCENTS[0]!, theme };
}

/** How strongly the brand color tints the chat's secondary surface. */
export const SURFACE_TINT_ALPHA = "26";

/**
 * The custom properties for one style: exactly the snippet's three, plus the
 * few the package derives from them (its compiled stylesheet recomputes them
 * per element; the app's own stylesheet computes them once, at the page root).
 * The tinted secondary surface colors user messages and the selected chat.
 */
export function chatTokens(style: ChatStyle): CSSProperties {
  const accent = style.accent.value;
  return {
    "--og-color-accent": accent,
    "--og-color-primary": accent,
    "--og-color-surface-2": `${accent}${SURFACE_TINT_ALPHA}`,
    "--og-color-accent-soft": `color-mix(in oklch, ${accent} 16%, transparent)`,
    "--og-shadow-glow": `0 0 24px color-mix(in oklch, ${accent} 10%, transparent)`,
    "--og-color-primary-hover": `color-mix(in srgb, ${accent} 85%, var(--og-color-primary-fg))`,
  } as CSSProperties;
}
