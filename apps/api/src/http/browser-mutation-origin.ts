import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ApiRouteDeps } from "@opengeni/core";
import { isAgentActingAsPerson } from "./acting-person";

type TrustedBrowserOriginSettings = Pick<
  ApiRouteDeps["settings"],
  "publicBaseUrl" | "webBaseUrl" | "betterAuthTrustedOrigins"
>;

/**
 * The browser origins an operator has configured for this deployment: the
 * public base URL, the web base URL and every trusted auth origin. A
 * deployment reachable under more than one hostname lists the extra ones as
 * trusted auth origins, so a person signed in on any of them can also change
 * their own settings there.
 */
export function trustedBrowserOrigins(settings: TrustedBrowserOriginSettings): string[] {
  const origins = new Set<string>();
  for (const candidate of [
    settings.publicBaseUrl,
    settings.webBaseUrl,
    ...(settings.betterAuthTrustedOrigins ?? "").split(","),
  ]) {
    if (!candidate?.trim()) continue;
    try {
      const origin = new URL(candidate.trim()).origin;
      if (origin !== "null") origins.add(origin);
    } catch {
      continue;
    }
  }
  return [...origins];
}

/**
 * The one browser-origin rule for cookie-authenticated state changes (model
 * and subscription connections, organization settings, site publishing).
 *
 * Managed and configured access modes accept only a JSON request whose
 * `Origin` is one of the deployment's trusted browser origins and whose fetch
 * metadata says `same-origin`. Local access mode (the `bun run dev` stack) has no public
 * base URL and serves the web app and the API on different loopback ports,
 * so it accepts this stack's own browser origin instead, as the local
 * browser boundary does.
 */
export function requireSameOriginBrowserMutation(c: Context, deps: ApiRouteDeps): void {
  // Built in process for an agent acting as a person: no browser credentials
  // ride along, so there is no cross-site request to guard against.
  if (isAgentActingAsPerson(c)) return;
  const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HTTPException(403, {
      message: "JSON browser request required",
    });
  }
  if (deps.settings.productAccessMode !== "local" && !deps.settings.publicBaseUrl) {
    throw new HTTPException(503, {
      message: "managed browser origin is not configured",
    });
  }
  const origin = c.req.header("origin");
  const localOriginMatches =
    deps.settings.productAccessMode === "local" && localBrowserOriginMatchesRequest(c, origin);
  if (
    deps.settings.productAccessMode === "local"
      ? !localOriginMatches
      : !origin || !trustedBrowserOrigins(deps.settings).includes(origin)
  ) {
    throw new HTTPException(403, {
      message: "same-origin browser request required",
    });
  }
  const fetchSite = c.req.header("sec-fetch-site")?.toLowerCase();
  const localFetchSiteMatches =
    localOriginMatches &&
    (fetchSite === "same-origin" ||
      fetchSite === "same-site" ||
      (fetchSite === "cross-site" && localLoopbackOriginMatchesRequest(c, origin)));
  if (
    deps.settings.productAccessMode === "local"
      ? !localFetchSiteMatches
      : fetchSite !== "same-origin"
  ) {
    throw new HTTPException(403, {
      message: "same-origin fetch metadata required",
    });
  }
}

function localBrowserOriginMatchesRequest(c: Context, value: string | undefined): boolean {
  if (!value) return false;
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  if (
    origin.origin !== value ||
    origin.origin === "null" ||
    (origin.protocol !== "http:" && origin.protocol !== "https:")
  ) {
    return false;
  }

  const forwardedProtocol = c.req.header("x-forwarded-proto")?.trim().toLowerCase();
  const protocol = forwardedProtocol ? `${forwardedProtocol}:` : new URL(c.req.url).protocol;
  if (protocol !== "http:" && protocol !== "https:") return false;
  const forwardedHost = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!forwardedHost || /[\s,/?#@\\]/u.test(forwardedHost)) return false;

  let request: URL;
  try {
    request = new URL(`${protocol}//${forwardedHost}`);
  } catch {
    return false;
  }
  return (
    origin.protocol === request.protocol &&
    (origin.hostname === request.hostname ||
      (isLoopbackHostname(origin.hostname) && isLoopbackHostname(request.hostname)))
  );
}

function localLoopbackOriginMatchesRequest(c: Context, value: string | undefined): boolean {
  if (!value) return false;
  try {
    const origin = new URL(value);
    const forwardedProtocol = c.req.header("x-forwarded-proto")?.trim().toLowerCase();
    const protocol = forwardedProtocol ? `${forwardedProtocol}:` : new URL(c.req.url).protocol;
    const forwardedHost = c.req.header("x-forwarded-host") ?? c.req.header("host");
    if (!forwardedHost || /[\s,/?#@\\]/u.test(forwardedHost)) return false;
    const request = new URL(`${protocol}//${forwardedHost}`);
    return (
      origin.origin === value &&
      origin.protocol === request.protocol &&
      isLoopbackHostname(origin.hostname) &&
      isLoopbackHostname(request.hostname)
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(value: string): boolean {
  return value === "localhost" || value === "[::1]" || /^127(?:\.[0-9]{1,3}){3}$/u.test(value);
}
