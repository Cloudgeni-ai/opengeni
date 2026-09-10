import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
  Link,
} from "@tanstack/react-router";
import { WorkspaceDock } from "@opengeni/react";
import { MarkdownText } from "../src/components/markdown";
import { ArtifactLinkBoundary } from "../src/components/session/artifact-link-boundary";
import { ArtifactSessionPage } from "../src/components/session/artifact-session-page";
import { artifactReturnSearch } from "../src/lib/routes";
import "../src/styles.css";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const sessionId = "33333333-3333-4333-8333-333333333333";
const artifactId = "22222222-2222-4222-8222-222222222222";
const sessionPath = `/workspaces/${workspaceId}/sessions/${sessionId}`;
let opened = false;
function Preview() {
  return (
    <div className="h-full bg-bg p-8 text-fg">
      <p className="text-xs uppercase tracking-widest text-fg-subtle">Published Site</p>
      <h1 className="mt-3 text-3xl font-semibold">Project overview</h1>
      <p className="mt-4 text-fg-muted">Your session stays one click away.</p>
    </div>
  );
}
function Session() {
  const [activeTab, setActiveTab] = useState(opened ? "artifacts" : "files");
  const [collapsed, setCollapsed] = useState(!opened);
  return (
    <WorkspaceDock
      autoSaveId="artifact-navigation-browser-fixture"
      activeTab={activeTab}
      onActiveTabChange={setActiveTab}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      showCollapseControl
      primary={
        <ArtifactLinkBoundary
          workspaceId={workspaceId}
          onOpen={() => {
            opened = true;
            setActiveTab("artifacts");
            setCollapsed(false);
            return true;
          }}
        >
          <div className="flex h-full flex-col bg-bg p-8 text-fg">
            <h1 className="mb-8 text-lg font-semibold">Build a project overview</h1>
            <MarkdownText
              text={`Your Site is ready. [Open Project overview](/workspaces/${workspaceId}/artifacts/${artifactId})`}
            />
          </div>
        </ArtifactLinkBoundary>
      }
      tabs={[
        { id: "files", label: "Files", content: <div>Files</div> },
        {
          id: "artifacts",
          label: "Artifacts",
          content: (
            <div className="flex h-full flex-col">
              <div className="border-b border-border p-3">
                <Link
                  to="/workspaces/$workspaceId/artifacts/$artifactId"
                  params={{ workspaceId, artifactId }}
                  search={{ fromSession: sessionId }}
                >
                  Open Project overview full-page
                </Link>
              </div>
              <Preview />
            </div>
          ),
        },
      ]}
    />
  );
}
const root = createRootRoute({
  component: () => (
    <div className="flex h-dvh flex-col">
      <Outlet />
    </div>
  ),
});
const session = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sessions/$sessionId",
  component: Session,
});
const artifact = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts/$artifactId",
  validateSearch: artifactReturnSearch,
  component: () => {
    const { fromSession } = artifact.useSearch();
    return (
      <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession}>
        <Preview />
      </ArtifactSessionPage>
    );
  },
});
const router = createRouter({
  routeTree: root.addChildren([session, artifact]),
  history: createMemoryHistory({ initialEntries: [sessionPath] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
