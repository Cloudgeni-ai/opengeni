import { useSyncExternalStore } from "react";

/**
 * Where the page that hosts these components lets third-party content load
 * from. Opt-in: with nothing configured, agent-authored HTML renders in a
 * `srcdoc` frame and images load from their own address, as before.
 *
 * A page with a strict Content-Security-Policy (the Opengeni console)
 * configures both:
 * - `htmlFrameHost`: the origin of the HTML frame host page
 *   (`@opengeni/contracts/html-frame-host`), or `self` for the page's own
 *   origin. Agent-authored HTML is rendered
 *   there instead of in a `srcdoc` frame, which would inherit the page's
 *   policy.
 * - `imageProxy`: images from origins the page's `img-src` does not list are
 *   loaded through this same-origin proxy URL (`?url=<image URL>`), so they
 *   still show.
 */
export type ContentHostingConfig = {
  htmlFrameHost?: string | null;
  imageProxy?: {
    /** Absolute or root-relative proxy endpoint, called with `?url=`. */
    url: string;
    /** Origins (`https://host[:port]`) the page loads images from directly. */
    directOrigins: readonly string[];
  } | null;
};

let current: ContentHostingConfig = {};
const listeners = new Set<() => void>();

/** Configure content hosting for every component on this page. */
export function configureContentHosting(config: ContentHostingConfig): void {
  current = { ...config };
  for (const listener of listeners) listener();
}

export function contentHosting(): ContentHostingConfig {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useContentHosting(): ContentHostingConfig {
  return useSyncExternalStore(subscribe, contentHosting, contentHosting);
}

/**
 * The address to load an image from on this page: the image itself when it
 * is same-origin, inline (`data:`/`blob:`), relative, or from a direct
 * origin; otherwise the configured proxy.
 */
export function displayImageSrc(
  src: string,
  config: ContentHostingConfig = current,
  pageOrigin: string | undefined = typeof window === "undefined"
    ? undefined
    : window.location.origin,
): string {
  const proxy = config.imageProxy;
  if (!proxy || !src) return src;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    // Relative: resolved against the page itself.
    return src;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return src;
  if (url.origin === pageOrigin) return src;
  // Browsers upgrade http images on https pages; the proxy only fetches https.
  if (url.protocol === "http:") url.protocol = "https:";
  if (proxy.directOrigins.includes(url.origin)) return src;
  const separator = proxy.url.includes("?") ? "&" : "?";
  return `${proxy.url}${separator}url=${encodeURIComponent(url.toString())}`;
}

/** `displayImageSrc` for a component, following configuration changes. */
export function useDisplayImageSrc<T extends string | null | undefined>(src: T): T {
  const config = useContentHosting();
  if (typeof src !== "string") return src;
  return displayImageSrc(src, config) as T;
}
