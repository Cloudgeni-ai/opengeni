// Browser preview of workspace Insights and the organization usage page.
// `?page=workspace|org`, `?state=data|empty|error|loading`, `?theme=dark`.
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { UsageDashboard } from "../src/components/insights/usage-dashboard";
import { ContentPage } from "../src/components/ui/content-layout";
import { PageHeader } from "../src/components/ui/page-header";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { InsightsRoute } from "../src/routes/insights";
import { WorkspaceUsagePage } from "../src/components/usage/workspace-usage-page";
import { accountId, workspaceId } from "./insights-preview-context";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.ogTheme = theme;
const page = params.get("page") ?? "workspace";

const root = createRootRoute({
  component: () => (
    <TooltipProvider>
      <main className="min-h-dvh min-w-0 bg-bg text-fg">
        {page === "limits" ? (
          <ContentPage width="wide" className="gap-6">
            <PageHeader title="Usage" />
            <WorkspaceUsagePage
              workspaceId={workspaceId}
              workspaceName="Marketing"
              organizationId={accountId}
            />
          </ContentPage>
        ) : page === "workspace" ? (
          <InsightsRoute workspaceId={workspaceId} />
        ) : (
          <ContentPage width="wide" className="gap-6">
            <PageHeader title="Billing & usage" />
            <UsageDashboard
              scope={{ kind: "organization", accountId }}
              search={{}}
              onSearchChange={() => {}}
              onOpenSession={() => {}}
              deniedMessage="No access."
            />
          </ContentPage>
        )}
      </main>
    </TooltipProvider>
  ),
});
const router = createRouter({
  routeTree: root,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
