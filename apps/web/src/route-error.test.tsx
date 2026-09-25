import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouteComponent,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  NotFoundPanel,
  RootRouteErrorPanel,
  RouteErrorPanel,
  routerErrorOptions,
} from "@/components/route-error";
import { ROUTER_PENDING_OPTIONS } from "@/components/route-pending";
import {
  installVitePreloadErrorReporting,
  resetChunkLoadFailureState,
  routePatternFromMatches,
  routePatternFromRoutes,
  type ClientErrorKind,
} from "@/lib/client-error-reporting";
import { installVitePreloadRecovery } from "@/lib/vite-preload-recovery";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

afterEach(() => {
  resetChunkLoadFailureState();
});

const RAW_ERROR_SENTINEL = "ROUTE_ERROR_RAW_TEXT_7c21 workspace 7c9e6679";

type Reports = Array<[ClientErrorKind, string]>;

async function renderAt(
  path: string,
  failure: unknown,
  options: {
    sessionComponent?: RouteComponent;
    beforeLoad?: (routePattern: () => string, reports: Reports) => void;
  } = {},
) {
  const reports: Reports = [];
  const rootRoute = createRootRoute({
    component: Outlet,
    errorComponent: RootRouteErrorPanel,
    notFoundComponent: NotFoundPanel,
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <p>Home page</p>,
  });
  const workspaceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "workspaces/$workspaceId",
    component: () => (
      <div>
        <aside>Persistent rail</aside>
        <Outlet />
      </div>
    ),
  });
  const sessionRoute = createRoute({
    getParentRoute: () => workspaceRoute,
    path: "sessions/$sessionId",
    component:
      options.sessionComponent ??
      (() => {
        throw failure;
      }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workspaceRoute.addChildren([sessionRoute])]),
    history: createMemoryHistory({ initialEntries: [path] }),
    ...ROUTER_PENDING_OPTIONS,
    ...routerErrorOptions(
      (): string => routePatternFromMatches(router.state.matches),
      (kind, route) => {
        reports.push([kind, route]);
      },
    ),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  // React and the router log caught render errors; they are expected here.
  console.error = () => undefined;
  console.warn = () => undefined;
  try {
    options.beforeLoad?.(
      () => routePatternFromRoutes(router.getMatchedRoutes(router.latestLocation.pathname)[0]),
      reports,
    );
    await router.load();
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }
  return {
    container,
    reports,
    router,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("route error boundaries", () => {
  test("a failing page keeps the workspace chrome and never shows raw error text", async () => {
    const view = await renderAt(
      "/workspaces/7c9e6679-7425-40de-944b-e07fc1f90ae7/sessions/s-1",
      new TypeError(RAW_ERROR_SENTINEL),
    );
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("Persistent rail");
      expect(text).toContain("Something went wrong");
      expect(text).not.toContain("Something went wrong!");
      expect(text).not.toContain(RAW_ERROR_SENTINEL);
      const buttons = [...view.container.querySelectorAll("button")].map((b) => b.textContent);
      expect(buttons).toContain("Reload page");
      const home = view.container.querySelector<HTMLAnchorElement>("a[href='/']");
      expect(home?.textContent).toBe("Go home");
      // The beacon carries the route pattern, never the concrete ids in the URL.
      expect(view.reports).toEqual([
        ["route_error", "/workspaces/$workspaceId/sessions/$sessionId"],
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("a stale lazy chunk after a deploy is presented as an update with reload first", async () => {
    const view = await renderAt(
      "/workspaces/w/sessions/s",
      new TypeError(
        "Failed to fetch dynamically imported module: https://app.example.test/assets/session-4f1.js",
      ),
    );
    try {
      const text = view.container.textContent ?? "";
      expect(text).toContain("OpenGeni has been updated");
      const buttons = [...view.container.querySelectorAll("button")];
      expect(buttons[0]?.textContent).toBe("Reload to update");
      expect(view.reports).toEqual([
        ["chunk_load", "/workspaces/$workspaceId/sessions/$sessionId"],
      ]);
    } finally {
      await view.cleanup();
    }
  });

  describe("after a deploy replaced the lazy session chunk", () => {
    const STALE_CHUNK_MESSAGE =
      "Failed to fetch dynamically imported module: https://app.example.test/assets/session-4f1.js";

    // Mirrors Vite's production `__vitePreload` helper: a failed import
    // dispatches a cancelable `vite:preloadError` on window, and when a
    // listener cancels it the helper resolves the import to `undefined`.
    function vitePreload(baseModule: () => Promise<unknown>): Promise<unknown> {
      return baseModule().catch((error: unknown) => {
        const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
          payload: error,
        });
        window.dispatchEvent(event);
        if (!event.defaultPrevented) throw error;
      });
    }

    function staleLazySession() {
      return lazyRouteComponent(
        () =>
          vitePreload(() => Promise.reject(new TypeError(STALE_CHUNK_MESSAGE))) as Promise<{
            default: RouteComponent;
          }>,
      );
    }

    function memoryStorage(initial: Record<string, string> = {}) {
      const values = new Map(Object.entries(initial));
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      };
    }

    async function renderStale(storage: ReturnType<typeof memoryStorage>) {
      let reloads = 0;
      const uninstall: Array<() => void> = [];
      const view = await renderAt("/workspaces/w/sessions/s", null, {
        sessionComponent: staleLazySession(),
        beforeLoad: (routePattern, reports) => {
          // The same order as main.tsx: report first, then recovery.
          uninstall.push(
            installVitePreloadErrorReporting({
              target: window,
              routePattern,
              report: (kind, route) => reports.push([kind, route]),
            }),
            installVitePreloadRecovery({
              target: window,
              storage,
              buildId: "https://app.example.test/assets/app-old.js",
              reload: () => {
                reloads += 1;
              },
            }),
          );
        },
      });
      return {
        ...view,
        reloads: () => reloads,
        cleanup: async () => {
          for (const remove of uninstall) remove();
          await view.cleanup();
        },
      };
    }

    test("a recovered tab counts one chunk_load and shows the update panel, not a route error", async () => {
      const view = await renderStale(memoryStorage());
      try {
        // Recovery cancelled the error and requested one reload, so the
        // router saw the follow-on `undefined.default` TypeError instead.
        expect(view.reloads()).toBe(1);
        // The chunk fails while the initial navigation is still loading; the
        // report names its destination pattern, never the concrete ids.
        expect(view.reports).toEqual([
          ["chunk_load", "/workspaces/$workspaceId/sessions/$sessionId"],
        ]);
        const text = view.container.textContent ?? "";
        expect(text).toContain("OpenGeni has been updated");
        expect(text).not.toContain("Something went wrong");
        expect(view.container.querySelector("button")?.textContent).toBe("Reload to update");
      } finally {
        await view.cleanup();
      }
    });

    test("a tab whose one-time reload is used up still counts one chunk_load", async () => {
      const tanstackReloadKey = `tanstack_router_reload:${STALE_CHUNK_MESSAGE}`;
      sessionStorage.setItem(tanstackReloadKey, "1");
      const view = await renderStale(
        memoryStorage({
          "opengeni:vite-preload-recovery-build": "https://app.example.test/assets/app-old.js",
        }),
      );
      try {
        expect(view.reloads()).toBe(0);
        expect(view.reports).toEqual([
          ["chunk_load", "/workspaces/$workspaceId/sessions/$sessionId"],
        ]);
        expect(view.container.textContent).toContain("OpenGeni has been updated");
      } finally {
        sessionStorage.removeItem(tanstackReloadKey);
        await view.cleanup();
      }
    });
  });

  test("an unknown URL offers a way home", async () => {
    const view = await renderAt("/no/such/page", new Error("unused"));
    try {
      expect(view.container.textContent).toContain("Page not found");
      const home = [...view.container.querySelectorAll("a")].find(
        (anchor) => anchor.textContent === "Go home",
      );
      expect(home?.getAttribute("href")).toBe("/");
      await act(async () => {
        home!.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      expect(view.router.state.location.pathname).toBe("/");
      expect(view.container.textContent).toContain("Home page");
      expect(view.reports).toEqual([]);
    } finally {
      await view.cleanup();
    }
  });

  test("a root failure renders the styled panel inside its own app canvas", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<RootRouteErrorPanel error={new Error(RAW_ERROR_SENTINEL)} reset={() => {}} />);
      });
      const main = container.querySelector("main");
      expect(main?.className).toContain("h-dvh");
      expect(main?.textContent).toContain("Something went wrong");
      expect(main?.textContent).not.toContain(RAW_ERROR_SENTINEL);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("the primary action reloads the document", async () => {
    let reloads = 0;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<RouteErrorPanel error={new Error("x")} reload={() => (reloads += 1)} />);
      });
      await act(async () => {
        container.querySelector("button")!.click();
      });
      expect(reloads).toBe(1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
