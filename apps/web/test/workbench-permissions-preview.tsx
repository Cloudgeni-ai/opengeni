import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { KnowledgePage } from "../src/components/knowledge/knowledge-page";
import { WorkspaceShortcutLinks } from "../src/components/rail/primary-nav";
import { RailProvider } from "@opengeni/react/app/components/rail/rail-context";
import { PersonalResourceAttachmentSurface } from "@opengeni/react/app/components/personal-resource-attachment-surface";
import {
  useFixedRigScope,
  usePersonalResourceAttachment,
} from "@opengeni/react/app/lib/use-personal-resource-attachment";
import { hasWorkspacePermission } from "@opengeni/react/app/lib/permissions";
import { parseKnowledgeSearch } from "../src/lib/knowledge-route";
import { useAppContext, workspaceId, rigId } from "./workbench-permissions-preview-context";
import "../src/styles.css";

function Preview() {
  const context = useAppContext();
  const workspace = context.workspaces[0]!;
  const fixedRigScope = useFixedRigScope(
    context.client,
    workspaceId,
    rigId,
    hasWorkspacePermission(context.accessContext, workspaceId, "rigs:use"),
  );
  const controller = usePersonalResourceAttachment({
    client: context.client,
    accessContext: context.accessContext,
    accessSubjectId: context.accessContext.subjectId,
    authMode: "managedSession",
    authSession: context.authSession,
    managedSelfContext: context.managedSelfContext,
    workspace,
    fixed: { rigId, rigScope: fixedRigScope, connectedMachine: null },
    personalWorkspaceTarget: false,
  });
  useEffect(() => {
    window.permissionPreview.resourceState = {
      rigs: controller.catalog?.rigs.length ?? 0,
      machines: controller.catalog?.connectedMachineAuthorities.length ?? 0,
      blocked: controller.requiresDecision,
    };
  }, [controller]);
  const search = route.useSearch();
  return (
    <RailProvider workspaceId={workspaceId}>
      <div className="flex min-h-screen flex-col bg-canvas text-fg">
        <p className="px-4 py-2 text-xs text-fg-muted">
          Sample data · production Knowledge, navigation and resource-status components
        </p>
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <nav aria-label="Workspace" className="w-full shrink-0 bg-surface p-2 lg:w-60">
            <WorkspaceShortcutLinks />
          </nav>
          <main data-canvas className="min-w-0 flex-1">
            <KnowledgePage workspaceId={workspaceId} search={search} />
            <div className="px-6 pb-6">
              <PersonalResourceAttachmentSurface controller={controller} />
            </div>
          </main>
        </div>
      </div>
    </RailProvider>
  );
}
const root = createRootRoute();
const route = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/state",
  validateSearch: parseKnowledgeSearch,
  component: Preview,
});
const router = createRouter({
  routeTree: root.addChildren([route]),
  history: createMemoryHistory({ initialEntries: [`/workspaces/${workspaceId}/state`] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
