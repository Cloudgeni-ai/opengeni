import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import {
  createRootRoute,
  createRoute,
  createMemoryHistory,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { ShellRail } from "@opengeni/react/app/components/rail/rail-surface";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { Toaster } from "sonner";
import { RailBody } from "../src/components/rail/rail-shell";
import { CapabilitiesRoute } from "../src/routes/capabilities";
import { WorkspaceStateRoute } from "../src/routes/workspace-state";
import { parseKnowledgeSearch } from "../src/components/knowledge/knowledge-navigation";
import { client, useRail, workspaceId } from "./setup-surfaces-context";
import "../src/styles.css";

// Development-only preview of the setup pages: the real rail and the real
// Capabilities and Knowledge routes, with fixture data. Open
// /test/setup-surfaces.html, then follow the rail; `?theme=dark` for dark.
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;
localStorage.setItem("opengeni.rail.nav", "true");

function Shell() {
  const rail = useRail();
  return (
    <OpenGeniProvider client={client as never} workspaceId={workspaceId}>
      <TooltipProvider>
        <main data-window-frame className="flex h-dvh overflow-hidden bg-canvas text-fg">
          <ShellRail
            as="nav"
            data-collapsed={rail.collapsed}
            style={{ width: rail.collapsed ? 56 : rail.width }}
            className="h-full max-md:hidden"
          >
            <RailBody />
          </ShellRail>
          <div data-canvas className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <Outlet />
          </div>
        </main>
        <Toaster />
      </TooltipProvider>
    </OpenGeniProvider>
  );
}

const root = createRootRoute({ component: Shell });
const home = createRoute({
  getParentRoute: () => root,
  path: "/test/setup-surfaces.html",
  component: () => (
    <section className="flex h-full items-center justify-center text-sm text-fg-muted">
      Real setup pages · Sample workspace data
    </section>
  ),
});
const capabilities = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/plugins",
  validateSearch: (search: Record<string, unknown>) =>
    typeof search.section === "string" ? { section: search.section } : {},
  component: function Capabilities() {
    const { section } = capabilities.useSearch() as { section?: string };
    return (
      <CapabilitiesRoute
        workspaceId={workspaceId}
        initialSection={section as Parameters<typeof CapabilitiesRoute>[0]["initialSection"]}
      />
    );
  },
});
const knowledge = createRoute({
  getParentRoute: () => root,
  path: "/workspaces/$workspaceId/state",
  validateSearch: (search: Record<string, unknown>) => parseKnowledgeSearch(search),
  component: function Knowledge() {
    return <WorkspaceStateRoute workspaceId={workspaceId} search={knowledge.useSearch()} />;
  },
});
// `?at=/workspaces/<id>/plugins?section=skills`: the page to open first.
const history = createMemoryHistory({
  initialEntries: [
    params.get("at")?.replace("$workspaceId", workspaceId) ?? "/test/setup-surfaces.html",
  ],
});
const router = createRouter({
  routeTree: root.addChildren([home, capabilities, knowledge]),
  history,
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
