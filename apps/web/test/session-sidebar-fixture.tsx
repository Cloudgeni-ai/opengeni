import { createRoot } from "react-dom/client";
import { useState } from "react";
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
import { Toaster } from "sonner";
import { SessionList } from "@opengeni/react/app/components/rail/session-list";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import {
  sessionBrowsePreferenceStorageId,
  writeSessionBrowsePreferences,
} from "@opengeni/react/app/lib/session-browse-preferences";
import { client, evidence, subjectId, workspaceId } from "./session-sidebar-context";
import "../src/styles.css";

function RequestProfile() {
  const [snapshot, setSnapshot] = useState("");
  if (!new URLSearchParams(window.location.search).has("profile")) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          const counts: Record<string, number> = {};
          for (const call of evidence.listCalls) {
            const key = JSON.stringify(call.options);
            counts[key] = (counts[key] ?? 0) + 1;
          }
          setSnapshot(JSON.stringify({ elapsedMs: performance.now(), counts }, null, 2));
        }}
      >
        Sample request counts
      </button>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-left text-xs">{snapshot}</pre>
    </div>
  );
}

writeSessionBrowsePreferences(sessionBrowsePreferenceStorageId(subjectId, workspaceId), {
  // Sparse activity starts ungrouped so project auto-hydration cannot populate
  // additional running roots before the test uses the real Group by menu.
  groupBy: ["sparse-active", "hover"].includes(
    new URLSearchParams(window.location.search).get("scenario") ?? "",
  )
    ? "none"
    : new URLSearchParams(window.location.search).get("scenario") === "keyboard-focus"
      ? "activity"
      : "project",
  sortBy: "updatedAt",
  status: "active",
  mineOnly: false,
  showEmptyGroups: false,
});
Object.assign(window, { sessionSidebarQa: evidence });
const previewTheme = new URLSearchParams(window.location.search).get("theme");
if (previewTheme === "dark" || previewTheme === "light") {
  document.documentElement.classList.toggle("dark", previewTheme === "dark");
  document.documentElement.dataset.ogTheme = previewTheme;
}

const root = createRootRoute({
  component: () => (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
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
          startNew={siteViewSearch(location.search).new === true}
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
        <RequestProfile />
      </div>
    </section>
  );
}

const preview = createRoute({
  getParentRoute: () => root,
  path: "/test/session-sidebar-preview.html",
});
const session = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sessions/$sessionId",
});
const newSession = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sessions",
});
const site = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/sites/$siteId",
  // As the console registers it.
  validateSearch: siteViewSearch,
});
const router = createRouter({
  routeTree: root.addChildren([preview, session, newSession, site]),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
