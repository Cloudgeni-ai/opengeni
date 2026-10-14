import { humanCookie } from "./cookies";
import { applySecurityHeaders, jsonError } from "./headers";
import { isSameOriginRequest, type SiteContext } from "./site-context";
import { readBodyCapped } from "./api";

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * POST /_og/human (only when TURNSTILE_SITE_KEY and TURNSTILE_SECRET are
 * set): verify a Turnstile token with siteverify and set the signed,
 * short-lived `__Host-og_h` cookie for this visitor. Forwarded API calls then
 * carry the human flag "1".
 */
export async function handleHumanCheck(
  site: SiteContext,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const security = { noindex: true, hsts: site.hsts };
  const turnstile = site.config.turnstile;
  if (!turnstile) return jsonError(404, { code: "not_found", message: "Not found" }, security);
  if (site.request.method !== "POST")
    return jsonError(405, { code: "method_not_allowed", message: "Use POST" }, security);
  if (!isSameOriginRequest(site.request, site.siteOrigin))
    return jsonError(403, { code: "site_cross_origin", message: "Not allowed" }, security);
  if (!site.visitor)
    return jsonError(400, { code: "site_visitor_required", message: "Reload the page" }, security);
  const body = await readBodyCapped(site.request, 4096);
  let token = "";
  if (body !== "too_large") {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(body)) as { token?: unknown };
      if (typeof parsed.token === "string") token = parsed.token;
    } catch {
      token = "";
    }
  }
  if (!token || token.length > 2048)
    return jsonError(400, { code: "site_human_check_failed", message: "Try again" }, security);
  const form = new FormData();
  form.set("secret", turnstile.secret);
  form.set("response", token);
  if (site.clientIp) form.set("remoteip", site.clientIp);
  let verified = false;
  try {
    const response = await fetchImpl(TURNSTILE_VERIFY_URL, { method: "POST", body: form });
    const result = (await response.json()) as { success?: unknown; hostname?: unknown };
    verified =
      result.success === true &&
      (typeof result.hostname !== "string" || result.hostname === site.hostname);
  } catch {
    verified = false;
  }
  if (!verified)
    return jsonError(
      403,
      { code: "site_human_check_failed", message: "The check did not pass; try again" },
      security,
    );
  const headers = applySecurityHeaders(new Headers(), security);
  headers.set("Cache-Control", "no-store");
  headers.append("Set-Cookie", await humanCookie(site.config.secret, site.hostname, site.visitor));
  return new Response(null, { status: 204, headers });
}
