import { createRoot } from "react-dom/client";
import { OpenGeniProvider } from "@opengeni/react";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { SessionsIndexRoute } from "../src/routes/sessions-index";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { evidence, fixtureClient, workspaceId } from "./new-session-starters-context";
import "../src/styles.css";

Object.assign(window, { starterQa: evidence });
const theme = new URLSearchParams(location.search).get("theme") ?? "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;
const root = createRootRoute({
  component: () => (
    <OpenGeniProvider client={fixtureClient} workspaceId={workspaceId}>
      <TooltipProvider>
        <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-bg text-fg">
          <SessionsIndexRoute workspaceId={workspaceId} />
        </main>
      </TooltipProvider>
    </OpenGeniProvider>
  ),
});
const route = createRoute({
  getParentRoute: () => root,
  path: "/test/new-session-starters-qa.html",
});
const router = createRouter({ routeTree: root.addChildren([route]) });
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
