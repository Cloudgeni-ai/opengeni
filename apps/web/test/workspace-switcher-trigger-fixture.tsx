import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CheckIcon, SearchIcon } from "lucide-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import {
  OrganizationSwitcherLine,
  WORKSPACE_SWITCHER_GRID_CLASS,
} from "../src/components/rail/switcher-block";
import { WorkspaceMenu, WorkspaceSwitcherTrigger } from "../src/components/rail/workspace-switcher";
import { TooltipProvider } from "../src/components/ui/tooltip";
import type { ManagedSelfContext } from "../src/lib/managed-self-context";
import type { Workspace } from "../src/types";
import "../src/styles.css";

const accountId = "11111111-1111-4111-8111-111111111111";
const secondAccountId = "22222222-2222-4222-8222-222222222222";

function workspace(
  id: string,
  name: string,
  options: Readonly<{ accountId?: string; kind?: Workspace["kind"] }> = {},
): Workspace {
  return {
    id,
    accountId: options.accountId ?? accountId,
    kind: options.kind ?? "shared",
    name,
    slug: null,
    externalSource: null,
    externalId: null,
    agentInstructions: null,
    settings: {},
    inferenceControl: {
      state: "active",
      revision: 1,
      reason: null,
      changedBy: null,
      changedAt: "2026-08-21T10:00:00.000Z",
    },
    createdAt: "2026-08-21T10:00:00.000Z",
    updatedAt: "2026-08-21T10:00:00.000Z",
  };
}

const workspaces = [
  workspace("workspace-default", "Default workspace"),
  workspace("workspace-product", "Product Testing"),
  workspace("workspace-personal", "Personal workspace", { kind: "personal" }),
  workspace("workspace-research", "Research Sandbox", { accountId: secondAccountId }),
];

const organizations = [
  {
    accountId,
    label: "CloudGeni Product Engineering and Reliability",
    canManage: true,
  },
  {
    accountId: secondAccountId,
    label: "CloudGeni Research",
    canManage: false,
  },
];

const selfContext: ManagedSelfContext = {
  identity: {
    credentialGeneration: 1,
    managedUserId: "user-one",
    subjectId: "user:user-one",
  },
  memberships: [
    {
      id: "membership-one",
      organizationId: accountId,
      status: "active",
      personalWorkspaceId: "workspace-personal",
    },
  ],
};

function WorkspaceSwitcherFixture() {
  const collapsed = new URLSearchParams(window.location.search).get("mode") === "collapsed";
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("workspace-personal");
  const [lastAction, setLastAction] = useState("None");
  const activeWorkspace =
    workspaces.find((candidate) => candidate.id === activeWorkspaceId) ?? workspaces[0]!;
  return (
    <TooltipProvider>
      <main className="flex min-h-screen bg-background text-foreground">
        <aside
          data-testid="production-rail"
          className={
            collapsed
              ? "flex w-14 min-w-0 flex-col overflow-hidden border-r border-border bg-surface/40 py-4"
              : "flex w-full min-w-0 flex-col overflow-hidden border-r border-border bg-surface/40 py-4 sm:w-[244px]"
          }
        >
          <div className="mb-5 flex min-w-0 items-center gap-2 px-3 text-sm font-semibold">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand text-xs font-bold text-white">
              OG
            </span>
            {collapsed ? null : <span className="min-w-0 truncate">OpenGeni</span>}
          </div>
          <section aria-label="Workspace switcher preview">
            {collapsed ? (
              <WorkspaceMenu
                collapsed
                orgs={organizations}
                workspaces={workspaces}
                activeWorkspaceId={activeWorkspaceId}
                canCreate
                onSelect={setActiveWorkspaceId}
                onCreate={() => setLastAction("New workspace")}
                managedSelfContext={selfContext}
                align="start"
              >
                <WorkspaceSwitcherTrigger
                  activeWorkspace={activeWorkspace}
                  activeOrganizationLabel="CloudGeni Product Engineering and Reliability"
                  personal={activeWorkspace.kind === "personal"}
                  collapsed
                />
              </WorkspaceMenu>
            ) : (
              <div className={WORKSPACE_SWITCHER_GRID_CLASS}>
                <OrganizationSwitcherLine
                  orgs={organizations}
                  currentLabel="CloudGeni Product Engineering and Reliability"
                  activeAccountId={accountId}
                  onSelect={() => {}}
                  workspaceId={null}
                />
                <WorkspaceMenu
                  collapsed={false}
                  orgs={organizations}
                  workspaces={workspaces}
                  activeWorkspaceId={activeWorkspaceId}
                  canCreate
                  onSelect={(workspaceId) => {
                    const selected = workspaces.find((candidate) => candidate.id === workspaceId)!;
                    setActiveWorkspaceId(workspaceId);
                    setLastAction(`Opened ${selected.name}`);
                  }}
                  onCreate={() => setLastAction("New workspace")}
                  managedSelfContext={selfContext}
                  align="start"
                >
                  <WorkspaceSwitcherTrigger
                    activeWorkspace={activeWorkspace}
                    activeOrganizationLabel="CloudGeni Product Engineering and Reliability"
                    personal={activeWorkspace.kind === "personal"}
                    collapsed={false}
                  />
                </WorkspaceMenu>
              </div>
            )}
          </section>

          {collapsed ? null : (
            <>
              <label className="mt-5 flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-fg-subtle">
                <SearchIcon className="size-3.5" />
                <span>Search sessions</span>
              </label>
              <div className="mt-4 grid gap-1 text-sm">
                <p className="px-2 py-1 font-medium">Sessions</p>
                <p className="rounded-md bg-surface-2 px-2 py-2 text-fg-muted">
                  Review workspace switcher
                </p>
                <p className="px-2 py-2 text-fg-subtle">Tool selection redesign</p>
              </div>
            </>
          )}

          <output data-testid="last-action" className="sr-only">
            {lastAction}
          </output>
        </aside>
        {collapsed ? (
          <section className="flex flex-1 items-start justify-center p-8">
            <div className="w-full max-w-xl rounded-xl border border-border bg-surface-1 p-8">
              <CheckIcon className="mb-3 size-5 text-status-success" />
              <h1 className="text-lg font-semibold">Workspace switcher interaction check</h1>
              <p className="mt-2 text-sm text-fg-muted">
                The collapsed rail keeps its tooltip while the same button remains keyboard and
                pointer accessible.
              </p>
            </div>
          </section>
        ) : (
          <section className="hidden flex-1 items-start justify-center p-10 sm:flex">
            <div className="w-full max-w-2xl rounded-xl border border-border bg-surface-1 p-10">
              <p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">
                Workspace
              </p>
              <h1 className="mt-2 text-xl font-semibold">Session overview</h1>
              <p className="mt-2 max-w-lg text-sm text-fg-muted">
                Open the workspace selector to move between shared and personal workspaces.
              </p>
            </div>
          </section>
        )}
      </main>
    </TooltipProvider>
  );
}

const rootRoute = createRootRoute({ component: WorkspaceSwitcherFixture });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$workspaceId/settings",
});
const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
