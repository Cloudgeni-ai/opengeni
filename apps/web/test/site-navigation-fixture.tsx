// Site navigation, with real components: the Artifacts page, the Site view it
// opens, and a session's workspace panel showing a Site. Only the API, the
// chat column and the machine status are stand-ins.
//
// Load with `?scenario=sites` (the Site data) and optionally:
// `theme=dark|light`, `desktop=macos|windows` (the desktop app's window bar),
// `entry=<app path>` (where to start; the Artifacts page by default).
import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { ArtifactCatalogItem, ArtifactCatalogListOptions } from "@opengeni/sdk";
import { OpenGeniProvider, WorkspaceDock } from "@opengeni/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { Toaster } from "sonner";
import { ArtifactsRoute } from "@opengeni/react/app/routes/artifacts";
import { SiteViewRoute } from "@opengeni/react/app/routes/site-view";
import { SessionEditableArtifactsWorkspace } from "@opengeni/react/app/components/session/editable-artifacts-workspace";
import {
  artifactReturnSearch,
  siteViewArtifactsReturn,
  siteViewSearch,
} from "@opengeni/react/app/lib/routes";
import {
  defaultArtifactFilters,
  filterArtifactCatalog,
} from "@opengeni/react/app/lib/artifact-catalog";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import {
  checklistSiteId,
  client,
  ipoSiteId,
  pricingSiteId,
  usageSiteId,
  useAppContext,
  workspaceId,
} from "./session-sidebar-context";
import "../src/styles.css";

const parameters = new URLSearchParams(window.location.search);
const theme = parameters.get("theme");
if (theme === "dark" || theme === "light") {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.ogTheme = theme;
}
const desktop = parameters.get("desktop");
if (desktop && desktop !== "browser") document.documentElement.dataset.desktop = desktop;

const sessionId = "00000000-0000-4000-9000-000000000901";
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const sites: [string, string][] = [
  [usageSiteId, "Opengeni usage"],
  [ipoSiteId, "IPO research dashboard"],
  [pricingSiteId, "Pricing calculator"],
  [checklistSiteId, "Launch checklist"],
];
const others: [ArtifactCatalogItem["kind"], string][] = [
  ["document", "Launch brief"],
  ["spreadsheet", "Growth forecast"],
  ["presentation", "Quarterly review"],
  ["document", "Hiring plan"],
  ["spreadsheet", "Vendor costs"],
  ["presentation", "Board update"],
  ["document", "Security review"],
  ["spreadsheet", "Support volume"],
  ["document", "Onboarding guide"],
  ["presentation", "Customer kickoff"],
  ["document", "Release notes"],
  ["spreadsheet", "Pipeline"],
];
const items: ArtifactCatalogItem[] = [
  ...sites.map(([id, title], index) => ({
    id,
    kind: "site" as const,
    title,
    status: "active" as const,
    sourceSessionId: sessionId,
    createdAt: day(index + 1),
    updatedAt: day(index + 1),
    versionId: "version",
  })),
  ...others.map(([kind, title], index) => ({
    id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
    kind,
    title,
    status: "active" as const,
    sourceSessionId: sessionId,
    createdAt: day(index + 2),
    updatedAt: day(index + 2),
    versionId: "version",
  })),
];
Object.assign(client, {
  async listArtifactCatalog(_workspaceId: string, options: ArtifactCatalogListOptions = {}) {
    return {
      items: filterArtifactCatalog(items, {
        ...defaultArtifactFilters,
        ...options,
        q: options.q ?? "",
        kind: options.kind ?? "all",
      }),
      nextCursor: null,
    };
  },
  async updateArtifactPin() {
    return { pinned: false };
  },
});
Object.assign(useAppContext(), { accessKeyVersion: 0, busy: false });

/** The app rail's top: enough to leave a page the way the app does. */
function Rail() {
  return (
    <aside
      aria-label="Workspace sidebar"
      className="flex h-dvh w-[240px] shrink-0 flex-col border-r border-border bg-surface"
    >
      <header className="shrink-0 px-5 pb-4 pt-5">
        <p className="text-sm font-medium">Product engineering</p>
        <p className="mt-1 text-xs text-fg-subtle">Shared workspace</p>
      </header>
      <nav className="flex flex-col gap-0.5 px-2 text-sm">
        <Link
          to="/workspaces/$workspaceId/artifacts"
          params={{ workspaceId }}
          className="rounded-md px-3 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          Artifacts
        </Link>
        <Link
          to="/workspaces/$workspaceId/sessions/$sessionId"
          params={{ workspaceId, sessionId }}
          className="rounded-md px-3 py-1.5 text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          Usage dashboard chat
        </Link>
      </nav>
    </aside>
  );
}

