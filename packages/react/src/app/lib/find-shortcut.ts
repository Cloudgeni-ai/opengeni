import { useEffect } from "react";

/**
 * Ctrl/⌘+F opens the conversation's find while key events reach `scope`.
 * A page chat listens on the window; an embedded app or a chat in a panel
 * beside another view listens on its own element, so it takes the shortcut
 * only while focus is inside it and the rest of the page (and the browser)
 * keeps its own find. A null scope (a panel not mounted yet) takes nothing.
 */
export function useFindShortcut(input: { scope: EventTarget | null }, open: () => void): void {
  const { scope } = input;
  useEffect(() => {
    if (!scope) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== "f"
      )
        return;
      const target = event.target;
      // Dialogs and embedded editors own their own keyboard search behavior.
      if (
        target instanceof Element &&
        target.closest('[role="dialog"], .cm-editor, .xterm, [data-native-find]')
      )
        return;
      event.preventDefault();
      open();
    };
    scope.addEventListener("keydown", onKeyDown as EventListener);
    return () => scope.removeEventListener("keydown", onKeyDown as EventListener);
  }, [open, scope]);
}
