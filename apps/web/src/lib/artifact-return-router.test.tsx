import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ArtifactSessionPage } from "@/components/session/artifact-session-page";
import { artifactReturnSearch } from "./routes";

const workspaceId = "5d929faa-c755-4146-9d60-e55f42251f0d";
const sessionId = "cf39f8d3-673f-43c0-9f98-c2787fdcf84e";
const siteId = "dc24100a-e408-4713-9c12-ef41e3964f6a";
const editableId = "d10307ab68064d36855af499c9e3ccc7";
const libraryPath = `/workspaces/${workspaceId}/artifacts`;
const paths = [
  "artifacts",
  `artifacts/${siteId}`,
  `artifacts/files/${siteId}`,
  `artifacts/editable/${editableId}`,
];

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://example.test" });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

for (const path of paths) {
  for (const fromSession of [
    undefined,
    "",
    "https://evil.example",
    "../sessions",
    12,
    [sessionId],
    sessionId,
  ]) {
    test(`${path} uses validated return context for ${JSON.stringify(fromSession)}`, async () => {
      const rootRoute = createRootRoute({ component: Outlet });
      const workspace = createRoute({
        getParentRoute: () => rootRoute,
        path: "workspaces/$workspaceId",
        component: Outlet,
      });
      let observed: unknown;
      function artifactRoute(routePath: string) {
        const route = createRoute({
          getParentRoute: () => workspace,
          path: routePath,
          validateSearch: artifactReturnSearch,
          component: () => {
            const search = route.useSearch() as ReturnType<typeof artifactReturnSearch>;
            observed = search.fromSession;
            return (
              <ArtifactSessionPage workspaceId={workspaceId} fromSession={search.fromSession}>
                <Link
                  to="/workspaces/$workspaceId/artifacts"
                  params={{ workspaceId }}
                  search={search.fromSession ? { fromSession: search.fromSession } : {}}
                >
                  All artifacts
                </Link>
              </ArtifactSessionPage>
            );
          },
        });
        return route;
      }
      const routes = paths.map(artifactRoute);
      const session = createRoute({
        getParentRoute: () => workspace,
        path: "sessions/$sessionId",
        component: () => <h1>Session</h1>,
      });
      const query =
        fromSession === undefined
          ? ""
          : `?${new URLSearchParams({ fromSession: typeof fromSession === "string" ? fromSession : JSON.stringify(fromSession) })}`;
      const router = createRouter({
        routeTree: rootRoute.addChildren([workspace.addChildren([...routes, session])]),
        history: createMemoryHistory({
          initialEntries: [`/workspaces/${workspaceId}/${path}${query}`],
        }),
      });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          await router.load();
          root.render(<RouterProvider router={router} />);
        });
        const valid = fromSession === sessionId;
        expect(observed).toBe(valid ? sessionId : undefined);
        const all = [...container.querySelectorAll("a")].find(
          (link) => link.textContent === "All artifacts",
        )!;
        const back = [...container.querySelectorAll("a")].find((link) =>
          link.textContent?.includes("Back to session"),
        );
        expect(Boolean(back)).toBe(valid);
        expect(all.getAttribute("href")).toBe(
          `${libraryPath}${valid ? `?fromSession=${sessionId}` : ""}`,
        );
        if (valid)
          expect(back!.getAttribute("href")).toBe(
            `/workspaces/${workspaceId}/sessions/${sessionId}`,
          );
        await act(async () => all.click());
        expect(router.state.location.pathname).toBe(libraryPath);
        expect(router.state.location.searchStr).toBe(valid ? `?fromSession=${sessionId}` : "");
      } finally {
        await act(async () => root.unmount());
        container.remove();
      }
    });
  }
}
