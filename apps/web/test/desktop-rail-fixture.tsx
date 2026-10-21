import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
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
  return (
    <OpenGeniProvider client={client} workspaceId={workspaceId}>
      <TooltipProvider>
        <main className="flex h-dvh bg-canvas text-fg">
          <nav
            data-collapsed={rail.collapsed}
            style={{ width: rail.collapsed ? 56 : 288 }}
            className="h-full shrink-0 border-r border-border"
          >
            <RailBody />
          </nav>
          <section className="flex flex-1 items-center justify-center text-sm text-fg-muted">
            Real sidebar components · Sample workspace data
          </section>
        </main>
      </TooltipProvider>
    </OpenGeniProvider>
  );
}
const root = createRootRoute({ component: Preview });
const preview = createRoute({ getParentRoute: () => root, path: "/test/desktop-rail.html" });
const router = createRouter({ routeTree: root.addChildren([preview]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
