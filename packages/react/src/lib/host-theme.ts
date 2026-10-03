import { type CSSProperties, type RefObject, useLayoutEffect, useEffect, useState } from "react";

/* ----------------------------------------------------------------------------
   Host theme

   The embedded chat should look native in someone else's product with zero
   styling. Two things decide that:

   1. Light or dark follows the HOST, not the operating system. An explicit
      `theme` prop wins; then the nearest `data-og-theme` / `.og-light`
      ancestor; then the host's own signals on <html>/<body> (`class="dark"`,
      `data-theme`, `data-mode`, `data-bs-theme`, ...); then the background
      the chat actually sits on; then the host's explicit `color-scheme` (which
      also colors an unpainted page canvas). A host whose page stays light while
      the OS is dark gets a light chat.

   2. Surfaces derive from the host background ("host" surface), so a navy app
      gets navy-tinted cards instead of neutral grey boxes, and a white app gets
      a white chat instead of a grey panel. Each surface is an opaque mix of the
      host background and the theme's text color, so portalled menus that copy
      the tokens stay opaque. A host that customizes the `--og-color-*` surface
      tokens keeps them: blending only replaces the stock defaults, and only
      when the background agrees with the resolved theme.

   An embed root nested in another (the conversation inside OpenGeniChat)
   inherits the enclosing root's resolution instead of resolving again.
   -------------------------------------------------------------------------- */

/** Marks an embed root that resolves the host theme for its subtree. */
export const HOST_THEME_ROOT_ATTRIBUTE = "data-og-host-theme";

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

/**
 * Tokens derived from the surfaces (or theme-tuned shadows), redeclared on the
 * root whenever its surfaces or theme are replaced inline: custom properties
 * resolve `var()` where they are declared, so values computed on an ancestor
 * would otherwise keep the ancestor's surfaces.
 */
const DERIVED_TOKENS: Record<ResolvedHostTheme, Record<string, string>> = {
  light: {
    "--og-session-chrome-surface":
      "color-mix(in oklch, var(--og-color-surface-2) 88%, transparent)",
    "--og-session-chrome-surface-open": "var(--og-color-surface-2)",
    "--og-session-chrome-border": "color-mix(in oklch, var(--og-color-border) 90%, transparent)",
    "--og-session-chrome-border-open": "var(--og-color-border)",
    "--og-session-chrome-highlight": "var(--og-color-surface-3)",
    "--og-session-chrome-row-hover":
      "color-mix(in oklch, var(--og-color-surface-3) 70%, transparent)",
  },
  dark: {
    "--og-session-chrome-surface":
      "color-mix(in oklch, var(--og-color-surface-2) 82%, transparent)",
    "--og-session-chrome-surface-open":
      "color-mix(in oklch, var(--og-color-surface-2) 92%, transparent)",
    "--og-session-chrome-border": "color-mix(in oklch, var(--og-color-border) 85%, transparent)",
    "--og-session-chrome-border-open": "var(--og-color-border)",
    "--og-session-chrome-highlight": "var(--og-color-surface-3)",
    "--og-session-chrome-row-hover":
      "color-mix(in oklch, var(--og-color-surface-3) 55%, transparent)",
  },
};

/** The rest of the stock dark theme, for a dark root under a light ancestor. */
const DARK_RESET_EXTRA: Record<string, string> = {
  "--og-color-hover": "color-mix(in srgb, var(--og-color-fg) 8%, transparent)",
  "--og-color-accent-soft": "color-mix(in oklch, var(--og-color-accent) 16%, transparent)",
  "--og-color-primary-hover":
    "color-mix(in srgb, var(--og-color-primary) 85%, var(--og-color-primary-fg))",
  "--og-color-diff-add-bg": "color-mix(in oklch, var(--og-color-status-idle) 14%, transparent)",
  "--og-color-diff-del-bg": "color-mix(in oklch, var(--og-color-status-failed) 14%, transparent)",
  "--og-shadow-sm": "0 1px 2px oklch(0 0 0 / 0.28)",
  "--og-shadow-md": "0 2px 8px oklch(0 0 0 / 0.32), 0 1px 2px oklch(0 0 0 / 0.24)",
  "--og-shadow-lg": "0 8px 28px oklch(0 0 0 / 0.42), 0 2px 8px oklch(0 0 0 / 0.28)",
  "--og-shadow-glow": "0 0 24px color-mix(in oklch, var(--og-color-accent) 10%, transparent)",
  "--og-glow-teal": "#79d9c125",
  "--og-glow-peach": "#ffb78724",
  "--og-glow-teal-quiet": "#79d9c115",
  "--og-glow-peach-quiet": "#ffb78714",
  "--og-session-chrome-highlight-ring": "color-mix(in oklch, var(--og-color-fg) 16%, transparent)",
  "--og-session-chrome-shadow": "0 6px 22px -14px oklch(0 0 0 / 0.42)",
  "--og-session-chrome-shadow-open": "0 10px 28px -16px oklch(0 0 0 / 0.5)",
  "--_og-color-scheme": "dark",
  colorScheme: "dark",
};

/** Neutral tokens are designed for one theme; brand/status tokens travel. */
const NEUTRAL_TOKEN =
  /^--og-color-(bg|canvas|surface-\d|selection|border(-strong)?|fg(-\w+)?|switch-\w+)$/;

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

/** Parse a `#rgb`/`#rrggbb` or `rgb()` token value; null for anything else. */
export function parseTokenColor(value: string): Rgba | null {
  const text = value.trim();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(text)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  return parseComputedColor(text);
}

