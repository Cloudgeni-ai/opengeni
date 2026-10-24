// The ⌘K menu finding Sites, in the real sidebar and Site view with sample
// workspace data. Open with ?scenario=sites; press ⌘K (Ctrl+K) to search.
// ?sites=fail makes the Site search fail, to show the rest still works.
import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useRouterState,
} from "@tanstack/react-router";
import { SiteViewRoute } from "@opengeni/react/app/routes/site-view";
import { siteViewSearch } from "@opengeni/react/app/lib/routes";
import { ActionsProvider } from "@opengeni/react/app/lib/actions/actions-provider";
import { Toaster } from "sonner";
import { SessionList } from "@opengeni/react/app/components/rail/session-list";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import {
  sessionBrowsePreferenceStorageId,
  writeSessionBrowsePreferences,
} from "@opengeni/react/app/lib/session-browse-preferences";
import { client, subjectId, workspaceId } from "./command-menu-sites-context";
import "../src/styles.css";

writeSessionBrowsePreferences(sessionBrowsePreferenceStorageId(subjectId, workspaceId), {
  groupBy: "project",
  sortBy: "updatedAt",
  status: "active",
  mineOnly: false,
  showEmptyGroups: false,
});
const previewTheme = new URLSearchParams(window.location.search).get("theme");
if (previewTheme === "dark" || previewTheme === "light") {
  document.documentElement.classList.toggle("dark", previewTheme === "dark");
  document.documentElement.dataset.ogTheme = previewTheme;
}

const root = createRootRoute({
  component: () => (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
        <ActionsProvider>
          <main className="flex h-dvh min-w-0 bg-bg text-fg">
            <aside
              aria-label="Workspace sidebar"
              className="flex h-dvh w-full shrink-0 flex-col border-r border-border bg-surface md:w-[288px]"
            >
              <header className="shrink-0 px-6 pb-5 pt-6">
                <p className="text-sm font-medium">Product engineering</p>
                <p className="mt-1 text-xs text-fg-subtle">Shared workspace</p>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
                <SessionList />
              </div>
              <footer className="shrink-0 border-t border-border px-6 py-4 text-xs text-fg-muted">
                Alex Morgan
              </footer>
            </aside>
            <MainArea />
          </main>
        </ActionsProvider>
        <Toaster />
      </TooltipProvider>
    </OpenGeniProvider>
  ),
});

/** The Site view where the app shows it; otherwise the empty chat page. */
function MainArea() {
  const location = useRouterState({ select: (state) => state.location });
  const siteId = /\/sites\/([^/]+)/u.exec(location.pathname)?.[1];
  if (siteId)
    return (
      <section className="hidden min-h-0 min-w-0 flex-1 md:flex">
        <SiteViewRoute
          key={siteId}
          workspaceId={workspaceId}
          siteId={siteId}
          conversation={siteViewSearch(location.search).conversation}
        />
      </section>
    );
  return (
    <section className="hidden min-w-0 flex-1 items-center justify-center p-12 md:flex">
      <div className="max-w-sm text-center">
        <h1 className="text-xl font-medium tracking-tight">Choose a chat</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Your projects and conversations are in the sidebar.
        </p>
        <p className="mt-8 text-xs text-fg-subtle">Real components · Sample workspace data</p>
      </div>
    </section>
  );
}

const preview = createRoute({
  getParentRoute: () => root,
  path: "/test/command-menu-sites-preview.html",
});
const session = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sessions/$sessionId",
});
const site = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sites/$siteId",
  validateSearch: siteViewSearch,
});
const router = createRouter({ routeTree: root.addChildren([preview, session, site]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
