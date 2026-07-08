import type { XtermTheme } from "../components/sandbox-terminal";

/* ----------------------------------------------------------------------------
   xterm theming + font resolution from the `--og-*` token system.

   xterm paints glyphs into a canvas (WebGL / 2D) and builds its font strings by
   hand, so it can consume NEITHER CSS custom properties (`var(--og-font-mono)`
   never resolves in a canvas font string) NOR a partial palette (an unset ANSI
   slot falls back to xterm's stock VGA color). This module resolves both to
   concrete values: a full 16-color ANSI ITheme designed against the og palette
   for BOTH themes, and a concrete monospace family + px size.

   The color-building + font-resolution cores are pure over a token `read`
   function so they unit-test without a DOM; thin `*FromTokens` / `resolve*`
   wrappers do the `getComputedStyle` read on the client.
   -------------------------------------------------------------------------- */

export type ThemeMode = "dark" | "light";

/** Reads a resolved token value (already `getComputedStyle`-flattened). */
export type TokenReader = (name: string) => string | undefined;

/**
 * The 16 ANSI colors + selection/cursor treatment, designed against the og
 * OKLCH palette. Hues are borrowed from the og status ramp so terminal color
 * reads as part of the same system: red≈status-failed(22), green≈status-idle
 * (155), yellow≈status-running(80), blue≈accent(255), magenta≈status-waiting
 * (305), cyan≈200. Dark uses lifted lightness on the dark slate ground; light
 * uses deeper, more saturated inks on the near-white ground. Bright variants
 * add lightness + a touch of chroma. `black`/`white` are neutral slate ramp
 * stops (never pure #000/#fff — that clashes with the calm neutral ground).
 */
export type AnsiPalette = {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  /** Selection wash + its foreground; sits over the terminal ground. */
  selectionBackground: string;
  selectionForeground: string;
  selectionInactiveBackground: string;
};

const DARK_ANSI: AnsiPalette = {
  black: "oklch(0.3 0.014 260)",
  red: "oklch(0.68 0.17 22)",
  green: "oklch(0.75 0.13 155)",
  yellow: "oklch(0.8 0.11 80)",
  blue: "oklch(0.7 0.14 255)",
  magenta: "oklch(0.72 0.13 305)",
  cyan: "oklch(0.75 0.1 210)",
  white: "oklch(0.8 0.01 260)",
  brightBlack: "oklch(0.45 0.014 260)",
  brightRed: "oklch(0.76 0.17 22)",
  brightGreen: "oklch(0.82 0.14 155)",
  brightYellow: "oklch(0.86 0.12 85)",
  brightBlue: "oklch(0.78 0.13 255)",
  brightMagenta: "oklch(0.8 0.13 305)",
  brightCyan: "oklch(0.83 0.1 200)",
  brightWhite: "oklch(0.97 0.005 260)",
  selectionBackground: "oklch(0.72 0.15 255 / 0.34)",
  selectionForeground: "oklch(0.985 0.005 260)",
  selectionInactiveBackground: "oklch(0.72 0.02 260 / 0.22)",
};

const LIGHT_ANSI: AnsiPalette = {
  black: "oklch(0.35 0.015 260)",
  red: "oklch(0.52 0.19 22)",
  green: "oklch(0.5 0.13 155)",
  yellow: "oklch(0.56 0.13 80)",
  blue: "oklch(0.52 0.18 255)",
  magenta: "oklch(0.52 0.16 305)",
  cyan: "oklch(0.52 0.1 210)",
  white: "oklch(0.7 0.01 260)",
  brightBlack: "oklch(0.5 0.014 260)",
  brightRed: "oklch(0.55 0.2 22)",
  brightGreen: "oklch(0.54 0.14 155)",
  brightYellow: "oklch(0.6 0.14 80)",
  brightBlue: "oklch(0.48 0.19 255)",
  brightMagenta: "oklch(0.54 0.17 305)",
  brightCyan: "oklch(0.54 0.11 210)",
  brightWhite: "oklch(0.3 0.015 260)",
  selectionBackground: "oklch(0.55 0.18 255 / 0.24)",
  selectionForeground: "oklch(0.21 0.015 260)",
  selectionInactiveBackground: "oklch(0.6 0.02 260 / 0.16)",
};

/** The designed ANSI-16 palette for a theme mode. Pure. */
export function ogAnsiPalette(mode: ThemeMode): AnsiPalette {
  return mode === "light" ? LIGHT_ANSI : DARK_ANSI;
}

/**
 * Build a COMPLETE xterm ITheme from token values. Background/foreground/cursor
 * come from the live `--og-*` tokens (so an embedder's rebrand flows through);
 * the ANSI-16 + selection come from the designed palette for `mode`. Every ANSI
 * slot is always set — xterm never falls back to its stock VGA colors. Pure.
 */
