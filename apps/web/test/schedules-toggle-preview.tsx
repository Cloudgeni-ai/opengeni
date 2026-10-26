// The real Schedules list over deterministic data, for the toggle preview.
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Toaster } from "@opengeni/react/app/components/toaster";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { TooltipProvider } from "@opengeni/react/ui/tooltip";
import { SchedulesListPage } from "../src/components/schedules/schedules-list-page";
import { workspaceId } from "./schedules-toggle-preview-context";
import "../src/styles.css";

const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;

const root = createRootRoute({
  component: () => (
    <TooltipProvider>
      <main className="min-h-dvh min-w-0 bg-bg text-fg">
        <Toaster />
        <ContentPage width="standard">
          <SchedulesListPage workspaceId={workspaceId} />
        </ContentPage>
      </main>
    </TooltipProvider>
  ),
});
const router = createRouter({
  routeTree: root,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
