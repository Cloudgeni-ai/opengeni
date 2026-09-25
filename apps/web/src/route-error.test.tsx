import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
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
import { routePatternFromMatches, type ClientErrorKind } from "@/lib/client-error-reporting";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

const RAW_ERROR_SENTINEL = "ROUTE_ERROR_RAW_TEXT_7c21 workspace 7c9e6679";

async function renderAt(path: string, failure: unknown) {
  const reports: Array<[ClientErrorKind, string]> = [];
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
    component: () => {
      throw failure;
    },
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
