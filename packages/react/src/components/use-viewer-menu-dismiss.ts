import { useEffect, useRef } from "react";

/** Keep native details menus dismissible without letting Escape close the dock. */
export function useViewerMenuDismiss(enabled = true) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const menu = ref.current;
    if (!enabled || !menu) return;
    const document = menu.ownerDocument;
    const pointerDown = (event: PointerEvent) => {
      if (menu.open && !event.composedPath().includes(menu)) menu.open = false;
    };
    const focusIn = (event: FocusEvent) => {
      if (menu.open && !event.composedPath().includes(menu)) menu.open = false;
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!menu.open || event.key !== "Escape" || !event.composedPath().includes(menu)) return;
      event.preventDefault();
      event.stopPropagation();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("focusin", focusIn, true);
    document.addEventListener("keydown", keyDown, true);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("focusin", focusIn, true);
      document.removeEventListener("keydown", keyDown, true);
    };
  }, [enabled]);
  return ref;
}
