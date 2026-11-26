// An app opened from the sidebar is a page of Opengeni's own:
// `/workspaces/<id>/apps/<appId>/<the app's own path>`, with the app's query
// and fragment (rare) kept in `?at=`. Back/Forward, reloads and copied links
// keep the app where it was.

export type AppPageLocation = { splat: string; at: string | undefined };

/** Split an app's own address (`/releases?tab=2`) into the page URL's parts. */
export function appPageLocation(href: string | null | undefined): AppPageLocation {
  const value = href && href.startsWith("/") ? href : "/";
  const cut = value.search(/[?#]/u);
  const pathname = cut < 0 ? value : value.slice(0, cut);
  const rest = cut < 0 ? "" : value.slice(cut);
  return { splat: pathname.replace(/^\/+/u, ""), at: rest || undefined };
}

/** The app's own address from the page URL's parts. */
export function appPageSiteHref(splat: string | undefined, at: string | undefined): string {
  const pathname = `/${(splat ?? "").replace(/^\/+/u, "")}`;
  const rest = at && /^[?#]/u.test(at) ? at : "";
  return `${pathname}${rest}`;
}

/** The page path for the app, for active-state checks. */
export function appPagePathname(workspaceId: string, appId: string, splat = ""): string {
  return `/workspaces/${workspaceId}/apps/${appId}${splat ? `/${splat}` : ""}`;
}

/**
 * Whether a sidebar row for the app is the open page. A row for the app
 * itself (no path of its own) stays highlighted wherever in the app the
 * person is, and on the app's Site view; a row for one of its pages only
 * on that page.
 */
export function appRowActive(
  pathname: string,
  workspaceId: string,
  appId: string,
  splat = "",
): boolean {
  if (splat) return pathname.replace(/\/+$/u, "") === appPagePathname(workspaceId, appId, splat);
  const page = appPagePathname(workspaceId, appId);
  return (
    pathname === page ||
    pathname.startsWith(`${page}/`) ||
    pathname.replace(/\/+$/u, "") === `/workspaces/${workspaceId}/sites/${appId}`
  );
}