const STOCK_LIGHT_TEXT = relativeLuminance({ r: 0x24, g: 0x24, b: 0x24 });
const STOCK_DARK_TEXT = relativeLuminance({ r: 0xe6, g: 0xe6, b: 0xe6 });

/**
 * The theme whose text reads better on this background: dark when the stock
 * light text has the higher contrast ratio. Mid-tone and saturated brand
 * backgrounds land on whichever text actually stays legible.
 */
export function themeForBackground(color: Pick<Rgba, "r" | "g" | "b">): ResolvedHostTheme {
  const background = relativeLuminance(color);
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  return contrast(STOCK_DARK_TEXT, background) > contrast(STOCK_LIGHT_TEXT, background)
    ? "dark"
    : "light";
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
  // What the chat actually sits on is the strongest remaining signal. A
  // color-scheme alone can come from a stylesheet (including our own
  // tokens.css on :root) without the page being painted that way.
  const background = hostBackground(element);
  if (background) return themeForBackground(background);
  // No host paint: the browser canvas shows, colored by the root scheme.
  const scheme =
    (parent ? colorSchemeTheme(parent) : null) ?? colorSchemeTheme(document.documentElement);
  if (scheme) return scheme;
  // A page that supports both schemes follows the OS on its canvas.
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

/** The theme a set of customized neutral tokens was designed for, if any. */
function designedTheme(overrides: Record<string, string>): ResolvedHostTheme | null {
  for (const token of ["--og-color-fg", "--og-color-bg", "--og-color-canvas"] as const) {
    const value = overrides[token];
    const color = value ? parseTokenColor(value) : null;
    if (!color) continue;
    const luminance = relativeLuminance(color);
    // Text colors are dark on light themes; backgrounds the other way round.
    const light = token === "--og-color-fg" ? luminance < 0.19 : luminance >= 0.19;
    return light ? "light" : "dark";
  }
  return null;
}

/** Inline style and theme for one embed root. Pure; exported for tests. */
export function resolveHostThemeState(
  element: Element,
  preference: HostThemePreference,
  surface: HostSurfacePreference,
): { theme: ResolvedHostTheme; inherited: boolean; style: Record<string, string> | null } {
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
  // Customized neutrals designed for the other theme would put dark text on a
  // dark root (or light on light) once the theme flips; brand colors travel.
  const designed = designedTheme(overrides);
  const carried = Object.fromEntries(
    Object.entries(overrides).filter(
      ([token]) => !NEUTRAL_TOKEN.test(token) || designed === null || designed === theme,
    ),
  );
  const surfacesCustomized = SURFACE_TOKENS.some((token) => token in carried);
  const background = hostBackground(element);
  // Blend only when the background agrees with the theme: light text on a
  // white card (or the reverse) would be unreadable.
  const blends =
    surface === "host" &&
    !surfacesCustomized &&
    (background === null || themeForBackground(background) === theme);
  const darkReset =
    !inherited && theme === "dark"
      ? {
          ...Object.fromEntries(
            Object.entries(STOCK_COLOR_TOKENS).map(([token, [dark]]) => [token, dark]),
          ),
          ...DARK_RESET_EXTRA,
        }
      : {};
  const replacesSurfaces = blends || Object.keys(darkReset).length > 0;
  const style: Record<string, string> = {
    ...darkReset,
    ...(blends ? hostSurfaceStyle(theme, background) : {}),
    ...(replacesSurfaces ? DERIVED_TOKENS[theme] : {}),
    // Re-declaring the theme on this root would reset the host's own
    // customizations; carry them over explicitly.
    ...(inherited ? {} : carried),
  };
  return { theme, inherited, style: Object.keys(style).length > 0 ? style : null };
}

/**
 * Resolve and track the host theme for an embedded root. Re-resolves when the
 * host flips `class`/`data-*`/`style` on <html>, <body> or an ancestor, and
 * when the OS scheme changes (which only matters for hosts that follow it).
 * A root nested inside another embed root inherits its resolution.
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
    // The enclosing embed root resolves for this subtree; its attribute is
    // rendered from the first commit, so there is no ordering race.
    if (preference === "auto" && element.parentElement?.closest(`[${HOST_THEME_ROOT_ATTRIBUTE}]`)) {
      setState((current) =>
        current.inherited && current.style === null
          ? current
          : { theme: undefined, inherited: true, style: null },
      );
      return;
    }
    let signature = "";
    const sync = () => {
      const next = resolveHostThemeState(element, preference, surface);
      const nextSignature = JSON.stringify(next);
      if (nextSignature === signature) return;
      signature = nextSignature;
      setState(next);
    };
    sync();
    // Host mutations (resizable panels restyle every frame) coalesce per frame.
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        sync();
      });
    };
    const document = element.ownerDocument;
    const observers: MutationObserver[] = [];
    if (typeof MutationObserver !== "undefined") {
      const watched = new Set<Element>([document.documentElement]);
      if (document.body) watched.add(document.body);
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        watched.add(ancestor);
      }
      for (const target of watched) {
        const observer = new MutationObserver(schedule);
        observer.observe(target, {
          attributes: true,
          attributeFilter: ["class", "style", "data-og-theme", ...HOST_THEME_ATTRIBUTES],
        });
        observers.push(observer);
      }
    }
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    media?.addEventListener?.("change", schedule);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      for (const observer of observers) observer.disconnect();
      media?.removeEventListener?.("change", schedule);
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