export function buildXtermTheme(read: TokenReader, mode: ThemeMode): XtermTheme {
  const ansi = ogAnsiPalette(mode);
  const bgFallback = mode === "light" ? "oklch(0.978 0.003 260)" : "oklch(0.155 0.012 260)";
  const fgFallback = mode === "light" ? "oklch(0.21 0.015 260)" : "oklch(0.955 0.005 260)";
  const bg = read("--og-color-bg") ?? bgFallback;
  const fg = read("--og-color-fg") ?? fgFallback;
  const accent = read("--og-color-accent") ?? ansi.brightBlue;
  return {
    // Match the dock surface the terminal paints on (`--og-color-bg`).
    background: bg,
    foreground: fg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: ansi.selectionBackground,
    selectionForeground: ansi.selectionForeground,
    selectionInactiveBackground: ansi.selectionInactiveBackground,
    black: ansi.black,
    red: ansi.red,
    green: ansi.green,
    yellow: ansi.yellow,
    blue: ansi.blue,
    magenta: ansi.magenta,
    cyan: ansi.cyan,
    white: ansi.white,
    brightBlack: ansi.brightBlack,
    brightRed: ansi.brightRed,
    brightGreen: ansi.brightGreen,
    brightYellow: ansi.brightYellow,
    brightBlue: ansi.brightBlue,
    brightMagenta: ansi.brightMagenta,
    brightCyan: ansi.brightCyan,
    brightWhite: ansi.brightWhite,
  };
}

/** Which og theme is active for `el`, matching the `use-theme-type` convention
 *  (nearest `data-og-theme` / `.og-light` ancestor; else the computed
 *  `color-scheme`; else dark, the first-class default). */
function detectMode(el: Element, style: CSSStyleDeclaration): ThemeMode {
  const closest = el.closest?.bind(el);
  if (closest) {
    if (closest('[data-og-theme="light"]') || closest(".og-light")) return "light";
    const explicit = closest("[data-og-theme]");
    if (explicit) return explicit.getAttribute("data-og-theme") === "light" ? "light" : "dark";
  }
  const scheme = (style.getPropertyValue("color-scheme").trim() || style.colorScheme || "").toLowerCase();
  if (scheme.includes("light") && !scheme.includes("dark")) return "light";
  return "dark";
}

/**
 * Derive a COMPLETE xterm `ITheme` from the live `--og-*` token system on the
 * DOM. Reads the COMPUTED values so xterm gets concrete colors, detects the
 * active theme mode, and fills every ANSI slot. Call on mount + re-derive on a
 * `data-og-theme` flip. SSR-safe: returns undefined off the DOM.
 *
 * `root` should be an element INSIDE the themed subtree (e.g. the terminal
 * container) so nested `[data-og-theme]` themes resolve correctly; when omitted
 * it falls back to the nearest `[data-og-theme]` element, then documentElement.
 */
export function xtermThemeFromTokens(root?: HTMLElement | null): XtermTheme | undefined {
  if (typeof window === "undefined" || typeof getComputedStyle === "undefined") return undefined;
  const el =
    root ??
    (typeof document !== "undefined"
      ? ((document.querySelector("[data-og-theme]") as HTMLElement | null) ?? document.documentElement)
      : null);
  if (!el) return undefined;
  const style = getComputedStyle(el);
  const read: TokenReader = (name) => {
    const value = style.getPropertyValue(name).trim();
    return value || undefined;
  };
  return buildXtermTheme(read, detectMode(el, style));
}

// ── Font resolution ──────────────────────────────────────────────────────────

export type ResolvedTerminalFont = { fontFamily: string; fontSize: number; lineHeight: number };

/** Concrete fallback if the token is unset or (defensively) still a `var()`. */
const FALLBACK_MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

export type FontOverrides = { fontFamily?: string | undefined; fontSize?: number | undefined };

/**
 * Resolve xterm's font from token values. The critical bug this fixes:
 * `fontFamily: "var(--og-font-mono)"` is measured by xterm via a canvas font
 * string where `var()` does NOT resolve, so xterm silently mis-measures every
 * glyph. Here the family is a CONCRETE stack; a `var(` in the input is treated
 * as unresolved and replaced with the fallback. Pure over a token `read`.
 */
export function resolveTerminalFontFromReader(read: TokenReader, overrides?: FontOverrides): ResolvedTerminalFont {
  const rawFamily = overrides?.fontFamily ?? read("--og-font-mono");
  const fontFamily = rawFamily && rawFamily.trim() && !rawFamily.includes("var(") ? rawFamily.trim() : FALLBACK_MONO;

  let fontSize = overrides?.fontSize;
  if (fontSize == null) {
    const raw = read("--og-code-font-size");
    const parsed = raw ? Number.parseFloat(raw) : Number.NaN;
    fontSize = Number.isFinite(parsed) && parsed > 0 ? parsed : 13;
  }

  return { fontFamily, fontSize, lineHeight: 1.3 };
}

/** DOM wrapper: resolve the terminal font from an element's computed tokens. */
export function resolveTerminalFont(el: HTMLElement, overrides?: FontOverrides): ResolvedTerminalFont {
  const style = getComputedStyle(el);
  const read: TokenReader = (name) => {
    const value = style.getPropertyValue(name).trim();
    return value || undefined;
  };
  return resolveTerminalFontFromReader(read, overrides);
}
