const SITE_WORKSPACE_PREFIX = "/v1/workspaces/site-host";

/** A Site/Codemode SDK request named a route outside the proxied surface. */
export class SiteSessionPathError extends Error {
  readonly code = "site_session_path_unsupported";

  constructor() {
    super("Unsupported Site session API path");
    this.name = "SiteSessionPathError";
  }
}

type SiteSessionRoute = {
  methods: readonly string[];
  pattern: RegExp;
};

/**
 * The exact conversational session surface a Site or Codemode SDK proxy may
 * reach. Every other session route (tool policy, visibility, forks, Steer,
 * control, goals, history, API keys, terminal, filesystem, ...) is a
 * configuration or control authority that never belongs to embedded page code
 * or to a sandboxed agent proxying through the ordinary REST handlers.
 */
const SITE_SESSION_ROUTES: readonly SiteSessionRoute[] = [
  // List and create.
  { methods: ["GET", "POST"], pattern: /^\/sessions$/u },
  { methods: ["GET", "PUT"], pattern: /^\/new-session-draft$/u },
  // Read one session and its timeline.
  { methods: ["GET"], pattern: /^\/sessions\/[^/]+$/u },
  { methods: ["GET"], pattern: /^\/sessions\/[^/]+\/events$/u },
  { methods: ["GET"], pattern: /^\/sessions\/[^/]+\/events\/stream$/u },
  // Send a message.
  { methods: ["POST"], pattern: /^\/sessions\/[^/]+\/events$/u },
  // Queue management.
  { methods: ["GET"], pattern: /^\/sessions\/[^/]+\/queue$/u },
  {
    methods: ["POST"],
    pattern: /^\/sessions\/[^/]+\/queue\/[^/]+\/(?:move|edit|steer|delete)$/u,
  },
  // Composer drafts.
  { methods: ["GET", "PUT"], pattern: /^\/sessions\/[^/]+\/composer-draft$/u },
  { methods: ["POST"], pattern: /^\/sessions\/[^/]+\/composer-draft\/submit$/u },
];

function siteSessionRouteAllowed(pathname: string, method: string): boolean {
  if (!pathname.startsWith(SITE_WORKSPACE_PREFIX)) return false;
  const suffix = pathname.slice(SITE_WORKSPACE_PREFIX.length);
  return SITE_SESSION_ROUTES.some(
    (route) => route.methods.includes(method) && route.pattern.test(suffix),
  );
}

/** The shared browser/preview session SDK surface. Tenant routing stays with
 * the host; normal API handlers remain the authorization boundary, and this
 * allowlist keeps configuration/control routes out of the proxied surface. */
export function siteSessionPath(path: string, workspaceId: string, method = "GET"): string {
  const verb = method.toUpperCase();
  const pathname = path.split("?")[0]!;
  const session = siteSessionRouteAllowed(pathname, verb);
  const context =
    verb === "GET" &&
    (path === "/v1/config/client" ||
      /^\/v1\/workspaces\/site-host(?:[?].*|$|\/(?:model-catalog|live-events\/stream|control-events(?:\/stream)?|interaction-events\/stream)(?:[?].*|$))/u.test(
        path,
      ));
  if (
    (!session && !context) ||
    /[%\\#]/u.test(pathname) ||
    pathname.split("/").some((p) => p === "." || p === "..")
  ) {
    throw new SiteSessionPathError();
  }
  return path.replace("/workspaces/site-host", `/workspaces/${encodeURIComponent(workspaceId)}`);
}
