import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/**
 * Theme forcing for the kit.
 *
 * The app themes the whole document: `data-og-theme` plus the `dark` class on
 * <html> (see `lib/appearance.tsx`). Dark tokens live on `:root`, light tokens
 * on `[data-og-theme="light"]`, and Tailwind's bridge variables
 * (`--color-bg: var(--og-color-bg)`, ...) are declared once on `:root`. A
 * custom property that references another resolves where it is declared, so
 * setting `data-og-theme` on a subtree changes `--og-color-*` there but not the
 * `--color-*` values Tailwind utilities read.
 *
 * `ThemeScope` therefore re-declares, inline on the subtree, every custom
 * property the stylesheets put on `:root` (bridges included, so they resolve
 * against the subtree's own tokens) plus the light overrides when forcing
 * light. It also adds the `dark` class when forcing dark, so `dark:` variants
 * match. The values are read from the loaded stylesheets, never copied, so the
 * kit follows token changes.
 *
 * A forced-light subtree cannot undo an ancestor `.dark` class (`dark:` is
 * `.dark *`), so the document itself is kept light while side-by-side is on.
 */

export type ResolvedTheme = "light" | "dark";
export type KitTheme = ResolvedTheme | "split";

type VarEntries = Array<[string, string]>;

interface TokenSnapshot {
  root: Map<string, string>;
  light: Map<string, string>;
}

const LIGHT_SELECTORS = new Set(['[data-og-theme="light"]', ".og-light"]);

function collectTokens(): TokenSnapshot {
  const root = new Map<string, string>();
  const light = new Map<string, string>();

  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule) {
        const selectors = rule.selectorText.split(",").map((selector) => selector.trim());
        const isRoot = selectors.includes(":root");
        const isLight = selectors.some((selector) => LIGHT_SELECTORS.has(selector));
        if (!isRoot && !isLight) continue;
        for (let index = 0; index < rule.style.length; index += 1) {
          const name = rule.style.item(index);
          if (!name.startsWith("--")) continue;
          const value = rule.style.getPropertyValue(name).trim();
          if (isRoot) root.set(name, value);
          if (isLight) light.set(name, value);
        }
      } else if (rule instanceof CSSSupportsRule) {
        if (CSS.supports(rule.conditionText)) visit(rule.cssRules);
      } else if (rule instanceof CSSMediaRule) {
        if (window.matchMedia(rule.conditionText).matches) visit(rule.cssRules);
      } else if (rule instanceof CSSLayerBlockRule) {
        visit(rule.cssRules);
      } else if (rule instanceof CSSImportRule) {
        if (rule.styleSheet) visit(rule.styleSheet.cssRules);
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // Cross-origin sheets can't be read and hold no app tokens.
    }
  }
  return { root, light };
}

/** Inline custom properties that force `theme` on a subtree. */
function themeEntries(snapshot: TokenSnapshot, theme: ResolvedTheme): VarEntries {
  const values = new Map(snapshot.root);
  if (theme === "light") {
    for (const [name, value] of snapshot.light) values.set(name, value);
  } else {
    // Light-only names: keep pure aliases (they re-resolve here), drop the rest.
    for (const [name, value] of snapshot.light) {
      if (!values.has(name)) values.set(name, value.includes("var(") ? value : "initial");
    }
  }
  return Array.from(values);
}

// Stylesheets change under HMR; re-read tokens when <head> changes.
let tokenVersion = 0;
let tokenCache: { version: number; snapshot: TokenSnapshot } | null = null;
const tokenListeners = new Set<() => void>();
let headObserver: MutationObserver | null = null;

function subscribeTokens(listener: () => void) {
  tokenListeners.add(listener);
  if (!headObserver) {
    let scheduled = false;
    headObserver = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        tokenVersion += 1;
        for (const each of tokenListeners) each();
      });
    });
    headObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  }
  return () => {
    tokenListeners.delete(listener);
    if (tokenListeners.size === 0) {
      headObserver?.disconnect();
      headObserver = null;
    }
  };
}

