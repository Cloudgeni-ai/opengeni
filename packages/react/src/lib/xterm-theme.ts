import type { XtermTheme } from "../components/sandbox-terminal";

/**
 * Derive an xterm `ITheme` subset from the live OKLCH `--og-*` token system (or
 * the app's `--color-*` aliases). Reads the COMPUTED values so xterm — which
 * paints into a canvas and can't consume CSS vars — gets concrete colors. Call
 * on mount and re-derive on a `data-og-theme` flip.
 *
 * SSR-safe: returns undefined off the DOM (the caller keeps xterm's defaults).
 */
export function xtermThemeFromTokens(root?: HTMLElement | null): XtermTheme | undefined {
  if (typeof window === "undefined" || typeof getComputedStyle === "undefined") return undefined;
  const el = root ?? document.documentElement;
  const style = getComputedStyle(el);
  const read = (names: string[]): string | undefined => {
    for (const name of names) {
      const value = style.getPropertyValue(name).trim();
      if (value) return value;
    }
    return undefined;
  };
  const bg = read(["--og-color-bg", "--color-bg"]);
  const fg = read(["--og-color-fg", "--color-fg"]);
  const accent = read(["--og-color-accent", "--color-brand", "--color-accent"]);
  const theme: XtermTheme = {};
  if (bg) theme.background = bg;
  if (fg) theme.foreground = fg;
  if (accent) {
    theme.cursor = accent;
    theme.selectionBackground = accent;
  }
  if (bg) theme.cursorAccent = bg;
  return Object.keys(theme).length > 0 ? theme : undefined;
}
