import { useEffect, useRef, useState } from "react";

function documentForeground(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * True while this page is visible and its window has focus. A page left open
 * in a background tab, behind another window, or (in an iframe) while focus is
 * elsewhere is not in the foreground.
 */
export function useDocumentForeground(): boolean {
  const [foreground, setForeground] = useState(documentForeground);
  useEffect(() => {
    const update = () => setForeground(documentForeground());
    update();
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    window.addEventListener("pageshow", update);
    window.addEventListener("pagehide", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      window.removeEventListener("pageshow", update);
      window.removeEventListener("pagehide", update);
    };
  }, []);
  return foreground;
}

/**
 * True while the resolved element is rendered and intersects the viewport. An
 * element that a host hides (`display: none`, a collapsed panel, a closed
 * drawer moved off screen) or that is not rendered at all is not on screen.
 * `resolve` runs again whenever `refreshKey` changes (for example when the
 * element may have been replaced).
 */
export function useElementOnScreen(resolve: () => Element | null, refreshKey: unknown): boolean {
  const [onScreen, setOnScreen] = useState(false);
  const resolveRef = useRef(resolve);
  resolveRef.current = resolve;
  useEffect(() => {
    const element = resolveRef.current();
    if (!element) {
      setOnScreen(false);
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      // No observer (old engines, some test DOMs): a rendered element counts.
      setOnScreen(element.getClientRects().length > 0);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const latest = entries[entries.length - 1];
      if (latest) setOnScreen(latest.isIntersecting);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      setOnScreen(false);
    };
  }, [refreshKey]);
  return onScreen;
}
