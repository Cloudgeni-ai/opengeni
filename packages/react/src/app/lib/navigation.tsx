// Navigation for the session UI, independent of any one router. The web app
// backs it with its TanStack router (see `configurePageAppHost`), so links,
// history and URLs there are exactly the router's own. An embed backs it with
// its own routing or in-memory state.
import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";

import { useAppHost } from "./app-host";

/** History state the session UI writes and reads. */
export type NavigationHistoryState = {
  /** Set only on the Settings "Back to sessions" link that reopens this session. */
  restoredSessionId?: string | undefined;
  [key: string]: unknown;
};

export type NavigationLocation = Readonly<{
  pathname: string;
  search: Record<string, unknown>;
  searchStr: string;
  hash: string;
  href: string;
  state: NavigationHistoryState;
}>;

export type NavigationState = Readonly<{ location: NavigationLocation }>;

export type NavigationSearch = Record<string, unknown>;
export type NavigationParams = Record<string, string>;

/** A value, `(previous) => next`, or `true` to keep the current one. */
export type NavigationUpdater<T> = true | T | ((previous: T) => T);

export type NavigateOptions = {
  /** A route path such as `/workspaces/$workspaceId`, filled from `params`. */
  to?: string | undefined;
  from?: string | undefined;
  params?: NavigationUpdater<NavigationParams> | undefined;
  search?: NavigationUpdater<NavigationSearch> | undefined;
  hash?: NavigationUpdater<string> | undefined;
  state?: NavigationUpdater<NavigationHistoryState> | undefined;
  replace?: boolean | undefined;
  resetScroll?: boolean | undefined;
  ignoreBlocker?: boolean | undefined;
  reloadDocument?: boolean | undefined;
  href?: string | undefined;
};

export type NavigateFunction = (options: NavigateOptions) => Promise<void>;

export type LinkProps = NavigateOptions &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children"> & {
    children?:
      | ReactNode
      | ((state: { isActive: boolean; isTransitioning: boolean }) => ReactNode)
      | undefined;
    preload?: false | "intent" | "viewport" | "render" | undefined;
    disabled?: boolean | undefined;
    /** When the link counts as the current page (`aria-current`); the router's default otherwise. */
    activeOptions?:
      | { exact?: boolean | undefined; includeSearch?: boolean | undefined }
      | undefined;
    ref?: Ref<HTMLAnchorElement> | undefined;
  };

/**
 * The page around the session UI, for flows that leave it or return to it
 * (provider authorization, checkout, connect returns). The web app maps these
 * to `window.location` and `history`; an embed keeps the host page untouched.
 */
export type PageHost = Readonly<{
  /** Absolute URL of the console page being shown. */
  href: () => string;
  /** The console origin that app paths (`/workspaces/...`) resolve against. */
  origin: () => string;
  /** The page's query, where authorization and connect returns land. */
  readQuery: () => URLSearchParams;
  /** Replaces the page's query after handling a return, without a navigation. */
  replaceQuery: (query: URLSearchParams, options?: { keepHistoryState?: boolean }) => void;
  /**
   * Leaves for a URL: an external flow, or an app page outside the session UI.
   * An embed opens it beside the host page instead of replacing it.
   */
  assign: (url: string, options?: { replace?: boolean }) => void;
  /**
   * True when `assign` opens outside URLs beside the page rather than leaving
   * it (an embed), so a flow that leaves for checkout stays here and waits.
   */
  opensBeside: boolean;
  /** Opens a URL beside the page (a file, an image, a provider page). */
  open: (url: string) => void;
  /**
   * Opens an empty tab inside a click, for a URL known only after an await
   * (checkout, a freshly signed link). Null when the browser blocks it or the
   * host shows URLs its own way; the caller then leaves through `assign`.
   */
  openTab: () => Window | null;
}>;

export type NavigationHost = Readonly<{
  useNavigate: () => NavigateFunction;
  useLocation: () => NavigationLocation;
  useRouterState: <T>(options: { select: (state: NavigationState) => T }) => T;
  /** Live, non-reactive read for event handlers. */
  useRouter: () => { readonly state: NavigationState };
  useSearch: (options: { strict: false }) => NavigationSearch;
  /**
   * Renders an anchor and attaches `ref` to it. React 18 passes a ref only to
   * a `forwardRef` component, so wrap the host's link in one there.
   */
  Link: ComponentType<LinkProps>;
  stringifySearch: (search: NavigationSearch) => string;
  page: PageHost;
}>;

/**
 * The browser window as the page: the default when nothing scopes another one,
 * and what a host that owns the URL (the web app) passes as its `page`.
 */
export const browserPage: PageHost = {
  href: () => window.location.href,
  origin: () => window.location.origin,
  readQuery: () => new URLSearchParams(window.location.search),
  replaceQuery: (query, options) =>
    window.history.replaceState(
      options?.keepHistoryState ? window.history.state : null,
      "",
      `${window.location.pathname}${query.size ? `?${query}` : ""}`,
    ),
  assign: (url, options) =>
    options?.replace ? window.location.replace(url) : window.location.assign(url),
  opensBeside: false,
  open: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
  openTab: openBlankTab,
};

/** An empty new tab with no handle back to this page, or null when blocked. */
export function openBlankTab(): Window | null {
  let tab: Window | null = null;
  try {
    tab = window.open("", "_blank");
  } catch {
    return null;
  }
  if (tab) tab.opener = null;
  return tab;
}

function useNavigationHost(): NavigationHost {
  const host = useAppHost().navigation;
  if (!host) throw new Error("Opengeni navigation is not configured");
  return host;
}

export function useNavigate(): NavigateFunction {
  return useNavigationHost().useNavigate();
}

export function useLocation(): NavigationLocation {
  return useNavigationHost().useLocation();
}

export function useRouterState<T>(options: { select: (state: NavigationState) => T }): T {
  return useNavigationHost().useRouterState(options);
}

export function useRouter(): { readonly state: NavigationState } {
  return useNavigationHost().useRouter();
}

export function useSearch(options: { strict: false }): NavigationSearch {
  return useNavigationHost().useSearch(options);
}

export const Link = /* @__PURE__ */ forwardRef<HTMLAnchorElement, Omit<LinkProps, "ref">>(
  function Link(props, ref) {
    const HostLink = useNavigationHost().Link;
    return <HostLink {...props} ref={ref} />;
  },
);

/** The page around the session UI; the browser window unless a host scopes another. */
export function usePage(): PageHost {
  return useAppHost().navigation?.page ?? browserPage;
}

/** The host's search serializer (`?a=1&b=%22x%22`), for hrefs built outside `Link`. */
export function useStringifySearch(): (search: NavigationSearch) => string {
  return useNavigationHost().stringifySearch;
}
