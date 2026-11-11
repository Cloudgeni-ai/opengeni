import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { RailBody } from "../src/components/rail/rail-shell";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import {
  sessionBrowsePreferenceStorageId,
  writeSessionBrowsePreferences,
} from "@opengeni/react/app/lib/session-browse-preferences";
import { client, evidence, subjectId, useRail, workspaceId } from "./project-profile-context";
import "../src/styles.css";

// `?theme=dark|light` and `?platform=browser|macos|windows|linux`.
const parameters = new URLSearchParams(location.search);
const platform = parameters.get("platform") ?? "browser";
if (platform !== "browser") document.documentElement.dataset.desktop = platform;
const theme = parameters.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset.ogTheme = theme;
document.documentElement.classList.toggle("dark", theme === "dark");
localStorage.setItem("opengeni.rail.nav", "true");
writeSessionBrowsePreferences(sessionBrowsePreferenceStorageId(subjectId, workspaceId), {
  groupBy: "project",
  sortBy: "updatedAt",
  status: "active",
  mineOnly: false,
  showEmptyGroups: true,
});
Object.assign(window, { projectProfileQa: evidence });

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
          <section className="flex flex-1 items-end justify-end p-4 text-xs text-fg-subtle">
            Real sidebar components · Sample workspace data
          </section>
        </main>
        <Toaster />
      </TooltipProvider>
    </OpenGeniProvider>
  );
}
const root = createRootRoute({ component: Preview });
const preview = createRoute({ getParentRoute: () => root, path: "/test/project-profile.html" });
const router = createRouter({ routeTree: root.addChildren([preview]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