const root = createRootRoute({
  component: () => (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
        <main className="flex h-dvh min-w-0 bg-bg text-fg">
          <Rail />
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Outlet />
          </section>
        </main>
        <Toaster />
      </TooltipProvider>
    </OpenGeniProvider>
  ),
});
const preview = createRoute({
  getParentRoute: () => root,
  path: "/test/site-navigation.html",
});
const library = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/artifacts",
  validateSearch: artifactReturnSearch,
  component: () => <ArtifactsRoute workspaceId={workspaceId} {...library.useSearch()} />,
});
const site = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sites/$siteId",
  // As the console registers it.
  validateSearch: siteViewSearch,
  component: function SiteFixture() {
    const { siteId } = site.useParams();
    const search = site.useSearch();
    return (
      <SiteViewRoute
        key={siteId}
        workspaceId={workspaceId}
        siteId={siteId}
        conversation={search.conversation}
        startNew={search.new === true}
        page={search.page}
        artifactsReturn={siteViewArtifactsReturn(search)}
      />
    );
  },
});

/** The dock's machine status, drawn as SandboxWorkspace draws it. */
function MachineStatus() {
  return (
    <div
      role="status"
      aria-label="Machine: Sleeping · saved 11h ago"
      title="Sleeping · saved 11h ago"
      className="inline-flex min-h-7 min-w-0 max-w-full items-center gap-1.5 px-2 py-1 text-og-xs font-medium text-og-fg-muted max-[1023px]:min-h-11 pointer-coarse:min-h-11"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-og-fg-subtle" aria-hidden />
      <span className="min-w-0 max-w-[11rem] truncate">Sleeping · saved 11h ago</span>
    </div>
  );
}

function Placeholder({ title }: { title: string }) {
  return <div className="p-4 text-sm text-fg-muted">{title}</div>;
}

const session = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sessions/$sessionId",
  component: function SessionFixture() {
    const [tab, setTab] = useState("artifacts");
    const [collapsed, setCollapsed] = useState(false);
    return (
      <WorkspaceDock
        autoSaveId="site-navigation-fixture"
        defaultSize={62}
        activeTab={tab}
        onActiveTabChange={setTab}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        showCollapseControl
        headerAccessory={<MachineStatus />}
        primary={
          <div className="flex h-full flex-col gap-4 overflow-hidden bg-bg p-6 text-sm leading-6 text-fg">
            <p className="ml-auto max-w-[80%] rounded-xl bg-surface-2 px-4 py-3">
              Can the date range apply to every graph at once?
            </p>
            <p>
              Yes. The range picker at the top now filters all four graphs together. I've updated
              your Site: Opengeni usage.
            </p>
          </div>
        }
        tabs={[
          { id: "changes", label: "Changes", content: <Placeholder title="Changes" /> },
          { id: "files", label: "Files", content: <Placeholder title="Files" /> },
          { id: "terminal", label: "Terminal", content: <Placeholder title="Terminal" /> },
          {
            id: "artifacts",
            label: "Artifacts",
            content: (
              <SessionEditableArtifactsWorkspace
                workspaceId={workspaceId}
                sessionId={sessionId}
                artifacts={items.slice(0, 2).map((item) => ({
                  id: item.id,
                  title: item.title,
                  modality: item.kind,
                  catalogItem: item,
                }))}
                initialSelectedArtifactId={`site:${usageSiteId}`}
                status="ready"
                onRetry={() => {}}
              />
            ),
          },
        ]}
      />
    );
  },
});
const router = createRouter({
  routeTree: root.addChildren([preview, library, site, session]),
});
Reflect.set(window, "siteNavigationRouter", router);
void router.navigate({
  href: parameters.get("entry") ?? `/workspaces/${workspaceId}/artifacts`,
  replace: true,
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
