import { SITE_GATEWAY_CALLBACK_PATH, type SiteAuthAuthorizeRequest } from "@opengeni/contracts";

/**
 * /site-auth/authorize: where a published Site's gateway sends a viewer to
 * sign in. The query carries the Site host, the gateway's state and PKCE
 * challenge, and its callback. None of it is a credential; the one-time code
 * the API mints goes only to the callback on that same host.
 */
export type SiteAuthSearch = {
  host?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  redirect_uri?: string;
  return?: string;
};

const KEYS = [
  "host",
  "state",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "return",
] as const;

export function siteAuthSearch(search: Record<string, unknown>): SiteAuthSearch {
  const result: SiteAuthSearch = {};
  for (const key of KEYS) {
    const value = search[key];
    if (typeof value === "string" && value && value.length <= 2048) result[key] = value;
  }
  return result;
}

function loopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1";
}

/** The gateway's callback on the Site host, or null for anything else. */
export function siteCallbackUrl(redirectUri: string | undefined, host: string): URL | null {
  if (!redirectUri) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && loopback(url.hostname));
  if (!secure || url.username || url.password || url.hash) return null;
  if (url.host.toLowerCase() !== host.toLowerCase()) return null;
  return url.pathname === SITE_GATEWAY_CALLBACK_PATH ? url : null;
}

/** The authorize request for a well-formed query, else null. */
export function siteAuthRequest(search: SiteAuthSearch): SiteAuthAuthorizeRequest | null {
  const host = search.host?.trim().toLowerCase();
  if (!host || host.length > 253 || !/^[a-z0-9.-]+(?::\d{1,5})?$/u.test(host)) return null;
  if (!search.state || search.state.length < 16 || search.state.length > 256) return null;
  if (!search.code_challenge || !/^[A-Za-z0-9_-]{43}$/u.test(search.code_challenge)) return null;
  if (search.code_challenge_method !== "S256") return null;
  const callback = siteCallbackUrl(search.redirect_uri, host);
  if (!callback) return null;
  return {
    host,
    state: search.state,
    codeChallenge: search.code_challenge,
    codeChallengeMethod: "S256",
    redirectUri: callback.toString(),
  };
}

/** Navigate only to the callback the request named, with the API's code appended. */
export function safeSiteRedirect(
  redirectTo: string,
  request: SiteAuthAuthorizeRequest,
): string | null {
  const target = siteCallbackUrl(redirectTo, request.host);
  const expected = new URL(request.redirectUri);
  if (!target || target.origin !== expected.origin || target.pathname !== expected.pathname)
    return null;
  return target.toString();
}

/** Where Cancel goes: the gateway's callback with access_denied, so the Site can say so. */
export function siteAuthCancelUrl(request: SiteAuthAuthorizeRequest): string {
  const url = new URL(request.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("state", request.state);
  return url.toString();
}
