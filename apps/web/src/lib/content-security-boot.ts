// The console's side of its Content-Security-Policy (see apps/web/src/csp.ts).
// main.tsx imports this first.
import {
  configureContentHosting,
  type ContentHostingConfig,
} from "@opengeni/react/app/lib/content-hosting";

/** The element the web server writes the page's content hosting into. */
export const CONTENT_HOSTING_ELEMENT_ID = "opengeni-content-hosting";

/**
 * Zod compiles object parsers with `new Function` after probing whether the
 * page allows it. The console's policy has no 'unsafe-eval', so the probe only
 * produces a `securitypolicyviolation`; skip it (and the compiled path) with
 * Zod's shared global configuration, which every Zod copy on the page reads.
 */
export function disableZodJit(target: typeof globalThis = globalThis): void {
  const holder = target as { __zod_globalConfig?: { jitless?: boolean } };
  holder.__zod_globalConfig ??= {};
  holder.__zod_globalConfig.jitless = true;
}

/**
 * The content hosting the web server wrote into the page, matching its
 * policy: the HTML frame host, and which image origins load directly. A page
 * without it (the Vite dev server, a static host) keeps the defaults.
 */
export function readContentHosting(document: Document): ContentHostingConfig | null {
  const text = document.getElementById(CONTENT_HOSTING_ELEMENT_ID)?.textContent;
  if (!text) return null;
  try {
    const value = JSON.parse(text) as {
      htmlFrameHost?: unknown;
      imageProxy?: { url?: unknown; directOrigins?: unknown } | null;
    };
    const config: ContentHostingConfig = {};
    if (typeof value.htmlFrameHost === "string" && value.htmlFrameHost) {
      config.htmlFrameHost = value.htmlFrameHost;
    }
    const proxy = value.imageProxy;
    if (
      proxy &&
      typeof proxy.url === "string" &&
      Array.isArray(proxy.directOrigins) &&
      proxy.directOrigins.every((origin) => typeof origin === "string")
    ) {
      config.imageProxy = { url: proxy.url, directOrigins: proxy.directOrigins as string[] };
    }
    return config;
  } catch {
    return null;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  disableZodJit();
  const config = readContentHosting(document);
  if (config) configureContentHosting(config);
}
