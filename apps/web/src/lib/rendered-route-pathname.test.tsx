import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useRouterState,
} from "@tanstack/react-router";
import { renderedRoutePathname } from "./rendered-route-pathname";

if (!globalThis.document) GlobalRegistrator.register({ url: "https://app.example.com" });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | undefined;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
});
afterAll(() => GlobalRegistrator.unregister());

const WorkspaceContext = createContext<string | null>(null);
function useWorkspace(): string {
  const value = useContext(WorkspaceContext);
  if (value === null) throw new Error("workspace context is not ready");
  return value;
}

/** The root shell's pattern: the security page renders outside the workspace
 * provider, every other page inside it. */
function buildRouter(select: typeof renderedRoutePathname) {
  let releaseSecurity: () => void = () => {};
  const securityLoaded = new Promise<void>((resolve) => {
    releaseSecurity = resolve;
  });
  const rendered: string[] = [];
  const rootRoute = createRootRoute({
    component: function Shell() {
      const pathname = useRouterState({ select });
      return pathname === "/settings/security" ? (
        <Outlet />
      ) : (
        <WorkspaceContext.Provider value="workspace">
          <Outlet />
        </WorkspaceContext.Provider>
      );
    },
    errorComponent: ({ error }) => <p>{`failed: ${(error as Error).message}`}</p>,
  });
  const home = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: function Home() {
      rendered.push(`home:${useWorkspace()}`);
      return <p>home</p>;
    },
  });
  const security = createRoute({
    getParentRoute: () => rootRoute,
    path: "/settings/security",
    loader: () => securityLoaded,
    component: () => <p>security</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([home, security]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return { router, releaseSecurity, rendered };
}

async function navigateWhileNextPageLoads(select: typeof renderedRoutePathname): Promise<string> {
  const { router, releaseSecurity } = buildRouter(select);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<RouterProvider router={router} />));
  await act(async () => router.load());
  expect(host.textContent).toBe("home");
  let navigation: Promise<void> | undefined;
  await act(async () => {
    navigation = router.navigate({ to: "/settings/security" });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  const whileLoading = host.textContent ?? "";
  await act(async () => {
    releaseSecurity();
    await navigation;
  });
  expect(host.textContent).toBe("security");
  return whileLoading;
}

test("the shell keeps the previous page's providers until the next page renders", async () => {
  expect(await navigateWhileNextPageLoads(renderedRoutePathname)).toBe("home");
});

test("a shell chosen from the location drops the previous page's providers too early", async () => {
  const fromLocation = await navigateWhileNextPageLoads((state) => state.location.pathname);
  expect(fromLocation).toContain("workspace context is not ready");
});
