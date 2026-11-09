import { localAllowedOriginEntries, type Settings } from "@opengeni/config";
import type { AccessGrantAuthorization } from "@opengeni/core";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { allowedCorsOrigin } from "../http/cors";
import { trustedBrowserOrigins } from "../http/browser-mutation-origin";
import { integrationBaseUrl } from "./oauth-client";

type ReturnOriginSettings = Pick<
  Settings,
  | "publicBaseUrl"
  | "webBaseUrl"
  | "betterAuthTrustedOrigins"
  | "corsAllowOriginRegex"
  | "localAllowedOrigins"
  | "sitesDomain"
>;

/**
 * Whether a connect return URL lands on one of this deployment's own browser
 * origins: the API and web base URLs, trusted auth origins, the cookie-CORS
 * allowlist, local-mode origins, and published Sites.
 */
export function trustedConnectReturnOrigin(
  settings: ReturnOriginSettings,
  target: URL,
  requestUrl: string,
): boolean {
  const origin = target.origin;
  if (origin === "null") return false;
  const own = new Set(trustedBrowserOrigins(settings));
  try {
    for (const entry of localAllowedOriginEntries(settings.localAllowedOrigins)) own.add(entry);
  } catch {
    // A malformed local-mode list trusts nothing extra.
  }
  try {
    own.add(new URL(integrationBaseUrl(settings.publicBaseUrl, requestUrl)).origin);
  } catch {
    // An unusable request URL adds nothing.
  }
  if (own.has(origin)) return true;
  try {
    if (allowedCorsOrigin(settings.corsAllowOriginRegex, origin)) return true;
  } catch {
    // A malformed operator pattern trusts nothing extra.
  }
  const sites = settings.sitesDomain
    ?.trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  return Boolean(
    sites &&
    target.protocol === "https:" &&
    (target.hostname === sites || target.hostname.endsWith(`.${sites}`)),
  );
}

/**
 * The open-redirect rule for connect return URLs (CASA 5.1.2). A person signed
 * in through the Opengeni browser session returns only to this deployment's
 * own origins. Host products authenticate with their own keys or delegated
 * tokens and return their users to their own pages, which Opengeni has no
 * registry of, so for them the authenticated host credential is the authority.
 */
export function requireConnectReturnUrl(
  c: Context,
  settings: ReturnOriginSettings,
  authorization: Pick<AccessGrantAuthorization, "canonicalManagedHumanSession">,
  target: URL,
): void {
  const browserSession =
    authorization.canonicalManagedHumanSession && !c.req.header("authorization");
  if (!browserSession || trustedConnectReturnOrigin(settings, target, c.req.url)) return;
  throw new HTTPException(400, {
    message: "returnUrl must be on this Opengeni deployment's own origin",
  });
}
