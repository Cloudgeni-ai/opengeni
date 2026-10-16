import { SITE_GATEWAY_PREFIX } from "@opengeni/contracts";

const BASE = "https://return-path.invalid";

/**
 * A same-origin relative path to send the viewer back to, or null. Refuses
 * absolute and protocol-relative URLs, backslashes, control characters and
 * gateway-owned `/_og` paths (no redirect loops through sign-in).
 */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, BASE);
  } catch {
    return null;
  }
  if (url.origin !== BASE) return null;
  if (url.pathname === SITE_GATEWAY_PREFIX || url.pathname.startsWith(`${SITE_GATEWAY_PREFIX}/`))
    return null;
  const path = `${url.pathname}${url.search}`;
  return path.startsWith("//") ? null : path;
}
