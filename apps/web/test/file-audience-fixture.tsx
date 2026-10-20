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
import { RetainedArtifactRoute } from "../src/routes/retained-artifact";
import { artifactReturnSearch } from "../src/lib/routes";
import { draftId, othersId, workspaceId } from "./file-audience-context";
import "../src/styles.css";

// `?library` opens the Artifacts library, `?others` someone else's Only me
// file, and otherwise the owner's own Only me file.
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
  component: () => <ArtifactsRoute workspaceId={workspaceId} {...library.useSearch()} />,
});
const file = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts/files/$artifactId",
  validateSearch: artifactReturnSearch,
  component: () => <RetainedArtifactRoute {...file.useParams()} {...file.useSearch()} />,
});
const params = new URLSearchParams(location.search);
const start = params.has("library")
  ? `/workspaces/${workspaceId}/artifacts`
  : `/workspaces/${workspaceId}/artifacts/files/${params.has("others") ? othersId : draftId}?browse=true`;
const router = createRouter({
  routeTree: root.addChildren([library, file]),
  history: createMemoryHistory({ initialEntries: [start] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
