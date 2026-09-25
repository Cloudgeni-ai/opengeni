import {
  localAllowedOriginEntries,
  localSandboxApiRouteAllowed,
  type Settings,
} from "@opengeni/config";

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
 * The boundary therefore sorts the `Host` a request is addressed to into two
 * classes:
 *
 * - Browser hosts: loopback, the hosts of the configured web, public, and
 *   extra origins, the GitHub App callback tunnel, and a specific API bind
 *   address. A present `Origin` must be this stack's web app, an explicitly
 *   configured origin, or the API's own address on one of these hosts.
 * - Sandbox hosts: names only sandboxes and the worker use to reach the API
 *   (`host.docker.internal` with the Docker sandbox, and the hosts of
 *   `OPENGENI_MCP_URL` and `OPENGENI_MCP_INTERNAL_URL`). They serve only the
 *   sandbox routes (Codemode, first-party MCP, and the Git broker) and refuse
 *   any request that carries browser metadata. A browser cannot tell a
 *   sandbox name from an attacker's, so a rebinding page on one of these
 *   names can neither send an accepted `Origin` nor reach the rest of the API.
 *
 * Every other `Host` is refused. Non-browser clients (the SDK, curl, sandbox
 * callbacks, host-app servers) send no `Origin` and are unaffected. The `Host`
 * port is not compared: a rebinding page controls only the hostname, while
 * local proxies and forwarders legitimately present their own port.
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
  | "sandboxBackend"
>;

export type LocalBrowserBoundaryRejectionCode =
  | "LOCAL_HOST_NOT_ALLOWED"
  | "LOCAL_ORIGIN_NOT_ALLOWED"
  | "LOCAL_SANDBOX_ROUTE_ONLY";

export type LocalBrowserBoundaryRejection = {
  status: 403;
  code: LocalBrowserBoundaryRejectionCode;
  message: string;
  /** The refused `Host` or `Origin`, for the API log only; never sent back. */
  refused: string;
};

/** Called once per distinct refused value, so an operator can see why. */
export type LocalBrowserBoundaryWarn = (
  message: string,
  attributes: Record<string, string>,
) => void;

export type LocalBrowserBoundary = {
  readonly allowedOrigins: ReadonlySet<string>;
  /** Hostnames a browser may address. */
  readonly browserHostnames: ReadonlySet<string>;
  /** Hostnames only sandboxes and the worker use; sandbox routes only, no browsers. */
  readonly sandboxHostnames: ReadonlySet<string>;
  /** Whether a present `Origin` may call the API for a request with this `Host`. */
  originAllowed(origin: string, host: string | null): boolean;
  /** The rejection for this request, or null when the boundary admits it. */
  rejection(request: Request): LocalBrowserBoundaryRejection | null;
};

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "[::1]"] as const;
/** Docker Desktop's name for the host; Linux sandboxes use the configured bridge route. */
const DOCKER_HOST_ALIAS = "host.docker.internal";
/** `apps/web` dev server default when no web base URL is configured. */
const DEFAULT_LOCAL_WEB_ORIGIN = "http://127.0.0.1:3000";
const WILDCARD_BIND_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);
/**
 * Only browsers send these. (Node's fetch sends `Sec-Fetch-Mode: cors`, so that
 * header does not identify a browser.)
 */
const BROWSER_REQUEST_HEADERS = ["origin", "sec-fetch-site"];
/** Distinct refused values logged per boundary, so a rebinding page cannot flood the log. */
const MAX_REPORTED_REJECTIONS = 32;
const MAX_REPORTED_VALUE_LENGTH = 200;

const HOST_NOT_ALLOWED_MESSAGE =
  "The local OpenGeni API only answers requests addressed to this computer. " +
  "To use another address, set it in OPENGENI_WEB_BASE_URL, OPENGENI_PUBLIC_BASE_URL, " +
  "or OPENGENI_LOCAL_ALLOWED_ORIGINS.";
const ORIGIN_NOT_ALLOWED_MESSAGE =
  "The local OpenGeni API has no authentication, so browser requests are accepted only " +
  "from this stack's web app. Add other trusted origins to OPENGENI_LOCAL_ALLOWED_ORIGINS.";
const SANDBOX_ROUTE_ONLY_MESSAGE =
  "This address is the local OpenGeni API's sandbox route. It serves only sandbox calls " +
  "(Codemode, first-party MCP, and the Git broker), never browsers. Open the web app at " +
  "its own address, or list this address in OPENGENI_LOCAL_ALLOWED_ORIGINS.";

const WARNINGS: Record<LocalBrowserBoundaryRejectionCode, { message: string; setting: string }> = {
  LOCAL_HOST_NOT_ALLOWED: {
    message: "Local API refused a request addressed to a name that is not this computer's",
    setting: "OPENGENI_WEB_BASE_URL, OPENGENI_PUBLIC_BASE_URL, or OPENGENI_LOCAL_ALLOWED_ORIGINS",
  },
  LOCAL_ORIGIN_NOT_ALLOWED: {
    message: "Local API refused a browser request from an origin that is not this stack's web app",
    setting: "OPENGENI_WEB_BASE_URL or OPENGENI_LOCAL_ALLOWED_ORIGINS",
  },
  LOCAL_SANDBOX_ROUTE_ONLY: {
    message: "Local API refused a browser or non-sandbox request on an address only sandboxes use",
    setting: "OPENGENI_WEB_BASE_URL or OPENGENI_LOCAL_ALLOWED_ORIGINS",
  },
};

/**
 * Requests the API builds and dispatches to itself, such as the Codemode SDK
 * proxy's re-dispatch. They never come from the network, and the request they
 * were built from already passed the boundary.
 */
