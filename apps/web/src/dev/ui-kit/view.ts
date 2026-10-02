import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { useAppearance } from "@/lib/appearance";
import type { KitTheme } from "./theme";
import { isSectionKey, type SectionKey } from "./sections/registry";

/**
 * The kit's view state lives in the URL so any view can be reloaded, shared or
 * screenshotted:
 *
 *   ?section=<key>             one section (omit for the overview)
 *   ?theme=light|dark|split    theme; split renders the section twice
 *   ?width=mobile              preview the section in a 390px frame
 *   ?chrome=0                  hide the kit shell (clean screenshots)
 *   ?embed=1                   internal: the 390px frame's own document
 */

export const KIT_PATH = "/dev/ui-kit";
export const MOBILE_WIDTH = 390;
const VIEW_STORAGE_KEY = "opengeni-ui-kit-view-v1";

export type KitWidth = "desktop" | "mobile";

export interface KitView {
  section: SectionKey | null;
  /** A `?section=` value that isn't a known key. */
  unknownSection: string | null;
  theme: KitTheme;
  width: KitWidth;
  chrome: boolean;
  embed: boolean;
}

export interface KitViewChange {
  section?: SectionKey | null;
  theme?: KitTheme;
  width?: KitWidth;
}

interface StoredView {
  theme?: KitTheme;
  width?: KitWidth;
}

function parseTheme(value: string | null): KitTheme | null {
  return value === "light" || value === "dark" || value === "split" ? value : null;
}

function parseWidth(value: string | null): KitWidth | null {
  return value === "mobile" || value === "desktop" ? value : null;
}

function readStoredView(): StoredView {
  try {
    const value = JSON.parse(window.localStorage.getItem(VIEW_STORAGE_KEY) ?? "{}") as {
      theme?: string;
      width?: string;
    };
    return {
      theme: parseTheme(value.theme ?? null) ?? undefined,
      width: parseWidth(value.width ?? null) ?? undefined,
    };
  } catch {
    return {};
  }
}

function writeStoredView(view: StoredView) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // The URL still carries the view when storage is blocked.
  }
}

/** Relative URL for a kit view. Omitted fields keep their defaults. */
export function kitHref(view: {
  section?: SectionKey | null;
  theme?: KitTheme;
  width?: KitWidth;
  chrome?: boolean;
  embed?: boolean;
}): string {
  const params = new URLSearchParams();
  if (view.section) params.set("section", view.section);
  if (view.theme) params.set("theme", view.theme);
  if (view.width === "mobile") params.set("width", "mobile");
  if (view.chrome === false) params.set("chrome", "0");
  if (view.embed) params.set("embed", "1");
  const query = params.toString();
  return query ? `${KIT_PATH}?${query}` : KIT_PATH;
}

export function useKitView(): KitView {
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const { resolvedTheme } = useAppearance();
  return useMemo(() => {
    const params = new URLSearchParams(searchStr);
    const rawSection = params.get("section");
    const stored = readStoredView();
    return {
      section: isSectionKey(rawSection) ? rawSection : null,
      unknownSection: rawSection && !isSectionKey(rawSection) ? rawSection : null,
      theme: parseTheme(params.get("theme")) ?? stored.theme ?? resolvedTheme,
      width: parseWidth(params.get("width")) ?? stored.width ?? "desktop",
      chrome: params.get("chrome") !== "0",
      embed: params.get("embed") === "1",
    };
  }, [resolvedTheme, searchStr]);
}

/** Navigate within the kit. Section changes push history; view toggles replace it. */
export function useKitNavigate(view: KitView) {
  const router = useRouter();
  return useCallback(
    (change: KitViewChange) => {
      const next = {
        section: change.section === undefined ? view.section : change.section,
        theme: change.theme ?? view.theme,
        width: change.width ?? view.width,
        chrome: view.chrome,
      };
      if (change.theme || change.width) writeStoredView({ theme: next.theme, width: next.width });
      const href = kitHref(next);
      if (change.section !== undefined && change.section !== view.section) {
        router.history.push(href);
      } else {
        router.history.replace(href);
      }
    },
    [router, view.chrome, view.section, view.theme, view.width],
  );
}
