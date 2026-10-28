import { createRoot } from "react-dom/client";
import { useState } from "react";
import { OpenGeniProvider, WorkspaceDock } from "@opengeni/react";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { RailBody } from "../src/components/rail/rail-shell";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { client, useRail, workspaceId } from "./desktop-rail-context";
import "../src/styles.css";

// The browser test installs the native bridge before module evaluation.
const platform = new URLSearchParams(location.search).get("platform") ?? "macos";
if (platform !== "browser") document.documentElement.dataset.desktop = platform;
document.documentElement.classList.add("dark");
localStorage.setItem("opengeni.rail.nav", "true");

function Preview() {
  const rail = useRail();
  // The session page's real workspace dock, closed until asked: below 1024px
  // it is a full-window overlay that stays mounted (hidden) while closed.
  const [dockClosed, setDockClosed] = useState(true);
  return (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
        <main data-window-frame className="flex h-dvh bg-canvas text-fg">
          <nav
            data-shell-rail
            data-collapsed={rail.collapsed}
            style={{ width: rail.collapsed ? 56 : 288 }}
            className="h-full shrink-0 border-r border-border"
          >
            <RailBody />
          </nav>
          <div data-canvas className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <WorkspaceDock
              collapsed={dockClosed}
              onCollapsedChange={setDockClosed}
              tabs={[
                {
                  id: "files",
                  label: "Files",
                  content: (
                    <button type="button" onClick={() => setDockClosed(true)}>
                      Close workspace
                    </button>
                  ),
                },
              ]}
              primary={
                <section className="flex h-full flex-col items-center justify-center gap-3 text-sm text-fg-muted">
                  Real sidebar components · Sample workspace data
                  <button type="button" onClick={() => setDockClosed(false)}>
                    Open workspace
                  </button>
                </section>
              }
            />
          </div>
        </main>
      </TooltipProvider>
    </OpenGeniProvider>
  );
}
const root = createRootRoute({ component: Preview });
const preview = createRoute({ getParentRoute: () => root, path: "/test/desktop-rail.html" });
const router = createRouter({ routeTree: root.addChildren([preview]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
