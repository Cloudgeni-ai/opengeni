import { localAllowedOriginEntries, type Settings } from "@opengeni/config";

/**
 * Browser boundary for the unauthenticated local product mode.
 *
 * In `local` access mode every request without credentials acts as the local
 * `dev` user, and the default local sandbox runs agent commands on the host.
 * Binding the API to loopback keeps other devices out, but a web page open in
 * the developer's browser can still reach `http://127.0.0.1:<port>`:
 *
 * - any site can send cross-origin requests to it (CORS only hides the
 *   response; a simple POST still runs), and
 * - a DNS-rebinding site can make its own hostname resolve to 127.0.0.1 and
 *   read responses as a same-origin page.
 *
 * The boundary therefore admits a request only when its `Host` names this
 * computer (loopback, the Docker sandbox routes, or an explicitly configured
 * address), and a present `Origin` is this stack's web app, an explicitly
 * configured origin, or the API's own origin. Non-browser clients (the SDK,
 * curl, sandbox callbacks, host-app servers) send no `Origin` and are
 * unaffected. The `Host` port is not compared: a rebinding page controls only
 * the hostname, while local proxies and forwarders legitimately present their
 * own port.
 *
 * It applies only to `local` access mode in the `local` environment (the
 * `bun run dev` stack and manual local runs). Managed and configured access
 * modes, and deployments that set another `OPENGENI_ENVIRONMENT`, keep their
 * existing CORS policy.
 */
export type LocalBrowserBoundarySettings = Pick<
  Settings,
  | "productAccessMode"
  | "environment"
  | "apiHost"
  | "webBaseUrl"
  | "publicBaseUrl"
  | "opengeniMcpUrl"
  | "opengeniMcpInternalUrl"
  | "githubAppManifestBaseUrl"
  | "localAllowedOrigins"
>;

export type LocalBrowserBoundaryRejection = {
  status: 403;
  code: "LOCAL_HOST_NOT_ALLOWED" | "LOCAL_ORIGIN_NOT_ALLOWED";
  message: string;
};

export type LocalBrowserBoundary = {
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedHostnames: ReadonlySet<string>;
  /** Whether a present `Origin` may call the API for a request with this `Host`. */
  originAllowed(origin: string, host: string | null): boolean;
  /** The rejection for this request, or null when the boundary admits it. */
  rejection(request: Request): LocalBrowserBoundaryRejection | null;
};

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"] as const;
/** Docker Desktop's name for the host; Linux sandboxes use the configured bridge route. */
const DOCKER_HOST_ALIASES = ["host.docker.internal"] as const;
/** `apps/web` dev server default when neither base URL is configured. */
const DEFAULT_LOCAL_WEB_ORIGIN = "http://127.0.0.1:3000";
const WILDCARD_BIND_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);

const HOST_NOT_ALLOWED_MESSAGE =
  "The local OpenGeni API only answers requests addressed to this computer. " +
  "To use another address, set it in OPENGENI_WEB_BASE_URL, OPENGENI_PUBLIC_BASE_URL, " +
  "or OPENGENI_LOCAL_ALLOWED_ORIGINS.";
const ORIGIN_NOT_ALLOWED_MESSAGE =
  "The local OpenGeni API has no authentication, so browser requests are accepted only " +
  "from this stack's web app. Add other trusted origins to OPENGENI_LOCAL_ALLOWED_ORIGINS.";

export function localBrowserBoundaryApplies(
  settings: Pick<Settings, "productAccessMode" | "environment">,
): boolean {
  return settings.productAccessMode === "local" && settings.environment === "local";
}

