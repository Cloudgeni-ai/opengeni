import {
  SITE_GATEWAY_CALLBACK_PATH,
  SITE_GATEWAY_LOGIN_PATH,
  SITE_LOGIN_COOKIE,
  SITE_SESSION_COOKIE,
  type SiteAuthExchangeRequest,
} from "@opengeni/contracts";
import {
  LOGIN_COOKIE_MAX_AGE,
  SITE_HUMAN_COOKIE,
  clearCookie,
  isSessionToken,
  loginCookie,
  readLogin,
  sessionCookie,
} from "./cookies";
import { base64url, randomToken, sha256, timingSafeEqual, utf8 } from "./crypto";
import { applySecurityHeaders } from "./headers";
import { logoutConfirmPage, messagePage } from "./pages";
import { safeReturnPath } from "./return-path";
import { signedApiRequest } from "./signing";
import { isSameOriginRequest, siteCaller, type SiteContext } from "./site-context";

/** Upper bound for the session cookie lifetime; the API's absolute limit is 7 days. */
export const SESSION_COOKIE_MAX_AGE_CAP = 7 * 24 * 60 * 60;

export function redirect(
  site: Pick<SiteContext, "hsts" | "noindex">,
  location: string,
  status: 302 | 303 = 302,
  cookies: readonly string[] = [],
): Response {
  const headers = applySecurityHeaders(new Headers(), { noindex: true, hsts: site.hsts });
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

/** `/_og/auth/login?return=<path>` for the current request path. */
export function loginLocation(url: URL): string {
  const returnPath = safeReturnPath(`${url.pathname}${url.search}`) ?? "/";
  return `${SITE_GATEWAY_LOGIN_PATH}?return=${encodeURIComponent(returnPath)}`;
}

/** PKCE S256 challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(utf8(verifier)));
}

/**
 * GET /_og/auth/login: mint state and a PKCE verifier, keep them signed in
 * `__Host-og_login` for ten minutes, and send the viewer to the app's
 * `/site-auth/authorize` page.
 */
export async function handleLogin(site: SiteContext): Promise<Response> {
  if (site.request.method !== "GET" && site.request.method !== "HEAD")
    return messagePage(site, 405, "Not allowed", "Use a link to sign in.");
  const returnPath = safeReturnPath(site.url.searchParams.get("return")) ?? "/";
  const state = randomToken(32);
  const verifier = randomToken(32);
  const target = new URL("/site-auth/authorize", site.config.appOrigin);
  target.searchParams.set("host", site.hostname);
  target.searchParams.set("state", state);
  target.searchParams.set("code_challenge", await pkceChallenge(verifier));
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("redirect_uri", `${site.siteOrigin}${SITE_GATEWAY_CALLBACK_PATH}`);
  target.searchParams.set("return", returnPath);
  return redirect(site, target.toString(), 302, [
    await loginCookie(site.config.secret, {
      state,
      verifier,
      returnPath,
      host: site.hostname,
      expiresAt: Date.now() + LOGIN_COOKIE_MAX_AGE * 1000,
    }),
  ]);
}

/**
 * GET /_og/auth/callback?code&state: verify state against the login cookie,
 * exchange the one-time code server to server, set `__Host-og_session` and
 * return to the validated same-host path.
 */
export async function handleCallback(site: SiteContext): Promise<Response> {
  if (site.request.method !== "GET")
    return messagePage(site, 405, "Not allowed", "Sign-in returns here with a link.");
  const login = await readLogin(site.config.secret, site.cookies);
  const state = site.url.searchParams.get("state") ?? "";
  const code = site.url.searchParams.get("code") ?? "";
  const retry = {
    href: `${SITE_GATEWAY_LOGIN_PATH}?return=${encodeURIComponent(login?.returnPath ?? "/")}`,
    label: "Sign in again",
  };
  const fail = (status: number, title: string, message: string) => {
    const response = messagePage(site, status, title, message, retry);
    response.headers.append("Set-Cookie", clearCookie(SITE_LOGIN_COOKIE));
    return response;
  };
  if (!login || login.host !== site.hostname || !state || !timingSafeEqual(state, login.state))
    return fail(400, "Sign-in expired", "This sign-in link is no longer valid. Try again.");
  if (site.url.searchParams.has("error"))
    return fail(403, "Sign-in cancelled", "You were not signed in.");
  if (code.length < 16 || code.length > 256)
    return fail(400, "Sign-in failed", "The sign-in response was incomplete. Try again.");
  const exchange: SiteAuthExchangeRequest = {
    code,
    codeVerifier: login.verifier,
    redirectUri: `${site.siteOrigin}${SITE_GATEWAY_CALLBACK_PATH}`,
  };
  let response: Response;
  try {
    response = await fetch(
      await signedApiRequest(
        site.config,
        { ...siteCaller(site), session: "" },
        {
          method: "POST",
          suffix: "/auth/exchange",
          body: utf8(JSON.stringify(exchange)),
          headers: new Headers({ "content-type": "application/json", accept: "application/json" }),
        },
      ),
    );
  } catch {
    return fail(502, "Sign-in unavailable", "Signing in is temporarily unavailable. Try again.");
  }
  if (response.status === 403) {
    await response.body?.cancel();
    return fail(403, "No access", "Your account does not have access to this Site.");
  }
  if (!response.ok) {
    await response.body?.cancel();
    return response.status >= 500
      ? fail(502, "Sign-in unavailable", "Signing in is temporarily unavailable. Try again.")
      : fail(400, "Sign-in expired", "This sign-in link is no longer valid. Try again.");
  }
  const body = (await response.json().catch(() => null)) as {
    sessionToken?: unknown;
    expiresAt?: unknown;
  } | null;
  const expiresAt = typeof body?.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
  const maxAge = Math.min(Math.floor((expiresAt - Date.now()) / 1000), SESSION_COOKIE_MAX_AGE_CAP);
  if (!isSessionToken(body?.sessionToken) || !Number.isFinite(maxAge) || maxAge <= 0)
    return fail(502, "Sign-in failed", "The sign-in response was invalid. Try again.");
  return redirect(site, `${site.siteOrigin}${safeReturnPath(login.returnPath) ?? "/"}`, 303, [
    sessionCookie(body.sessionToken, maxAge),
    clearCookie(SITE_LOGIN_COOKIE),
  ]);
}

/**
 * /_og/auth/logout: GET only shows a confirmation form, so a link or an
 * embedded image can never sign anyone out. The same-origin POST revokes the
 * site session at the API (best effort) and clears it.
 */
export async function handleLogout(site: SiteContext): Promise<Response> {
  const method = site.request.method;
  const returnPath = safeReturnPath(site.url.searchParams.get("return")) ?? "/";
  if (method === "GET" || method === "HEAD") return logoutConfirmPage(site, returnPath);
  if (method !== "POST") return messagePage(site, 405, "Not allowed", "Use the sign-out button.");
  if (!isSameOriginRequest(site.request, site.siteOrigin))
    return messagePage(site, 403, "Not allowed", "Sign out from this Site's own page.");
  if (site.session) {
    try {
      const response = await fetch(
        await signedApiRequest(site.config, siteCaller(site), {
          method: "POST",
          suffix: "/auth/logout",
        }),
      );
      await response.body?.cancel();
    } catch {
      // The cookie is cleared regardless; the API session expires on its own.
    }
  }
  return redirect(site, `${site.siteOrigin}${returnPath}`, 303, [
    clearCookie(SITE_SESSION_COOKIE),
    clearCookie(SITE_HUMAN_COOKIE),
  ]);
}
