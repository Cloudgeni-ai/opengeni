// Opengeni Console URLs. Kept small: the route table and the boot redirect
// import this, while the Console pages themselves load lazily.

export const CONSOLE_PATH = "/console";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The organization a Console page shows, from `?org=`. */
export type ConsoleSearch = { org?: string };

export function parseConsoleSearch(search: Record<string, unknown>): ConsoleSearch {
  return typeof search.org === "string" && UUID.test(search.org) ? { org: search.org } : {};
}

/** Sessions: the managed workspace it is filtered to, from `?workspace=`. */
export type ConsoleSessionsSearch = { workspace?: string };

export function parseConsoleSessionsSearch(search: Record<string, unknown>): ConsoleSessionsSearch {
  return typeof search.workspace === "string" && UUID.test(search.workspace)
    ? { workspace: search.workspace }
    : {};
}

/**
 * Console's own hosts: a host whose first or second label is `console`
 * (console.opengeni.ai, staging.console.opengeni.ai), never consolex.* or app.*.
 */
export function isConsoleHostname(hostname: string): boolean {
  const labels = hostname.toLowerCase().replace(/\.$/u, "").split(".");
  return (
    (labels.length >= 2 && labels[0] === "console") ||
    (labels.length >= 3 && labels[1] === "console")
  );
}

// Pages that keep their own path on the Console host: sign-in returns, invite
// acceptance, public pages and callbacks served at fixed URLs.
const KEEP_ON_CONSOLE_HOST =
  /^\/(?:account-auth|reset-password|setup-account|share\/|native-sign-in|site-auth\/|desktop-return|device|identity-links\/|billing|connect-agent|settings\/security|excel|dev\/)/u;

const CONSOLE_PAGES = new Set([
  "sessions",
  "workspaces",
  "api-keys",
  "agents",
  "members",
  "usage",
  "settings",
]);

// Organization settings sections that have a Console page.
const ORGANIZATION_SECTION_PAGES: Record<string, string> = {
  people: "/console/members",
  billing: "/console/usage",
  insights: "/console/usage",
  developer: "/console/api-keys",
  general: "/console/settings",
};

/**
 * On a Console host every page is a Console page. Returns the Console path
 * (with its query) a path and query open there, or null when they stay as
 * they are: `/` opens Overview, `/sessions` opens `/console/sessions`, an
 * organization settings page opens its Console page, and anything else in
 * the app (a workspace, a chat) opens Overview.
 */
export function consoleHostRedirectPath(
  hostname: string,
  pathname: string,
  search = "",
): string | null {
  if (!isConsoleHostname(hostname)) return null;
  if (pathname === CONSOLE_PATH || pathname.startsWith(`${CONSOLE_PATH}/`)) return null;
  if (KEEP_ON_CONSOLE_HOST.test(pathname)) return null;
  if (pathname === "" || pathname === "/") return `${CONSOLE_PATH}${search}`;
  const query = new URLSearchParams(search);
  const organization = /^\/workspaces\/[^/]+\/organization\/?$/u.test(pathname);
  if (organization) {
    const target = ORGANIZATION_SECTION_PAGES[query.get("section") ?? ""] ?? CONSOLE_PATH;
    // A Stripe checkout return keeps its outcome for the Usage and billing page.
    const kept = new URLSearchParams();
    for (const name of ["checkout", "checkoutSession"]) {
      const value = query.get(name);
      if (value && target === "/console/usage") kept.set(name, value);
    }
    const rest = kept.toString();
    return rest ? `${target}?${rest}` : target;
  }
  // A bare Console page name (`/sessions`, `/api-keys/new`) opens that page.
  const page = pathname.replace(/\/+$/u, "");
  if (CONSOLE_PAGES.has(page.slice(1)) || page === "/api-keys/new") {
    return `${CONSOLE_PATH}${page}${search}`;
  }
  return CONSOLE_PATH;
}
