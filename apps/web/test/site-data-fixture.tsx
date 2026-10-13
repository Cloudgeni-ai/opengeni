import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ArtifactDetailRoute } from "../src/routes/artifacts";
import { artifactReturnSearch } from "../src/lib/routes";
import { siteId, workspaceId } from "./site-data-context";
import "../src/styles.css";

const root = createRootRoute({
  component: () => (
    <main className="flex min-h-dvh min-w-0 flex-col bg-bg text-fg">
      <Outlet />
    </main>
  ),
});
const site = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts/$artifactId",
  validateSearch: artifactReturnSearch,
  component: () => <ArtifactDetailRoute {...site.useParams()} />,
});
const library = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts",
  validateSearch: artifactReturnSearch,
  component: () => null,
});
const router = createRouter({
  routeTree: root.addChildren([site, library]),
  history: createMemoryHistory({
    initialEntries: [`/workspaces/${workspaceId}/artifacts/${siteId}`],
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
