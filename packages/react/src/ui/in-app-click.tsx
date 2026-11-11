import type { MouseEvent } from "react";

/**
 * For an `<a href>` that points inside the app: a plain left click calls `go`
 * (the router) instead of loading the page; modified clicks (new tab, new
 * window) and clicks another handler already took keep the browser default.
 */
export function inAppClick(go: () => void) {
  return (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    go();
  };
}
