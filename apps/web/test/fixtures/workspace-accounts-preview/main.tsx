import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";

import type { ModelsView } from "../../../src/lib/models-route";
import { WorkspaceModelsPage } from "../../../src/components/models/workspace-models-page";
import { organizationSettingsDescription } from "../../../src/components/settings/organization-settings-pages";
import { PageHeader, PageHeaderStyleProvider } from "../../../src/components/ui/page-header";
import { SectionVariantProvider } from "../../../src/components/ui/section-variant";
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
  const selected = workspaces.find((workspace) => workspace.id === search.workspace) ?? workspaces[0]!;
  return (
    <WorkspaceModelsPage
      anchorWorkspaceId={WORKSPACES.design.id}
      workspacePage={Boolean(search.workspace)}
      workspaces={workspaces}
      workspaceId={selected.id}
      workspaceName={selected.name}
      personal={selected.personal}
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

// `mix=full` renders in the settings content width (960px).
const width = params.get("mix") === "full" ? "max-w-[960px]" : "max-w-3xl";

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-4 py-6 text-fg sm:px-8">
    <p className={`mx-auto mb-4 ${width} text-xs text-fg-subtle`}>
      PREVIEW WITH SAMPLE DATA · Organization settings › Models, as an organization admin. No real
      accounts.
    </p>
    <div className={`mx-auto ${width}`}>
      {params.get("mix") === "full" ? (
        // As the settings shell frames it: the page header, then grouped cards.
        <PageHeaderStyleProvider icon="hide">
          <SectionVariantProvider variant="group">
            {params.get("account") || params.get("view") ? null : (
              <PageHeader
                title="Models"
                description={organizationSettingsDescription("models", "Acme")}
                className="mb-8"
              />
            )}
            <Harness />
          </SectionVariantProvider>
        </PageHeaderStyleProvider>
      ) : (
        <Harness />
      )}
    </div>
    <Toaster />
  </main>,
);
