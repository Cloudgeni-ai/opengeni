import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ArtifactsRoute } from "../src/routes/artifacts";
import { RetainedArtifactRoute } from "../src/routes/retained-artifact";
import { SessionEditableArtifactsWorkspace } from "../src/components/session/editable-artifacts-workspace";
import { artifactReturnSearch } from "../src/lib/routes";
import {
  workspaceId,
  sessionId,
  items,
  updateFixtureArtifactPin,
} from "./artifact-library-context";
import "../src/styles.css";

const root = createRootRoute({
  component: () => (
    <main className="flex h-dvh min-w-0 flex-col bg-bg text-fg">
      <Outlet />
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
const session = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sessions/$sessionId",
  component: function SessionFixture() {
    const [, setPinRevision] = useState(0);
    return (
      <SessionEditableArtifactsWorkspace
        workspaceId={workspaceId}
        sessionId={sessionId}
        artifacts={items.map((item) => ({
          id: item.id,
          title: item.title,
          modality: item.kind,
          catalogItem: item,
        }))}
        status="ready"
        onRetry={() => {}}
        onPin={async (item, pinned) => {
          await updateFixtureArtifactPin(item, pinned);
          setPinRevision((revision) => revision + 1);
        }}
      />
    );
  },
});
const start = new URLSearchParams(location.search).get("session")
  ? `/workspaces/${workspaceId}/sessions/${sessionId}`
  : `/workspaces/${workspaceId}/artifacts`;
const router = createRouter({
  routeTree: root.addChildren([library, file, session]),
  history: createMemoryHistory({ initialEntries: [start] }),
});
Reflect.set(window, "artifactLibraryRouter", router);
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
