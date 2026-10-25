// Navigation for an embedded session app: the location lives in memory, so the
// host page's URL and history stay untouched. Session routes render in place;
// app-only pages (settings, billing, schedules) open the full web app beside
// the host page.
import {
  createElement,
  forwardRef,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";

import type {
  LinkProps,
  NavigateOptions,
  NavigationHistoryState,
  NavigationHost,
  NavigationLocation,
  NavigationParams,
  NavigationSearch,
  NavigationState,
  NavigationUpdater,
  PageHost,
} from "../lib/navigation";
import { openBlankTab } from "../lib/navigation";

export type MemoryNavigationOptions = Readonly<{
  /** The first location, such as `/workspaces/<id>/sessions`. */
  initialPath: string;
  /** The web app origin that app paths open against when they leave the embed. */
  consoleOrigin: string;
  /** Whether a path renders inside the embed; anything else leaves through `openUrl`. */
  handles: (pathname: string) => boolean;
  /** Opens a URL outside the embed. Defaults to a new browser tab. */
  openUrl?: ((url: string) => void) | undefined;
  /** An empty tab opened inside a click, or null to leave through `openUrl`. */
  openTab?: (() => Window | null) | undefined;
  /** Called after every in-embed location change. */
  onLocationChange?: ((location: NavigationLocation) => void) | undefined;
}>;

type Listener = () => void;

function resolveUpdater<T>(update: NavigationUpdater<T> | undefined, current: T, empty: T): T {
  if (update === undefined) return empty;
  if (update === true) return current;
  if (typeof update === "function") return (update as (previous: T) => T)(current);
  return update;
}

/** TanStack's search encoding: strings stay bare unless they would parse as JSON. */
export function stringifyMemorySearch(search: NavigationSearch): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      let json = false;
      try {
        JSON.parse(value);
        json = true;
      } catch {
        json = false;
      }
      query.set(key, json ? JSON.stringify(value) : value);
    } else {
      query.set(key, JSON.stringify(value));
    }
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

function parseMemorySearch(searchStr: string): NavigationSearch {
  const search: NavigationSearch = {};
  for (const [key, value] of new URLSearchParams(searchStr)) {
    try {
      search[key] = JSON.parse(value);
    } catch {
      search[key] = value;
    }
  }
  return search;
}

const ROUTE_PARAMS = /^\/workspaces\/([^/]+)(?:\/sessions(?:\/([^/]+))?)?/u;

function paramsOf(pathname: string): NavigationParams {
  const match = ROUTE_PARAMS.exec(pathname);
  if (!match) return {};
  return {
    workspaceId: decodeURIComponent(match[1]!),
    ...(match[2] ? { sessionId: decodeURIComponent(match[2]) } : {}),
  };
}

function fillPath(to: string, params: NavigationParams): string {
  return to.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
}

function locationFor(
  pathname: string,
  search: NavigationSearch,
  hash: string,
  state: NavigationHistoryState,
): NavigationLocation {
  const searchStr = stringifyMemorySearch(search);
  return {
    pathname,
    search,
    searchStr,
    hash,
    href: `${pathname}${searchStr}${hash ? `#${hash}` : ""}`,
    state,
  };
}

