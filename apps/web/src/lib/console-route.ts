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

// Pages that must keep their own path on the Console host: sign-in returns,
// public pages and callbacks that the app serves at fixed URLs.
const KEEP_ON_CONSOLE_HOST =
  /^\/(?:account-auth|reset-password|setup-account|share\/|native-sign-in|site-auth\/|desktop-return|device|identity-links\/|billing|integrations|teams\/|connect-agent|settings\/security|excel|dev\/)/u;

/**
 * On a `console.` host every page is a Console page: `/` opens Overview and
 * `/sessions` opens `/console/sessions`. Null when the path stays as it is.
 */
export function consoleHostRedirectPath(hostname: string, pathname: string): string | null {
  if (!hostname.toLowerCase().startsWith("console.")) return null;
  if (pathname === CONSOLE_PATH || pathname.startsWith(`${CONSOLE_PATH}/`)) return null;
  if (KEEP_ON_CONSOLE_HOST.test(pathname)) return null;
  if (pathname === "" || pathname === "/") return CONSOLE_PATH;
  return `${CONSOLE_PATH}${pathname}`;
}
