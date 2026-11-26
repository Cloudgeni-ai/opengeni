// Opengeni Console URLs. Kept small: the route table and the boot redirect
// import this, while the Console pages themselves load lazily.

import { isConsoleHostname } from "@opengeni/contracts/console-sign-in";

export { isConsoleHostname };

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

/** Members: the person or invitation whose page is open, or Invite people. */
export type ConsoleMembersSearch = { person?: string; invitation?: string; view?: "invite" };

export function parseConsoleMembersSearch(search: Record<string, unknown>): ConsoleMembersSearch {
  const result: ConsoleMembersSearch = {};
  if (typeof search.person === "string" && search.person) result.person = search.person;
  else if (typeof search.invitation === "string" && search.invitation) {
    result.invitation = search.invitation;
  } else if (search.view === "invite") result.view = "invite";
  return result;
}

/** Usage and billing: a workspace's budget page, or a Stripe checkout's return. */
export type ConsoleUsageSearch = {
  workspace?: string;
  checkout?: "success" | "cancelled";
  checkoutSession?: string;
};

export function parseConsoleUsageSearch(search: Record<string, unknown>): ConsoleUsageSearch {
  const result: ConsoleUsageSearch = {};
  if (typeof search.workspace === "string" && UUID.test(search.workspace)) {
    result.workspace = search.workspace;
  }
  if (search.checkout === "success" || search.checkout === "cancelled") {
    result.checkout = search.checkout;
  }
  if (typeof search.checkoutSession === "string" && search.checkoutSession) {
    result.checkoutSession = search.checkoutSession;
  }
  return result;
}

/** One agent's page: its tab, the chat whose changes are open, the versions compared. */
export type ConsoleAgentTab = "settings" | "test" | "versions" | "sessions";
export type ConsoleAgentSearch = {
  tab?: ConsoleAgentTab;
  session?: string;
  from?: number;
  to?: number;
};

const AGENT_TABS = new Set<ConsoleAgentTab>(["settings", "test", "versions", "sessions"]);

function positiveInteger(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function parseConsoleAgentSearch(search: Record<string, unknown>): ConsoleAgentSearch {
  const result: ConsoleAgentSearch = {};
  if (typeof search.tab === "string" && AGENT_TABS.has(search.tab as ConsoleAgentTab)) {
    result.tab = search.tab as ConsoleAgentTab;
  }
  if (typeof search.session === "string" && UUID.test(search.session)) {
    result.session = search.session;
  }
  const from = positiveInteger(search.from);
  const to = positiveInteger(search.to);
  if (from !== undefined) result.from = from;
  if (to !== undefined) result.to = to;
  return result;
}

/**
 * The social sign-in buttons a host offers. A GitHub OAuth app has one
 * callback host, the app's, so the Console host does not offer GitHub.
 */
export function socialProvidersForHost<T extends string>(
  hostname: string,
  providers: readonly T[],
): T[] {
  return isConsoleHostname(hostname)
    ? providers.filter((provider) => provider !== "github")
    : [...providers];
}

/** Whether this page is served on a Console host, where nothing leads into the app. */
export function onConsoleHost(): boolean {
  return typeof window !== "undefined" && isConsoleHostname(window.location.hostname);
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
  "tool-servers",
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
    // What the page had open stays open: a person or invitation, Invite
    // people, a workspace's budget, a Stripe checkout's outcome.
    const keep: Record<string, readonly string[]> = {
      "/console/members": ["person", "invitation", "view"],
      "/console/usage": ["workspace", "checkout", "checkoutSession"],
    };
    const kept = new URLSearchParams();
    for (const name of keep[target] ?? []) {
      const value = query.get(name);
      if (value) kept.set(name, value);
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
