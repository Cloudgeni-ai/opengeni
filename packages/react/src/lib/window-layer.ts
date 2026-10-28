import { useEffect, useLayoutEffect } from "react";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// The count lives on the document, so every copy of this package on a page
// shares it.
const OPEN_LAYERS = Symbol.for("opengeni.windowLayersOpen");
type CountedRoot = HTMLElement & { [OPEN_LAYERS]?: number };

/**
 * Marks the document while a layer that fills the window's content is open
 * (a full-window artifact or Site, the maximized or overlay workspace):
 * `html[data-window-layer-open]`. A host's window chrome, such as the macOS
 * app's sidebar toggle in the window bar, can then step aside from a `data-*`
 * attribute instead of a document-wide `:has()`, which restyles the whole
 * page on every DOM change. Every layer that marks itself `data-window-layer`
 * and fills the window's content calls this. Layers are counted, so nested
 * ones are safe.
 */
export function useWindowLayerOpen(open: boolean): void {
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement as CountedRoot;
    root[OPEN_LAYERS] = (root[OPEN_LAYERS] ?? 0) + 1;
    root.setAttribute("data-window-layer-open", "");
    return () => {
      const left = Math.max(0, (root[OPEN_LAYERS] ?? 1) - 1);
      root[OPEN_LAYERS] = left;
      if (left === 0) root.removeAttribute("data-window-layer-open");
    };
  }, [open]);
}
