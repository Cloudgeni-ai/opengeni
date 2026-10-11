import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import {
  AllowedModelsFormPage,
  useModelAccessPolicy,
} from "../../../src/components/model-access-policy";
import { ModelCompactionPage } from "../../../src/components/models/model-compaction-page";
import { OrganizationDefaultsSection } from "../../../src/components/models/organization-models-list";
import { useOrganizationModelDefaults } from "../../../src/components/models/use-organization-model-defaults";
import { WorkspaceDefaultsSection } from "../../../src/components/models/workspace-models-page";
import { SectionStack } from "../../../src/components/ui/section";
import "../../../src/styles.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";
const view = params.get("view") ?? "workspace";
const opened = (name: string) => () => {
  document.body.dataset.opened = name;
};
const closed = () => {
  document.body.dataset.closed = "true";
};

function Workspace() {
  const policy = useModelAccessPolicy("sample");
  return (
    <SectionStack>
      <WorkspaceDefaultsSection
        workspaceId="sample"
        organizationName="Acme"
        canManage
        policy={policy}
        onEditAllowed={opened("allowed")}
        onEditCompaction={opened("compaction")}
      />
    </SectionStack>
  );
}

function Organization() {
  const defaults = useOrganizationModelDefaults("acme", true);
  return (
    <SectionStack>
      <OrganizationDefaultsSection
        organizationName="Acme"
        anchorWorkspaceId="sample"
        defaults={defaults}
        onEditAllowed={opened("allowed")}
        onEditCompaction={opened("compaction")}
      />
    </SectionStack>
  );
}

function OrganizationPage({ page }: { page: "allowed" | "compaction" }) {
  const defaults = useOrganizationModelDefaults("acme", true);
  const props = {
    workspaceId: "sample",
    canManage: true,
    onClose: closed,
    organizationName: "Acme",
    organizationDefaults: defaults,
  };
  return page === "allowed" ? (
    <AllowedModelsFormPage {...props} />
  ) : (
    <ModelCompactionPage {...props} />
  );
}

const pages: Record<string, React.ReactNode> = {
  workspace: <Workspace />,
  organization: <Organization />,
  "workspace-allowed": (
    <AllowedModelsFormPage workspaceId="sample" canManage onClose={closed} organizationName="Acme" />
  ),
  "workspace-compaction": (
    <ModelCompactionPage workspaceId="sample" canManage onClose={closed} organizationName="Acme" />
  ),
  "organization-allowed": <OrganizationPage page="allowed" />,
  "organization-compaction": <OrganizationPage page="compaction" />,
};

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
    <div className="mx-auto max-w-3xl">{pages[view]}</div>
    <Toaster />
  </main>,
);
