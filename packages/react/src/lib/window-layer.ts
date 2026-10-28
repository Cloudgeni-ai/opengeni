import { useEffect, useLayoutEffect } from "react";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

let openLayers = 0;

/**
 * Marks the document while a layer that fills the window's content is open
 * (a full-window artifact or Site, the maximized or overlay workspace):
 * `html[data-window-layer-open]`. A host's window chrome, such as the macOS
 * app's sidebar toggle in the window bar, can then step aside from a `data-*`
 * attribute instead of a document-wide `:has()`, which restyles the whole
 * page on every DOM change. Layers are counted, so nested ones are safe.
 */
export function useWindowLayerOpen(open: boolean): void {
  useIsomorphicLayoutEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    openLayers += 1;
    root.setAttribute("data-window-layer-open", "");
    return () => {
      openLayers -= 1;
      if (openLayers === 0) root.removeAttribute("data-window-layer-open");
    };
  }, [open]);
}
