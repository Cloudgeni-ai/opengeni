import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { SessionList } from "../src/components/rail/session-list";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { client, workspaceId, evidence } from "./project-rename-context";
import "../src/styles.css";
import {
  sessionBrowsePreferenceStorageId,
  writeSessionBrowsePreferences,
} from "../src/lib/session-browse-preferences";

writeSessionBrowsePreferences(sessionBrowsePreferenceStorageId("rename-qa", workspaceId), {
  groupBy: "project",
  sortBy: "updatedAt",
  status: "active",
  showEmptyGroups: true,
});
Object.assign(window, { renameQa: evidence });
const root = createRootRoute({
  component: () => (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
        <main className="flex h-dvh bg-bg text-fg">
          <aside className="flex w-[280px] flex-col border-r border-border bg-surface p-3">
            <SessionList />
          </aside>
          <section className="p-10">
            <h1 className="text-xl font-medium">Project workspace</h1>
          </section>
        </main>
        <Toaster />
      </TooltipProvider>
    </OpenGeniProvider>
  ),
});
const route = createRoute({ getParentRoute: () => root, path: "/test/project-rename.html" });
const router = createRouter({ routeTree: root.addChildren([route]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
