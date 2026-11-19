import { describe, expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { leaveOnboardingPathWithoutPage, pathHasAppPage } from "./onboarding-return";

function appRouter(initialPath: string) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
  });
  const workspaceSessionsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "workspaces/$workspaceId/sessions",
  });
  return createRouter({
    routeTree: rootRoute.addChildren([indexRoute, workspaceSessionsRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

describe("onboarding return path", () => {
  test("a path with no page is not an app page; home and deep links are", () => {
    const router = appRouter("/");
    expect(pathHasAppPage(router, "/sign-in")).toBe(false);
    expect(pathHasAppPage(router, "/")).toBe(true);
    expect(pathHasAppPage(router, "/workspaces/w1/sessions")).toBe(true);
  });

  test("finishing onboarding on /sign-in goes home instead of Page not found", async () => {
    const router = appRouter("/sign-in?from=site");
    await router.load();
    await leaveOnboardingPathWithoutPage(router);
    expect(router.state.location.pathname).toBe("/");
    // Replaced, so Back does not return to the missing page.
    expect(router.history.length).toBe(1);
  });

  test("a deep link the person opened before signing up is kept", async () => {
    const router = appRouter("/workspaces/w1/sessions");
    await router.load();
    await leaveOnboardingPathWithoutPage(router);
    expect(router.state.location.pathname).toBe("/workspaces/w1/sessions");
  });
});
