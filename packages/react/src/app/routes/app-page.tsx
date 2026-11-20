// An app opened from the sidebar, as a page of Opengeni's own
// (docs/sidebar-layout.md "Apps as pages"): it fills the main area with no
// Artifacts chrome, its own address is the page URL
// (`/workspaces/<id>/apps/<appId>/<path>`), it follows Opengeni's light or
// dark theme, and the last few apps stay open while you go elsewhere, so
// coming back neither reloads nor flashes.
import { Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useRouterState } from "../lib/navigation";
import { cn } from "../lib/utils";

const AppPage = /* @__PURE__ */ lazy(() =>
  import("./app-page-view").then((module) => ({ default: module.AppPage })),
);

/** Apps kept open (hidden) besides the one on screen. */
export const APP_PAGES_KEPT_OPEN = 3;

export const APP_PAGE_ROUTE = "/workspaces/$workspaceId/apps/$appId/$";

const APP_PAGE_PATH =
  /^\/workspaces\/([^/]+)\/apps\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(.*))?$/iu;

export type AppPageMatch = { workspaceId: string; appId: string; siteHref: string };

/** The app a page URL shows, and the app's own address (`/releases?tab=2`). */
export function matchAppPage(pathname: string, at: unknown): AppPageMatch | null {
  const match = APP_PAGE_PATH.exec(pathname);
  if (!match) return null;
  const splat = match[3] ?? "";
  const rest = typeof at === "string" && /^[?#]/u.test(at) ? at : "";
  return {
    workspaceId: match[1]!,
    appId: match[2]!.toLowerCase(),
    siteHref: `/${splat}${rest}`,
  };
}

export function splitAppSiteHref(href: string): { splat: string; at: string | undefined } {
  const cut = href.search(/[?#]/u);
  const pathname = cut < 0 ? href : href.slice(0, cut);
  const rest = cut < 0 ? "" : href.slice(cut);
  return { splat: pathname.replace(/^\/+/u, ""), at: rest || undefined };
}

type OpenApp = { key: string; workspaceId: string; appId: string; siteHref: string };

/**
 * Keeps the last few apps open around the page outlet (`children`): the app
 * on screen fills the canvas, the others stay mounted but hidden, so their
 * frames, scroll and state survive. Frames are never reordered (moving an
 * iframe in the document reloads it); the least recently shown one closes.
 */
/**
 * The apps to keep after `key` comes on screen, most recent first: it and
 * the last {@link APP_PAGES_KEPT_OPEN} others.
 */
export function keptAppPages(recent: readonly string[], key: string): string[] {
  return [key, ...recent.filter((entry) => entry !== key)].slice(0, APP_PAGES_KEPT_OPEN + 1);
}

export function AppPages({ children }: { children: ReactNode }) {
  const location = useRouterState({
    select: (state) => ({
      pathname: state.location.pathname,
      at: (state.location.search as Record<string, unknown> | undefined)?.at,
    }),
  });
  const match = useMemo(
    () => matchAppPage(location.pathname, location.at),
    [location.at, location.pathname],
  );
  const activeKey = match ? `${match.workspaceId}/${match.appId}` : null;
  const [open, setOpen] = useState<OpenApp[]>([]);
  const recency = useRef<string[]>([]);
  useEffect(() => {
    if (!match) return;
    const key = `${match.workspaceId}/${match.appId}`;
    recency.current = keptAppPages(recency.current, key);
    const keep = new Set(recency.current);
    setOpen((current) => {
      const next = current
        .filter((entry) => keep.has(entry.key))
        .map((entry) => (entry.key === key ? { ...entry, siteHref: match.siteHref } : entry));
      if (!next.some((entry) => entry.key === key)) next.push({ key, ...match });
      return next;
    });
  }, [match]);
  // Apps in another workspace close when you switch workspaces.
  const workspaceId = /^\/workspaces\/([^/]+)/u.exec(location.pathname)?.[1];
  useEffect(() => {
    if (!workspaceId) return;
    setOpen((current) => {
      const next = current.filter((entry) => entry.workspaceId === workspaceId);
      return next.length === current.length ? current : next;
    });
  }, [workspaceId]);
  return (
    <>
      {open.map((entry) => {
        const active = entry.key === activeKey;
        return (
          <div
            key={entry.key}
            data-app-page={entry.appId}
            data-workspace-scroll-owner="self-managed"
            aria-hidden={active ? undefined : true}
            className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !active && "hidden")}
          >
            <Suspense fallback={<div className="min-h-0 flex-1" />}>
              <AppPage
                workspaceId={entry.workspaceId}
                appId={entry.appId}
                siteHref={active && match ? match.siteHref : entry.siteHref}
                active={active}
              />
            </Suspense>
          </div>
        );
      })}
      {/* Until the app's own frame is placed (one effect), the canvas is blank, not a spinner. */}
      {match && !open.some((entry) => entry.key === activeKey) ? (
        <div className="min-h-0 flex-1" />
      ) : null}
      {children}
    </>
  );
}
