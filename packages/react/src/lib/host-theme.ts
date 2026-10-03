import { type CSSProperties, type RefObject, useLayoutEffect, useEffect, useState } from "react";

/* ----------------------------------------------------------------------------
   Host theme

   The embedded chat should look native in someone else's product with zero
   styling. Two things decide that:

   1. Light or dark follows the HOST, not the operating system. An explicit
      `theme` prop wins; then the nearest `data-og-theme` / `.og-light`
      ancestor; then the host's own signals on <html>/<body> (`class="dark"`,
      `data-theme`, `data-mode`, `data-bs-theme`, ...); then the host's
      explicit `color-scheme`; then the luminance of the background the chat
      actually sits on. A host whose page stays light while the OS is dark gets
      a light chat.

   2. Surfaces derive from the host background ("host" surface), so a navy app
      gets navy-tinted cards instead of neutral grey boxes, and a white app gets
      a white chat instead of a grey panel. Each surface is an opaque mix of the
      host background and the theme's text color, so portalled menus that copy
      the tokens stay opaque. A host that customizes the `--og-color-*` surface
      tokens keeps them: blending only replaces the stock defaults.
   -------------------------------------------------------------------------- */

export type HostThemePreference = "auto" | "light" | "dark";
export type HostSurfacePreference = "host" | "theme";
export type ResolvedHostTheme = "light" | "dark";

const HOST_THEME_ATTRIBUTES = [
  "data-theme",
  "data-mode",
  "data-color-mode",
  "data-color-scheme",
  "data-bs-theme",
  "data-mantine-color-scheme",
] as const;

/**
 * Stock literal color tokens as `[dark, light]`, mirroring `styles/tokens.css`
 * (a test keeps them in sync). A different value inherited from the host means
 * the host customized that token.
 */
export const STOCK_COLOR_TOKENS: Readonly<Record<string, readonly [string, string]>> = {
  "--og-color-bg": ["#303030", "#f6f6f6"],
  "--og-color-canvas": ["#202020", "#ffffff"],
  "--og-color-surface-1": ["#333333", "#ffffff"],
  "--og-color-surface-2": ["#383838", "#eeeeee"],
  "--og-color-surface-3": ["#404040", "#e5e5e5"],
  "--og-color-selection": ["#484848", "#e2e2e2"],
  "--og-color-border": ["#454545", "#dedede"],
  "--og-color-border-strong": ["#555555", "#bdbdbd"],
  "--og-color-fg": ["#e6e6e6", "#242424"],
  "--og-color-fg-label": ["#d4d4d4", "#3a3a3a"],
  "--og-color-fg-muted": ["#b8b8b8", "#5f5f5f"],
  "--og-color-fg-subtle": ["#a3a3a3", "#696969"],
  "--og-color-accent": ["#c4c4c4", "#545454"],
  "--og-color-accent-strong": ["#dcdcdc", "#383838"],
  "--og-color-accent-deep": ["#d5d5d5", "#383838"],
  "--og-color-accent-fg": ["#242424", "#ffffff"],
  "--og-color-primary": ["#2b3432", "#ebf2f0"],
  "--og-color-primary-fg": ["#eeeeee", "#292929"],
  "--og-color-primary-border": ["#4e5e59", "#c4d5d0"],
  "--og-color-switch-track": ["#454545", "#bdbdbd"],
  "--og-color-switch-thumb": ["#a3a3a3", "#ffffff"],
  "--og-color-status-queued": ["#a3a3a3", "#696969"],
  "--og-color-status-running": ["#d5bd72", "#716122"],
  "--og-color-status-idle": ["#83cbb0", "#237058"],
  "--og-color-status-waiting": ["#e9ab77", "#8c5524"],
  "--og-color-status-failed": ["oklch(0.77 0.12 22)", "oklch(0.5 0.19 22)"],
  "--og-color-status-cancelled": ["#a3a3a3", "#696969"],
  "--og-color-danger": ["oklch(0.76 0.13 22)", "oklch(0.52 0.2 22)"],
  "--og-color-danger-fill": ["oklch(0.52 0.16 22)", "oklch(0.5 0.19 22)"],
  "--og-color-danger-fg": ["#ffffff", "#ffffff"],
};

const SURFACE_TOKENS = [
  "--og-color-canvas",
  "--og-color-bg",
  "--og-color-surface-1",
  "--og-color-surface-2",
] as const;

