import { createHash, randomBytes } from "node:crypto";

import { OPENGENI_DESKTOP_APP_HEADER } from "@opengeni/contracts";
import {
  managedHumanSubjectForRequest,
  type AccessDeps,
  type AccessGrantAuthorization,
} from "@opengeni/core";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";

/**
 * Binds an integration OAuth state to the person who started it (CASA 3.2.2),
 * so a consent link sent to someone else cannot connect their account to the
 * starter's workspace.
 *
 * - `cookie`: started from a signed-in browser. The start response sets a
 *   random HttpOnly cookie and the state carries its SHA-256; the callback must
 *   arrive in a browser holding that cookie.
 * - `session`: started by a person outside the consent browser (the desktop
 *   app, whose sign-ins finish in the person's own browser, or a native app
 *   credential). The callback browser must be signed in to Opengeni as that
 *   same person.
 * - `none`: no Opengeni sign-in started it: API keys, services, and host
 *   products using delegated tokens or acting for their own external users.
 *   Those credentials are issued to the host's server, which is the authority
 *   for which of its users finishes the consent.
 *
 * A state without a proof predates this check and is honoured for its normal
 * ten-minute life during a rolling deployment.
 */
export type OAuthBrowserProof = "cookie" | "session" | "none";

export type OAuthStateBrowserBinding = {
  browserProof: OAuthBrowserProof;
  /** SHA-256 (hex) of the binding cookie, for `cookie`. */
  browserBinding?: string;
};

export type OAuthCallbackBrowser = {
  /** SHA-256 (hex) of each binding cookie the callback request carried. */
  bindingDigests: readonly string[];
  /** The `user:` person the callback browser is signed in as, if any. */
  signedInSubjectId: string | null;
};

export const OAUTH_BROWSER_BINDING_COOKIE = "opengeni_oauth_binding";
/**
 * On https the cookie is host-only (`__Host-`, Path=/), so a page on a sibling
 * subdomain cannot plant its own binding value in someone else's browser.
 */
export const OAUTH_BROWSER_BINDING_SECURE_COOKIE = `__Host-${OAUTH_BROWSER_BINDING_COOKIE}`;
export const OAUTH_BROWSER_MISMATCH_MESSAGE =
  "This connection was started in another browser or by another person";
/** Longer than a state's ten minutes, so a slow consent page never outlives it. */
const OAUTH_BROWSER_BINDING_MAX_AGE_SECONDS = 60 * 60;
const BINDING_VALUE = /^[A-Za-z0-9_-]{43}$/;

export function oauthBrowserBindingDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function bindingCookieName(secure: boolean): string {
  return secure ? OAUTH_BROWSER_BINDING_SECURE_COOKIE : OAUTH_BROWSER_BINDING_COOKIE;
}

function bindingCookieValues(c: Context, secure: boolean): string[] {
  const prefix = `${bindingCookieName(secure)}=`;
  return (c.req.header("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => part.slice(prefix.length))
    .filter((value) => BINDING_VALUE.test(value));
}

function secureRequest(c: Context, settings: AccessDeps["settings"]): boolean {
  return (
    settings.publicBaseUrl?.startsWith("https://") === true ||
    c.req.header("x-forwarded-proto") === "https" ||
    new URL(c.req.url).protocol === "https:"
  );
}

/**
 * Decide how this OAuth start proves its callback, and for a browser start set
 * (or refresh) the binding cookie on the response. One browser keeps one value,
 * so several connections started side by side all finish.
 */
export function oauthBrowserBindingForStart(
  c: Context,
  settings: AccessDeps["settings"],
  authorization: Pick<AccessGrantAuthorization, "grant" | "canonicalManagedHumanSession">,
  options: { externalContinuation?: unknown },
): OAuthStateBrowserBinding {
  if (
    options.externalContinuation ||
    !authorization.canonicalManagedHumanSession ||
    !authorization.grant.subjectId.startsWith("user:")
  )
    return { browserProof: "none" };
  // The desktop app's consent finishes in the person's own browser, and a
  // native app credential arrives as a bearer: neither browser holds a cookie
  // set on this response.
  const browserCookieSession =
    !c.req.header("authorization") && !c.req.header(OPENGENI_DESKTOP_APP_HEADER);
  if (!browserCookieSession) return { browserProof: "session" };
  const secure = secureRequest(c, settings);
  const value = bindingCookieValues(c, secure)[0] ?? randomBytes(32).toString("base64url");
  setCookie(c, bindingCookieName(secure), value, {
    httpOnly: true,
    sameSite: "Lax",
    secure,
    path: secure ? "/" : "/v1",
    maxAge: OAUTH_BROWSER_BINDING_MAX_AGE_SECONDS,
  });
  return { browserProof: "cookie", browserBinding: oauthBrowserBindingDigest(value) };
}

/** What the callback request can prove about its browser. */
export async function oauthCallbackBrowser(
  c: Context,
  deps: AccessDeps,
): Promise<OAuthCallbackBrowser> {
  return {
    bindingDigests: bindingCookieValues(c, secureRequest(c, deps.settings)).map(
      oauthBrowserBindingDigest,
    ),
    signedInSubjectId: await managedHumanSubjectForRequest(c, deps),
  };
}

/** Read a signed state's binding fields; anything malformed is not a proof. */
export function oauthStateBrowserBinding(
  payload: Record<string, unknown>,
): OAuthStateBrowserBinding | undefined {
  const proof = payload.browserProof;
  if (proof === "none" || proof === "session") return { browserProof: proof };
  if (proof === "cookie") {
    const digest = payload.browserBinding;
    // A cookie proof without a well-formed digest can never be met.
    return {
      browserProof: "cookie",
      browserBinding: typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest) ? digest : "",
    };
  }
  return undefined;
}

/**
 * Whether the callback browser may finish this state. False means the consent
 * happened in a browser other than the starter's, or a different person is
 * signed in there.
 */
export function oauthCallbackBrowserAccepted(
  state: { subjectId: string } & Partial<OAuthStateBrowserBinding>,
  browser: OAuthCallbackBrowser | undefined,
): boolean {
  switch (state.browserProof) {
    case undefined:
    case "none":
      return true;
    case "cookie":
      return (
        Boolean(state.browserBinding) &&
        Boolean(browser?.bindingDigests.includes(state.browserBinding!))
      );
    case "session":
      return browser?.signedInSubjectId === state.subjectId;
    default:
      return false;
  }
}
