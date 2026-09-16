import { createRoot } from "react-dom/client";
import { useState } from "react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createHashHistory,
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

const workspaceId = "5d929faa-c755-4146-9d60-e55f42251f0d";
const sessionId = "cf39f8d3-673f-43c0-9f98-c2787fdcf84e";
const siteId = "dc24100a-e408-4713-9c12-ef41e3964f6a";
const documentId = "d10307ab68064d36855af499c9e3ccc7";
const spreadsheetId = "475e389ff5d34f63b308f4901f52492b";
const presentationId = "a0cc8ea0a2284b8dbc951820d0093a08";
const unknownEditableId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const fileId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const knownEditables = new Set([documentId, spreadsheetId, presentationId]);
const nativeTitles: Record<string, string> = {
  [documentId]: "Native document editor",
  [spreadsheetId]: "Native spreadsheet editor",
  [presentationId]: "Native presentation editor",
  [unknownEditableId]: "Native unknown editor",
};
const sessionPath = `/workspaces/${workspaceId}/sessions/${sessionId}`;
const fixtureSearch = new URLSearchParams(location.search);
if (!location.hash) {
  const entry = fixtureSearch.get("entry") ?? sessionPath;
  history.replaceState(null, "", `${location.pathname}#${entry}`);
}
let opened = false;
let openedId = siteId;
function Preview() {
  return (
    <div className="h-full bg-bg p-8 text-fg">
      <p className="text-xs uppercase tracking-widest text-fg-subtle">Published Site</p>
      <h1 className="mt-3 text-3xl font-semibold">Project overview</h1>
      <p className="mt-4 text-fg-muted">Your session stays one click away.</p>
    </div>
  );
}
function DockPreview() {
  if (openedId === fileId) {
    return (
      <div className="h-full bg-bg p-8 text-fg">
        <h1>Retained file preview</h1>
      </div>
    );
  }
  if (knownEditables.has(openedId)) {
    return (
      <div className="h-full bg-bg p-8 text-fg">
        <h1>{nativeTitles[openedId]}</h1>
      </div>
    );
  }
  return <Preview />;
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
          onOpen={(target) => {
            if (target.editable && !knownEditables.has(target.id)) return false;
            opened = true;
            openedId = target.id;
            setActiveTab("artifacts");
            setCollapsed(false);
            return true;
          }}
        >
          <div className="flex h-full flex-col bg-bg p-8 text-fg">
            <h1 className="mb-8 text-lg font-semibold">Build a project overview</h1>
            <MarkdownText
              text={[
                `Your Site is ready. [Open Project overview](/workspaces/${workspaceId}/artifacts/${siteId})`,
                `[Open Alpha document](/workspaces/${workspaceId}/artifacts/editable/${documentId})`,
                `[Open Alpha spreadsheet](/workspaces/${workspaceId}/artifacts/editable/${spreadsheetId})`,
                `[Open Alpha presentation](/workspaces/${workspaceId}/artifacts/editable/${presentationId})`,
                `[Open unknown artifact](/workspaces/${workspaceId}/artifacts/editable/${unknownEditableId})`,
                `[Open retained file](/workspaces/${workspaceId}/artifacts/files/${fileId})`,
              ].join("\n\n")}
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
                  to={
                    openedId === fileId
                      ? "/workspaces/$workspaceId/artifacts/files/$artifactId"
                      : knownEditables.has(openedId)
                        ? "/workspaces/$workspaceId/artifacts/editable/$artifactId"
                        : "/workspaces/$workspaceId/artifacts/$artifactId"
                  }
                  params={{ workspaceId, artifactId: openedId }}
                  search={{ fromSession: sessionId }}
                >
                  Open Project overview full-page
                </Link>
              </div>
              <DockPreview />
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
        <div className="min-h-0 flex-1 p-4">
          <Link
            to="/workspaces/$workspaceId/artifacts"
            params={{ workspaceId }}
            search={fromSession ? { fromSession } : {}}
          >
            All artifacts
          </Link>
          <Preview />
        </div>
      </ArtifactSessionPage>
    );
  },
});
const native = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts/editable/$artifactId",
  validateSearch: artifactReturnSearch,
  component: () => {
    const { artifactId } = native.useParams();
    const { fromSession } = native.useSearch();
    return (
      <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession} showAllArtifacts>
        <div className="min-h-0 flex-1 p-4">
          <h1>{nativeTitles[artifactId] ?? "Native unknown editor"}</h1>
          <p>Ready</p>
        </div>
      </ArtifactSessionPage>
    );
  },
});
const retained = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts/files/$artifactId",
  validateSearch: artifactReturnSearch,
  component: () => {
    const { fromSession } = retained.useSearch();
    return (
      <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession} showAllArtifacts>
        <div className="min-h-0 flex-1 p-4">
          <h1>Retained file</h1>
        </div>
      </ArtifactSessionPage>
    );
  },
});
const library = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts",
  validateSearch: artifactReturnSearch,
  component: () => {
    const { fromSession } = library.useSearch();
    return (
      <ArtifactSessionPage workspaceId={workspaceId} fromSession={fromSession}>
        <h1>Workspace artifacts</h1>
      </ArtifactSessionPage>
    );
  },
});
const router = createRouter({
  routeTree: root.addChildren([session, artifact, native, retained, library]),
  history: createHashHistory(),
});
document.addEventListener("click", (event) => {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!link || link.hasAttribute("download")) return;
  const href = link.getAttribute("href") ?? "";
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:"))
    return;
  let url: URL;
  try {
    url = new URL(href, location.origin);
  } catch {
    return;
  }
  if (url.origin !== location.origin || !url.pathname.startsWith("/workspaces/")) return;
  event.preventDefault();
  router.history.push(`${url.pathname}${url.search}`);
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
