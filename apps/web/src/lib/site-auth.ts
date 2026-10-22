import {
  SITE_GATEWAY_CALLBACK_PATH,
  parseSiteHostname,
  siteHostname,
  type SiteAuthAuthorizeRequest,
} from "@opengeni/contracts";

/**
 * /site-auth/authorize: where a published Site's gateway sends a viewer to
 * sign in. The query carries the Site host, the gateway's state and PKCE
 * challenge, and its callback. None of it is a credential; the one-time code
 * the API mints goes only to the callback on that same host, which must be a
 * Site under the deployment's Sites domain.
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

/**
 * The Site host when it is a canonical `<label>.<sites domain>` name, else
 * null. Without a configured Sites domain nothing qualifies.
 */
export function siteHostUnderDomain(
  host: string | undefined,
  sitesDomain: string | null | undefined,
): string | null {
  if (!host || !sitesDomain) return null;
  const normalized = host.trim().toLowerCase();
  let label: string | null;
  try {
    label = parseSiteHostname(normalized, sitesDomain);
  } catch {
    return null;
  }
  if (!label) return null;
  // Exactly the canonical name: no port, no trailing dot.
  return siteHostname(label, sitesDomain) === normalized ? normalized : null;
}

/**
 * The gateway's callback on a Site host under the Sites domain
 * (`https://<host>/_og/auth/callback`, any query), or null for anything else.
 */
export function siteCallbackUrl(
  redirectUri: string | undefined,
  host: string,
  sitesDomain: string | null | undefined,
): URL | null {
  if (!redirectUri) return null;
  const siteHost = siteHostUnderDomain(host, sitesDomain);
  if (!siteHost) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port)
    return null;
  if (url.hostname !== siteHost) return null;
  return url.pathname === SITE_GATEWAY_CALLBACK_PATH ? url : null;
}

/** The authorize request for a well-formed query on a Site under the Sites domain, else null. */
export function siteAuthRequest(
  search: SiteAuthSearch,
  sitesDomain: string | null | undefined,
): SiteAuthAuthorizeRequest | null {
  const host = siteHostUnderDomain(search.host, sitesDomain);
  if (!host) return null;
  if (!search.state || search.state.length < 16 || search.state.length > 256) return null;
  if (!search.code_challenge || !/^[A-Za-z0-9_-]{43}$/u.test(search.code_challenge)) return null;
  if (search.code_challenge_method !== "S256") return null;
  const callback = siteCallbackUrl(search.redirect_uri, host, sitesDomain);
  if (!callback || callback.search) return null;
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
  sitesDomain: string | null | undefined,
): string | null {
  const target = siteCallbackUrl(redirectTo, request.host, sitesDomain);
  const expected = new URL(request.redirectUri);
  if (!target || target.origin !== expected.origin || target.pathname !== expected.pathname)
    return null;
  return target.toString();
}

/**
 * Where "Back to the Site" goes once the API has confirmed the Site: the
 * gateway's callback with access_denied, so the Site can say so. Null when
 * the callback is not on a Site under the Sites domain.
 */
export function siteAuthCancelUrl(
  request: SiteAuthAuthorizeRequest,
  sitesDomain: string | null | undefined,
): string | null {
  const url = siteCallbackUrl(request.redirectUri, request.host, sitesDomain);
  if (!url) return null;
  url.search = "";
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("state", request.state);
  return url.toString();
}

/**
 * True when this window is framed. The sign-in page refuses to render (or
 * call the API) inside another page, so it can't be clickjacked.
 */
export function isFramedWindow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.top !== window.self;
  } catch {
    // A cross-origin parent that hides `top` is still a parent.
    return true;
  }
}