/** Percent of the theme's text color mixed into the host background. */
const SURFACE_MIX: Record<ResolvedHostTheme, Record<string, number>> = {
  light: {
    "--og-color-canvas": 0,
    "--og-color-bg": 0,
    "--og-color-surface-1": 0,
    "--og-color-surface-2": 5,
    "--og-color-surface-3": 8,
    "--og-color-selection": 9,
    "--og-color-border": 11,
    "--og-color-border-strong": 24,
  },
  dark: {
    "--og-color-canvas": 0,
    "--og-color-bg": 0,
    "--og-color-surface-1": 5,
    "--og-color-surface-2": 8,
    "--og-color-surface-3": 12,
    "--og-color-selection": 15,
    "--og-color-border": 14,
    "--og-color-border-strong": 24,
  },
};

type Rgba = { r: number; g: number; b: number; a: number };

/** Parse the `rgb()/rgba()` strings that `getComputedStyle` returns. */
export function parseComputedColor(value: string | null | undefined): Rgba | null {
  if (!value) return null;
  const match =
    /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(
      value.trim(),
    );
  if (!match) return null;
  const alphaText = match[4];
  const alpha =
    alphaText === undefined
      ? 1
      : alphaText.endsWith("%")
        ? Number(alphaText.slice(0, -1)) / 100
        : Number(alphaText);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha };
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance({ r, g, b }: Pick<Rgba, "r" | "g" | "b">): number {
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function themeWord(value: string | null | undefined): ResolvedHostTheme | null {
  if (!value) return null;
  const words = value.toLowerCase().split(/[\s_-]+/);
  if (words.includes("dark")) return "dark";
  if (words.includes("light")) return "light";
  return null;
}

function classTheme(element: Element | null): ResolvedHostTheme | null {
  if (!element) return null;
  const classes = element.classList;
  if (classes.contains("dark") || classes.contains("theme-dark") || classes.contains("dark-mode"))
    return "dark";
  if (
    classes.contains("light") ||
    classes.contains("theme-light") ||
    classes.contains("light-mode")
  )
    return "light";
  for (const attribute of HOST_THEME_ATTRIBUTES) {
    const theme = themeWord(element.getAttribute(attribute));
    if (theme) return theme;
  }
  return null;
}

function colorSchemeTheme(element: Element): ResolvedHostTheme | null {
  const scheme = getComputedStyle(element).colorScheme?.toLowerCase() ?? "";
  const words = scheme.split(/\s+/).filter((word) => word && word !== "only");
  // `light dark` only says the page supports both; the background decides.
  if (words.length === 1 && (words[0] === "dark" || words[0] === "light")) return words[0];
  return null;
}

/**
 * The first opaque background the element sits on (its ancestors only), or
 * null when the page paints none of its own and the browser canvas shows.
 */
export function hostBackground(element: Element): Rgba | null {
  let current: Element | null = element.parentElement;
  while (current) {
    const color = parseComputedColor(getComputedStyle(current).backgroundColor);
    if (color && color.a >= 0.5) return color;
    current = current.parentElement;
  }
  return null;
}

/**
 * Resolve light or dark for an embedded root from its host page. Pure DOM
 * reads; never consults `prefers-color-scheme` on its own.
 */
export function resolveHostTheme(element: Element): ResolvedHostTheme {
  const parent = element.parentElement;
  const tagged = parent?.closest("[data-og-theme], .og-light");
  if (tagged) {
    if (tagged.classList.contains("og-light")) return "light";
    return tagged.getAttribute("data-og-theme") === "light" ? "light" : "dark";
  }
  const document = element.ownerDocument;
  const signalled = classTheme(document.documentElement) ?? classTheme(document.body);
  if (signalled) return signalled;
  const scheme =
    (parent ? colorSchemeTheme(parent) : null) ?? colorSchemeTheme(document.documentElement);
  if (scheme) return scheme;
  const background = hostBackground(element);
  if (background) return relativeLuminance(background) < 0.4 ? "dark" : "light";
  // No host paint: the browser canvas shows, which is light unless the page
  // opted into a dark scheme that follows the OS.
  const rootScheme = getComputedStyle(document.documentElement).colorScheme ?? "";
  if (/\bdark\b/.test(rootScheme) && /\blight\b/.test(rootScheme)) {
    return document.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Tokens the host customized on an ancestor, by value. Setting our own
 * `data-og-theme` would otherwise reset them to the theme's stock values.
 */
export function hostTokenOverrides(element: Element): Record<`--${string}`, string> {
  const parent = element.parentElement;
  const overrides: Record<`--${string}`, string> = {};
  if (!parent) return overrides;
  const computed = getComputedStyle(parent);
  for (const [token, stock] of Object.entries(STOCK_COLOR_TOKENS)) {
    const value = computed.getPropertyValue(token);
    if (!value.trim()) continue;
    const normalized = normalizeToken(value);
    if (!stock.some((candidate) => normalizeToken(candidate) === normalized)) {
      overrides[token as `--${string}`] = value.trim();
    }
  }
  return overrides;
}

/** Inline token overrides that blend the stock surfaces into the host background. */
export function hostSurfaceStyle(
  theme: ResolvedHostTheme,
  background: Pick<Rgba, "r" | "g" | "b"> | null,
): Record<`--${string}`, string> {
  const base = background
    ? `rgb(${Math.round(background.r)} ${Math.round(background.g)} ${Math.round(background.b)})`
    : "Canvas";
  const style: Record<`--${string}`, string> = {};
  for (const [token, percent] of Object.entries(SURFACE_MIX[theme])) {
    style[token as `--${string}`] =
      percent === 0 ? base : `color-mix(in srgb, var(--og-color-fg) ${percent}%, ${base})`;
  }
  return style;
}

export type HostTheme = {
  /** `data-og-theme` to set on the root, or undefined to inherit. */
  attribute: ResolvedHostTheme | undefined;
  theme: ResolvedHostTheme | undefined;
  style: CSSProperties | undefined;
};

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Resolve and track the host theme for an embedded root. Re-resolves when the
 * host flips `class`/`data-*`/`style` on <html>, <body> or an ancestor, and
 * when the OS scheme changes (which only matters for hosts that follow it).
 */
export function useHostTheme(
  ref: RefObject<HTMLElement | null>,
  options: { theme?: HostThemePreference | undefined; surface?: HostSurfacePreference | undefined },
): HostTheme {
  const preference = options.theme ?? "auto";
  const surface = options.surface ?? "host";
  const [state, setState] = useState<{
    theme: ResolvedHostTheme | undefined;
    inherited: boolean;
    style: Record<string, string> | null;
  }>({ theme: preference === "auto" ? undefined : preference, inherited: false, style: null });

  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof window === "undefined") return;
    let signature = "";
    const sync = () => {
      const theme = preference === "auto" ? resolveHostTheme(element) : preference;
      const tagged = element.parentElement?.closest("[data-og-theme], .og-light");
      const inheritedTheme = tagged
        ? tagged.classList.contains("og-light") || tagged.getAttribute("data-og-theme") === "light"
          ? "light"
          : "dark"
        : // Untagged ancestors carry the stock dark defaults.
          "dark";
      const inherited = inheritedTheme === theme;
      const overrides = hostTokenOverrides(element);
      const surfacesCustomized = SURFACE_TOKENS.some((token) => token in overrides);
      const blend =
        surface === "host" && !surfacesCustomized
          ? hostSurfaceStyle(theme, hostBackground(element))
          : {};
      // Dark is the stock default, so no stylesheet rule restores it under a
      // light ancestor: declare the dark stock values directly.
      const darkReset: Record<string, string> =
        !inherited && theme === "dark"
          ? {
              ...Object.fromEntries(
                Object.entries(STOCK_COLOR_TOKENS).map(([token, [dark]]) => [token, dark]),
              ),
              "--_og-color-scheme": "dark",
              colorScheme: "dark",
            }
          : {};
      // Re-declaring the theme on this root would reset the host's own
      // customizations; carry them over explicitly.
      const style = { ...darkReset, ...blend, ...(inherited ? {} : overrides) };
      const next = { theme, inherited, style: Object.keys(style).length > 0 ? style : null };
      const nextSignature = JSON.stringify(next);
      if (nextSignature === signature) return;
      signature = nextSignature;
      setState(next);
    };
    sync();
    const document = element.ownerDocument;
    const observers: MutationObserver[] = [];
    if (typeof MutationObserver !== "undefined") {
      const watched = new Set<Element>([document.documentElement]);
      if (document.body) watched.add(document.body);
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        watched.add(ancestor);
      }
      for (const target of watched) {
        const observer = new MutationObserver(sync);
        observer.observe(target, {
          attributes: true,
          attributeFilter: ["class", "style", "data-og-theme", ...HOST_THEME_ATTRIBUTES],
        });
        observers.push(observer);
      }
    }
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", sync);
    return () => {
      for (const observer of observers) observer.disconnect();
      media?.removeEventListener?.("change", sync);
    };
  }, [preference, ref, surface]);

  return {
    theme: state.theme,
    // Re-declaring the inherited theme on this root would reset tokens that an
    // enclosing embed root already blended or the host customized.
    attribute: state.theme && !state.inherited ? state.theme : undefined,
    style: state.style ? (state.style as CSSProperties) : undefined,
  };
}
