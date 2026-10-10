import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import type { ModelsView } from "../../../src/lib/models-route";
import { WorkspaceModelsPage } from "../../../src/components/models/workspace-models-page";
import "../../../src/styles.css";
import { ORGANIZATION_ID, WORKSPACES } from "./context";
import { setNavigate } from "./router";

// Organization settings > Models as an organization administrator sees it,
// with the production page and sample data (see context.ts).
const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";

const workspaces = [
  WORKSPACES.design,
  WORKSPACES.platform,
  WORKSPACES.research,
  WORKSPACES.personal,
].map((workspace) => ({
  ...workspace,
  personal: workspace.id === WORKSPACES.personal.id,
  canManage: true,
  savedDefaultModel: null,
}));

type Search = { account?: string; view?: ModelsView; workspace?: string };

function Harness() {
  const [search, setSearch] = useState<Search>({
    ...(params.get("account") ? { account: params.get("account")! } : {}),
    ...(params.get("view") ? { view: params.get("view") as ModelsView } : {}),
    ...(params.get("workspace") ? { workspace: params.get("workspace")! } : {}),
  });
  setNavigate((next) => setSearch(next as Search));
  return (
    <WorkspaceModelsPage
      anchorWorkspaceId={WORKSPACES.design.id}
      workspacePage={Boolean(search.workspace)}
      workspaces={workspaces}
      workspaceId={search.workspace ?? WORKSPACES.design.id}
      workspaceName="Design"
      organizationId={ORGANIZATION_ID}
      organizationName="Acme"
      canManageSettings
      canManageConnections
      canManageOrganizationModels
      account={search.account}
      view={search.view}
      onConnectionChange={() => undefined}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-4 py-6 text-fg sm:px-8">
    <p className="mx-auto mb-4 max-w-3xl text-xs text-fg-subtle">
      PREVIEW WITH SAMPLE DATA · Organization settings › Models, as an organization admin. No real
      accounts.
    </p>
    <div className="mx-auto max-w-3xl">
      <Harness />
    </div>
    <Toaster />
  </main>,
);
