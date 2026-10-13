import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Toaster } from "sonner";
import { ArtifactsRoute } from "../src/routes/artifacts";
import { artifactReturnSearch } from "../src/lib/routes";
import { siteId, workspaceId } from "./site-audience-context";
import "../src/styles.css";

const root = createRootRoute({
  component: () => (
    <main className="flex h-dvh min-w-0 flex-col bg-bg text-fg">
      <Outlet />
      <Toaster />
    </main>
  ),
});
const library = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts",
  validateSearch: artifactReturnSearch,
  component: () => <ArtifactsRoute workspaceId={workspaceId} />,
});
const detail = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts/$artifactId",
  validateSearch: artifactReturnSearch,
  component: () => <ArtifactsRoute workspaceId={workspaceId} {...detail.useParams()} />,
});
const start = new URLSearchParams(location.search).has("library")
  ? `/workspaces/${workspaceId}/artifacts`
  : `/workspaces/${workspaceId}/artifacts/${siteId}`;
const router = createRouter({
  routeTree: root.addChildren([library, detail]),
  history: createMemoryHistory({ initialEntries: [start] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