function initialLocation(path: string): NavigationLocation {
  const url = new URL(path, "http://embed.invalid");
  return locationFor(url.pathname, parseMemorySearch(url.search), url.hash.slice(1), {});
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function createMemoryNavigation(options: MemoryNavigationOptions): NavigationHost {
  let location = initialLocation(options.initialPath);
  const listeners = new Set<Listener>();
  const subscribe = (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const snapshot = () => location;
  const openUrl =
    options.openUrl ??
    ((url: string) => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  const absolute = (path: string) => new URL(path, options.consoleOrigin).toString();

  const target = (navigation: NavigateOptions): NavigationLocation => {
    if (navigation.href !== undefined) return initialLocation(navigation.href);
    const currentParams = paramsOf(location.pathname);
    const params = resolveUpdater(navigation.params, currentParams, currentParams);
    const pathname =
      navigation.to === undefined || navigation.to === "."
        ? location.pathname
        : fillPath(navigation.to, params);
    return locationFor(
      pathname,
      resolveUpdater(navigation.search, location.search, {}),
      resolveUpdater(navigation.hash, location.hash, ""),
      resolveUpdater(navigation.state, location.state, {}),
    );
  };

  const commit = (next: NavigationLocation) => {
    if (!options.handles(next.pathname)) {
      openUrl(absolute(next.href));
      return;
    }
    location = next;
    for (const listener of listeners) listener();
    options.onLocationChange?.(next);
  };

  const navigate = async (navigation: NavigateOptions) => commit(target(navigation));

  const useLocation = () => useSyncExternalStore(subscribe, snapshot, snapshot);

  const Link = /* @__PURE__ */ forwardRef<HTMLAnchorElement, Omit<LinkProps, "ref">>(
    function MemoryLink(
      {
        to,
        from: _from,
        params,
        search,
        hash,
        state,
        replace: _replace,
        resetScroll: _resetScroll,
        ignoreBlocker: _ignoreBlocker,
        reloadDocument: _reloadDocument,
        href: hrefOption,
        preload: _preload,
        activeOptions: _activeOptions,
        disabled,
        children,
        onClick,
        target: linkTarget,
        ...anchor
      },
      ref,
    ) {
      const current = useLocation();
      const next = target({ to, params, search, hash, state, href: hrefOption });
      const internal = options.handles(next.pathname);
      const isActive = next.pathname === current.pathname;
      return createElement(
        "a",
        {
          ...anchor,
          ref,
          href: internal ? next.href : absolute(next.href),
          target: internal ? linkTarget : "_blank",
          rel: internal ? anchor.rel : "noopener noreferrer",
          "aria-disabled": disabled || undefined,
          "data-status": isActive ? "active" : undefined,
          onClick: (event: MouseEvent<HTMLAnchorElement>) => {
            onClick?.(event);
            if (event.defaultPrevented || disabled) {
              if (disabled) event.preventDefault();
              return;
            }
            if (!isPlainClick(event)) return;
            if (!internal) {
              // Leaves through the host (the Office pane opens its own browser window).
              event.preventDefault();
              openUrl(absolute(next.href));
              return;
            }
            if (linkTarget === "_blank") return;
            event.preventDefault();
            commit(next);
          },
        },
        typeof children === "function" ? children({ isActive, isTransitioning: false }) : children,
      );
    },
  );

  const page: PageHost = {
    href: () => absolute(location.href),
    origin: () => new URL(options.consoleOrigin).origin,
    readQuery: () => new URLSearchParams(location.searchStr),
    replaceQuery: (query, replaceOptions) => {
      location = locationFor(
        location.pathname,
        parseMemorySearch(query.toString()),
        location.hash,
        replaceOptions?.keepHistoryState ? location.state : {},
      );
      for (const listener of listeners) listener();
    },
    assign: (url) => {
      const resolved = new URL(url, options.consoleOrigin);
      const consoleOrigin = new URL(options.consoleOrigin).origin;
      if (resolved.origin === consoleOrigin && options.handles(resolved.pathname)) {
        commit(initialLocation(`${resolved.pathname}${resolved.search}${resolved.hash}`));
        return;
      }
      openUrl(resolved.toString());
    },
    opensBeside: true,
    open: (url) => openUrl(new URL(url, options.consoleOrigin).toString()),
    openTab: () => (options.openTab ?? openBlankTab)(),
  };

  return {
    useNavigate: () => navigate,
    useLocation,
    useRouterState: <T,>({ select }: { select: (state: NavigationState) => T }) =>
      select({ location: useLocation() }),
    useRouter: () => ({
      get state() {
        return { location };
      },
    }),
    useSearch: () => useLocation().search,
    Link,
    stringifySearch: stringifyMemorySearch,
    page,
  };
}

/**
 * A navigation host whose location lives in memory. Created once per mount;
 * later option changes keep the first location.
 */
export function useMemoryNavigation(options: MemoryNavigationOptions): NavigationHost {
  const [latest] = useState(() => ({ current: options }));
  latest.current = options;
  return useMemo(
    () =>
      createMemoryNavigation({
        initialPath: options.initialPath,
        consoleOrigin: options.consoleOrigin,
        handles: (pathname) => latest.current.handles(pathname),
        openUrl: (url) =>
          latest.current.openUrl
            ? latest.current.openUrl(url)
            : void window.open(url, "_blank", "noopener,noreferrer"),
        openTab: () => (latest.current.openTab ?? openBlankTab)(),
        onLocationChange: (location) => latest.current.onLocationChange?.(location),
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- one history per mount
    [],
  );
}
