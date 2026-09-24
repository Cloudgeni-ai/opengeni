import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RetainedArtifactRoute } from "../src/routes/retained-artifact";
import { InlineChatArtifact } from "../src/components/artifacts/retained-file-preview";
import { SessionEditableArtifactsWorkspace } from "../src/components/session/editable-artifacts-workspace";
import { workspaceId, artifactId } from "./retained-text-preview-context";
import "../src/styles.css";
const params = new URLSearchParams(location.search);
if (params.has("light")) document.documentElement.dataset.ogTheme = "light";
const root = createRootRoute({
  component: () => (
    <main className="min-h-dvh bg-bg text-fg">
      <div className="border-b border-border px-6 py-3 text-xs text-fg-muted">
        OPE-557 · Actual component verification · Sample patch, fixture API · Not production
      </div>
      <section className="mx-auto max-w-5xl py-5">
        {params.has("workbench") ? (
          <div className="h-[680px] min-w-0">
            <SessionEditableArtifactsWorkspace
              workspaceId={workspaceId}
              artifacts={[
                { id: artifactId, modality: "file", title: "ope551-integration-docs.patch" },
              ]}
              status="ready"
              onRetry={() => {}}
              initialSelectedArtifactId={artifactId}
            />
          </div>
        ) : params.has("chat") ? (
          <InlineChatArtifact
            workspaceId={workspaceId}
            artifactId={artifactId}
            alt="Sample patch"
          />
        ) : (
          <RetainedArtifactRoute
            workspaceId={workspaceId}
            artifactId={artifactId}
            embedded={!params.has("standalone")}
          />
        )}
      </section>
    </main>
  ),
});
const router = createRouter({
  routeTree: root,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
