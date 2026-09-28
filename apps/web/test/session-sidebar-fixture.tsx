import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { SessionList } from "../src/components/rail/session-list";
import { TooltipProvider } from "../src/components/ui/tooltip";
import {
  sessionBrowsePreferenceStorageId,
  writeSessionBrowsePreferences,
} from "../src/lib/session-browse-preferences";
import { client, evidence, subjectId, workspaceId } from "./session-sidebar-context";
import "../src/styles.css";

writeSessionBrowsePreferences(sessionBrowsePreferenceStorageId(subjectId, workspaceId), {
  // Sparse activity starts ungrouped so project auto-hydration cannot populate
  // additional running roots before the test uses the real Group by menu.
  groupBy:
    new URLSearchParams(window.location.search).get("scenario") === "sparse-active"
      ? "none"
      : new URLSearchParams(window.location.search).get("scenario") === "keyboard-focus"
        ? "activity"
        : "project",
  sortBy: "updatedAt",
  status: "active",
  showEmptyGroups: false,
});
Object.assign(window, { sessionSidebarQa: evidence });

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
          <section className="hidden min-w-0 flex-1 items-center justify-center p-12 md:flex">
            <div className="max-w-sm text-center">
              <h1 className="text-xl font-medium tracking-tight">Choose a chat</h1>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                Your projects and conversations are in the sidebar.
              </p>
              <p className="mt-8 text-xs text-fg-subtle">Real components · Sample workspace data</p>
            </div>
          </section>
        </main>
        <Toaster />
      </TooltipProvider>
    </OpenGeniProvider>
  ),
});

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
const router = createRouter({ routeTree: root.addChildren([preview, session, newSession]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
