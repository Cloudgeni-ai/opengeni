import type { KeyboardEvent } from "react";
import { interactionHostPlatform, type InteractionHostPlatform } from "../lib/host-platform";

export const HUMAN_BROWSER_HOME_URL = "https://www.google.com/";
const HUMAN_BROWSER_SEARCH_URL = "https://www.google.com/search?q=";

/** Apply browser-style omnibox behavior: navigate hosts, search ordinary text. */
export function normalizeBrowserAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^(?:https?|about):/iu.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return ["http:", "https:", "about:"].includes(url.protocol) ? url.href : null;
    } catch {
      return `${HUMAN_BROWSER_SEARCH_URL}${encodeURIComponent(trimmed)}`;
    }
  }

  const isLocal = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/iu.test(
    trimmed,
  );
  const looksLikeHost =
    !/\s/u.test(trimmed) &&
    (isLocal || /^(?:[^./\s]+\.)+[^./\s]+(?::\d+)?(?:[/?#]|$)/u.test(trimmed));
  if (!looksLikeHost) return `${HUMAN_BROWSER_SEARCH_URL}${encodeURIComponent(trimmed)}`;

  try {
    return new URL(`${isLocal ? "http" : "https"}://${trimmed}`).href;
  } catch {
    return `${HUMAN_BROWSER_SEARCH_URL}${encodeURIComponent(trimmed)}`;
  }
}

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