/** Build the boundary, or null when the deployment is not the local dev product. */
export function createLocalBrowserBoundary(
  settings: LocalBrowserBoundarySettings,
): LocalBrowserBoundary | null {
  if (!localBrowserBoundaryApplies(settings)) return null;

  const configuredOrigins = [settings.webBaseUrl, settings.publicBaseUrl]
    .map((value) => parseHttpUrl(value))
    .filter((url): url is URL => url !== null);
  const webOrigins =
    configuredOrigins.length > 0 ? configuredOrigins : [new URL(DEFAULT_LOCAL_WEB_ORIGIN)];
  const extraOrigins = localAllowedOriginEntries(settings.localAllowedOrigins).map(
    (origin) => new URL(origin),
  );

  const allowedOrigins = new Set<string>();
  for (const url of [...webOrigins, ...extraOrigins]) {
    allowedOrigins.add(url.origin);
    // 127.0.0.1, localhost, and [::1] are the same machine and port; the
    // developer may open the printed URL under any of those names.
    if (isLoopbackHostname(url.hostname)) {
      for (const hostname of LOOPBACK_HOSTNAMES) {
        const alias = new URL(url.origin);
        alias.hostname = hostname;
        allowedOrigins.add(alias.origin);
      }
    }
  }

  const allowedHostnames = new Set<string>([...LOOPBACK_HOSTNAMES, ...DOCKER_HOST_ALIASES]);
  for (const url of [...webOrigins, ...extraOrigins]) allowedHostnames.add(url.hostname);
  // The sandbox-visible API route (the Linux Docker bridge address, or a
  // tunnel for a remote sandbox), the worker's internal route, and a tunnel
  // configured for GitHub App callbacks arrive with their own Host.
  for (const value of [
    settings.opengeniMcpUrl,
    settings.opengeniMcpInternalUrl,
    settings.githubAppManifestBaseUrl,
  ]) {
    const url = parseHttpUrl(value?.replaceAll("{workspaceId}", "workspace"));
    if (url) allowedHostnames.add(url.hostname);
  }
  const apiHost = settings.apiHost.trim().toLowerCase();
  if (!WILDCARD_BIND_HOSTS.has(apiHost)) {
    const url = parseHostHeader(
      apiHost.includes(":") && !apiHost.startsWith("[") ? `[${apiHost}]` : apiHost,
    );
    if (url) allowedHostnames.add(url.hostname);
  }

  const hostAllowed = (host: string | null): boolean => {
    const url = host === null ? null : parseHostHeader(host);
    return url !== null && allowedHostnames.has(url.hostname);
  };

  const originAllowed = (origin: string, host: string | null): boolean => {
    const url = parseHttpUrl(origin);
    if (!url || url.origin !== origin.toLowerCase().replace(/\/$/u, "")) return false;
    if (allowedOrigins.has(url.origin)) return true;
    // Pages served by the API itself (for example the MCP OAuth consent form)
    // and same-origin dev proxies present the API's own address. The Host was
    // already checked, so this cannot admit a rebinding hostname.
    const requestHost = host === null ? null : parseHostHeader(host);
    return requestHost !== null && hostAllowed(host) && requestHost.host === url.host;
  };

  return {
    allowedOrigins,
    allowedHostnames,
    originAllowed,
    rejection(request) {
      const host = localBrowserRequestHost(request);
      if (!hostAllowed(host)) {
        return { status: 403, code: "LOCAL_HOST_NOT_ALLOWED", message: HOST_NOT_ALLOWED_MESSAGE };
      }
      const origin = request.headers.get("origin");
      if (origin !== null && !originAllowed(origin, host)) {
        return {
          status: 403,
          code: "LOCAL_ORIGIN_NOT_ALLOWED",
          message: ORIGIN_NOT_ALLOWED_MESSAGE,
        };
      }
      return null;
    },
  };
}

/** The standard API error envelope for a boundary rejection outside Hono. */
export function localBrowserBoundaryResponse(rejection: LocalBrowserBoundaryRejection): Response {
  return Response.json(
    {
      error: {
        status: rejection.status,
        code: "forbidden",
        message: rejection.message,
        retryable: false,
        details: { code: rejection.code },
      },
    },
    { status: rejection.status },
  );
}

/** The `Host` the boundary checks: the header, else the request URL's authority. */
export function localBrowserRequestHost(request: Request): string | null {
  const header = request.headers.get("host");
  if (header !== null) return header;
  try {
    return new URL(request.url).host || null;
  } catch {
    return null;
  }
}

function parseHostHeader(value: string): URL | null {
  const host = value.trim();
  // A Host is exactly `hostname[:port]`; anything else is not an address.
  if (!host || /[\s/?#@\\,]/u.test(host)) return null;
  try {
    const url = new URL(`http://${host}`);
    return url.host === host.toLowerCase() || url.host === host.toLowerCase().replace(/:80$/u, "")
      ? url
      : null;
  } catch {
    return null;
  }
}

function parseHttpUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (LOOPBACK_HOSTNAMES as readonly string[]).includes(hostname);
}
