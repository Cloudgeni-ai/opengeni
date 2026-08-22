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

import { ROUTER_PENDING_OPTIONS } from "@/components/route-pending";

beforeAll(() => {
  GlobalRegistrator.register();
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  GlobalRegistrator.unregister();
});

describe("route pending boundaries", () => {
  test("a suspended workspace leaf keeps the shared rail mounted", async () => {
    const neverResolves = new Promise<void>(() => undefined);
    const rootRoute = createRootRoute({ component: Outlet });
    const workspaceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "workspace",
      component: () => (
        <div>
          <aside>Persistent rail</aside>
          <Outlet />
        </div>
      ),
    });
    const coldPageRoute = createRoute({
      getParentRoute: () => workspaceRoute,
      path: "cold-page",
      component: () => {
        throw neverResolves;
      },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([workspaceRoute.addChildren([coldPageRoute])]),
      history: createMemoryHistory({ initialEntries: ["/workspace/cold-page"] }),
      ...ROUTER_PENDING_OPTIONS,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await router.load();
      await act(async () => {
        root.render(<RouterProvider router={router} />);
      });

      expect(container.textContent).toContain("Persistent rail");
      expect(container.textContent).toContain("Loading page");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});
