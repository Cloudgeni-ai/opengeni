import { useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { SessionsIndexRoute } from "../src/routes/sessions-index";
import SessionSearchDialog from "../src/components/session/session-search-dialog";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { Button } from "../src/components/ui/button";
import { discoveryEvidence, fixtureClient, workspaceId } from "./session-discovery-preview-context";
import "../src/styles.css";

Object.assign(window, { discoveryEvidence });
const params = new URLSearchParams(location.search);
const theme = params.get("theme") ?? "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;
function Preview() {
  const [open, setOpen] = useState(params.get("view") === "search");
  return (
    <OpenGeniProvider client={fixtureClient} workspaceId={workspaceId}>
      <TooltipProvider>
        <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-fg">
          <div className="flex shrink-0 items-center justify-between px-4 py-2">
            <span className="text-xs text-fg-muted">Preview · Sample data</span>
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              Search sessions
            </Button>
          </div>
          <SessionsIndexRoute workspaceId={workspaceId} />
          <SessionSearchDialog workspaceId={workspaceId} open={open} onOpenChange={setOpen} />
        </main>
      </TooltipProvider>
    </OpenGeniProvider>
  );
}
const root = createRootRoute({ component: Preview });
const route = createRoute({
  getParentRoute: () => root,
  path: "/test/session-discovery-preview.html",
});
const router = createRouter({ routeTree: root.addChildren([route]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