const internalDispatches = new WeakSet<Request>();

/** Mark a request the API dispatches to itself so the boundary admits it. */
export function markLocalInternalDispatch(request: Request): Request {
  internalDispatches.add(request);
  return request;
}

export function localBrowserBoundaryApplies(
  settings: Pick<Settings, "productAccessMode" | "environment">,
): boolean {
  return settings.productAccessMode === "local" && settings.environment === "local";
}

/** Build the boundary, or null when the deployment is not the local dev product. */
export function createLocalBrowserBoundary(
  settings: LocalBrowserBoundarySettings,
  options: { warn?: LocalBrowserBoundaryWarn } = {},
): LocalBrowserBoundary | null {
  if (!localBrowserBoundaryApplies(settings)) return null;

  const webOrigins = [settings.webBaseUrl ?? DEFAULT_LOCAL_WEB_ORIGIN, settings.publicBaseUrl]
    .map((value) => parseHttpUrl(value))
    .filter((url): url is URL => url !== null);
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

  const browserHostnames = new Set<string>(LOOPBACK_HOSTNAMES);
  for (const url of [...webOrigins, ...extraOrigins]) browserHostnames.add(url.hostname);
  // A tunnel configured for GitHub App callbacks: GitHub redirects the browser there.
  const githubAppTunnel = parseHttpUrl(settings.githubAppManifestBaseUrl);
  if (githubAppTunnel) browserHostnames.add(githubAppTunnel.hostname);
  const apiHost = settings.apiHost.trim().toLowerCase();
  if (!WILDCARD_BIND_HOSTS.has(apiHost)) {
    const url = parseHostHeader(
      apiHost.includes(":") && !apiHost.startsWith("[") ? `[${apiHost}]` : apiHost,
    );
    if (url) browserHostnames.add(url.hostname);
  }

  // The sandbox-visible API route (Docker Desktop's host alias, the Linux
  // Docker bridge address, or a tunnel for a remote sandbox) and the worker's
  // internal route arrive with their own Host.
  const sandboxHostnames = new Set<string>();
  if (settings.sandboxBackend === "docker") sandboxHostnames.add(DOCKER_HOST_ALIAS);
  for (const value of [settings.opengeniMcpUrl, settings.opengeniMcpInternalUrl]) {
    const url = parseHttpUrl(value?.replaceAll("{workspaceId}", "workspace"));
    if (url) sandboxHostnames.add(url.hostname);
  }
  // A name the developer also uses in the browser stays a browser host.
  for (const hostname of browserHostnames) sandboxHostnames.delete(hostname);

  const browserHost = (host: string | null): URL | null => {
    const url = host === null ? null : parseHostHeader(host);
    return url !== null && browserHostnames.has(url.hostname) ? url : null;
  };

  const originAllowed = (origin: string, host: string | null): boolean => {
    const url = parseHttpUrl(origin);
    if (!url || url.origin !== origin.toLowerCase().replace(/\/$/u, "")) return false;
    if (allowedOrigins.has(url.origin)) return true;
    // Pages served by the API itself (for example the MCP OAuth consent form)
    // and same-origin dev proxies present the API's own address. Only a
    // browser host qualifies: sandbox names and unknown names never do.
    const requestHost = browserHost(host);
    return requestHost !== null && requestHost.host === url.host;
  };

  const reported = new Set<string>();
  const report = (rejection: LocalBrowserBoundaryRejection, host: string | null) => {
    if (!options.warn) return;
    const key = `${rejection.code}\u0000${rejection.refused}`;
    if (reported.has(key) || reported.size >= MAX_REPORTED_REJECTIONS) return;
    reported.add(key);
    const warning = WARNINGS[rejection.code];
    options.warn(warning.message, {
      code: rejection.code,
      refused: rejection.refused.slice(0, MAX_REPORTED_VALUE_LENGTH),
      host: (host ?? "").slice(0, MAX_REPORTED_VALUE_LENGTH),
      setting: warning.setting,
    });
  };

  const refuse = (
    code: LocalBrowserBoundaryRejectionCode,
    refused: string,
    host: string | null,
  ): LocalBrowserBoundaryRejection => {
    const message =
      code === "LOCAL_HOST_NOT_ALLOWED"
        ? HOST_NOT_ALLOWED_MESSAGE
        : code === "LOCAL_ORIGIN_NOT_ALLOWED"
          ? ORIGIN_NOT_ALLOWED_MESSAGE
          : SANDBOX_ROUTE_ONLY_MESSAGE;
    const rejection: LocalBrowserBoundaryRejection = { status: 403, code, message, refused };
    report(rejection, host);
    return rejection;
  };

  return {
    allowedOrigins,
    browserHostnames,
    sandboxHostnames,
    originAllowed,
    rejection(request) {
      if (internalDispatches.has(request)) return null;
      const host = localBrowserRequestHost(request);
      const origin = request.headers.get("origin");
      if (browserHost(host)) {
        if (origin !== null && !originAllowed(origin, host)) {
          return refuse("LOCAL_ORIGIN_NOT_ALLOWED", origin, host);
        }
        return null;
      }
      const parsedHost = host === null ? null : parseHostHeader(host);
      if (parsedHost === null || !sandboxHostnames.has(parsedHost.hostname)) {
        return refuse("LOCAL_HOST_NOT_ALLOWED", host ?? "", host);
      }
      if (
        BROWSER_REQUEST_HEADERS.some((name) => request.headers.has(name)) ||
        !localSandboxApiRouteAllowed(requestPathname(request))
      ) {
        return refuse("LOCAL_SANDBOX_ROUTE_ONLY", host ?? "", host);
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

/** The normalized path the router sees (URL parsing resolves dot segments). */
function requestPathname(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "";
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
