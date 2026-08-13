import type { KeyboardEvent } from "react";
import { interactionHostPlatform, type InteractionHostPlatform } from "../lib/host-platform";

/** Translate executable keyboard chords for the BrowserSession action API. */
export function browserKey(
  event: Pick<
    KeyboardEvent<HTMLTextAreaElement>,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >,
  hostPlatform: InteractionHostPlatform = interactionHostPlatform(),
): string | null {
  // Modifier keydowns precede the actual chord key. They are not executable
  // browser actions by themselves (for example Meta+Meta is invalid CDP input).
  if (["Alt", "AltGraph", "Control", "Meta", "Shift"].includes(event.key)) return null;
  const special = new Set([
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ]);
  const modified = event.altKey || event.ctrlKey || event.metaKey;
  if (!modified && !special.has(event.key)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push(hostPlatform === "mac" ? "Control" : "Mod");
  if (event.altKey) parts.push("Alt");
  if (event.metaKey) parts.push(hostPlatform === "mac" ? "Mod" : "Meta");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.key === " " ? "Space" : event.key);
  return parts.join("+");
}