function getTokenVersion() {
  return tokenVersion;
}

function tokenSnapshot(): TokenSnapshot {
  if (!tokenCache || tokenCache.version !== tokenVersion) {
    tokenCache = { version: tokenVersion, snapshot: collectTokens() };
  }
  return tokenCache.snapshot;
}

function useThemeEntries(theme: ResolvedTheme): VarEntries {
  const version = useSyncExternalStore(subscribeTokens, getTokenVersion, getTokenVersion);
  return useMemo(() => {
    void version;
    return themeEntries(tokenSnapshot(), theme);
  }, [theme, version]);
}

export const PANE_THEME_ATTRIBUTE = "data-kit-pane-theme";

/**
 * Forces `theme` on its subtree for both Tailwind utilities and `--og-*`
 * variables. Renders a div; pass layout classes through `className`.
 */
export function ThemeScope({
  theme,
  className,
  style,
  children,
}: {
  theme: ResolvedTheme;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const entries = useThemeEntries(theme);
  const scopedStyle = useMemo(() => {
    const next: Record<string, string> = {};
    for (const [name, value] of entries) next[name] = value;
    next.colorScheme = theme;
    return { ...next, ...style } as CSSProperties;
  }, [entries, style, theme]);
  return (
    <div
      data-og-theme={theme}
      {...{ [PANE_THEME_ATTRIBUTE]: theme }}
      className={cn(theme === "dark" && "dark", "bg-bg text-fg", className)}
      style={scopedStyle}
    >
      {children}
    </div>
  );
}

/**
 * Themes the whole document while the kit is mounted, so portalled menus,
 * tooltips and dialogs match. Restores the app's theme on unmount and holds
 * the kit's theme if the app's appearance effect runs meanwhile.
 */
export function useKitDocumentTheme(theme: ResolvedTheme) {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const previousTheme = html.dataset.ogTheme;
    const previousDark = html.classList.contains("dark");
    const apply = () => {
      if (html.dataset.ogTheme !== theme) html.dataset.ogTheme = theme;
      if (html.classList.contains("dark") !== (theme === "dark")) {
        html.classList.toggle("dark", theme === "dark");
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(html, { attributes: true, attributeFilter: ["class", "data-og-theme"] });
    return () => {
      observer.disconnect();
      if (previousTheme === undefined) delete html.dataset.ogTheme;
      else html.dataset.ogTheme = previousTheme;
      html.classList.toggle("dark", previousDark);
    };
  }, [theme]);
}

const PORTAL_MARK = "kitPortalTheme";

/**
 * While side by side is on, the document is light. Menus, tooltips and dialogs
 * portal to <body>, outside the panes, so this gives each new portal the theme
 * of the pane the pointer or focus was last in.
 */
export function useSplitPortalTheming(enabled: boolean) {
  const darkEntries = useThemeEntries("dark");
  useEffect(() => {
    if (!enabled) return;
    let lastPaneTheme: ResolvedTheme = "light";
    const track = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const pane = target.closest(`[${PANE_THEME_ATTRIBUTE}]`);
      const value = pane?.getAttribute(PANE_THEME_ATTRIBUTE);
      if (value === "light" || value === "dark") lastPaneTheme = value;
    };
    const events = ["pointerdown", "pointerover", "focusin", "keydown"] as const;
    for (const type of events) document.addEventListener(type, track, true);

    const applyDark = (element: HTMLElement) => {
      element.dataset[PORTAL_MARK] = "dark";
      element.dataset.ogTheme = "dark";
      element.classList.add("dark");
      for (const [name, value] of darkEntries) element.style.setProperty(name, value);
      element.style.colorScheme = "dark";
    };
    const observer = new MutationObserver((records) => {
      if (lastPaneTheme !== "dark") return;
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement) || node.dataset[PORTAL_MARK]) continue;
          if (node.id === "root" || node.tagName.includes("-")) continue;
          applyDark(node);
        }
      }
    });
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      for (const type of events) document.removeEventListener(type, track, true);
    };
  }, [darkEntries, enabled]);
}
