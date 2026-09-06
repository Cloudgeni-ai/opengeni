import { ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";

import { ManagedAuthPanel } from "@/components/managed-auth-panel";
import { OrganizationOnboardingPanel } from "@/components/organization-onboarding-panel";
import { CreateOrganizationDialog } from "@/components/rail/create-organization-dialog";
import { OrganizationSwitcherLine } from "@/components/rail/switcher-block";
import { SetupAccountRoute } from "@/routes/setup-account";

function AdditionalOrganizationPreview() {
  const [open, setOpen] = useState(true);
  const [organizationName, setOrganizationName] = useState("Product team");
  const [workspaceName, setWorkspaceName] = useState("General");

  return (
    <main className="min-h-screen bg-bg p-5 text-fg">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-6xl overflow-hidden rounded-xl border border-border bg-surface-1 shadow-2xl">
        <aside className="w-64 shrink-0 border-r border-border bg-surface-2/35 p-3">
          <div className="mb-6 flex items-center gap-2 px-1 py-2 text-sm font-semibold">
            <span className="flex size-7 items-center justify-center rounded-md bg-brand text-xs font-bold text-white">
              O
            </span>
            OpenGeni
          </div>
          <div className="grid gap-1.5">
            <OrganizationSwitcherLine
              orgs={[{ accountId: "preview-account", label: "OpenGeni", canManage: true }]}
              currentLabel="OpenGeni"
              activeAccountId="preview-account"
              onSelect={() => undefined}
              onCreate={() => setOpen(true)}
              workspaceId="preview-workspace"
            />
            <button
              type="button"
              className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface-2/50 px-2 py-1.5 text-left"
            >
              <span className="flex size-7 items-center justify-center rounded-md bg-brand-strong/25 text-xs font-semibold text-brand">
                A
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">Analytics</span>
              <ChevronsUpDownIcon className="size-3.5 text-fg-subtle" />
            </button>
          </div>
        </aside>
        <section className="flex flex-1 items-center justify-center bg-bg/55 p-8">
          <div className="max-w-sm text-center">
            <p className="text-xs font-medium tracking-wide text-fg-subtle uppercase">
              Development preview
            </p>
            <h1 className="mt-2 text-xl font-semibold">Organization creation</h1>
            <p className="mt-2 text-sm text-fg-muted">
              Open the organization menu in the upper-left corner to create another organization.
            </p>
          </div>
        </section>
      </div>
      <CreateOrganizationDialog
        open={open}
        organizationName={organizationName}
        workspaceName={workspaceName}
        busy={false}
        onOrganizationNameChange={setOrganizationName}
        onWorkspaceNameChange={setWorkspaceName}
        onOpenChange={setOpen}
        onSubmit={() => setOpen(false)}
      />
    </main>
  );
}

/** Public development-only harness rendering the production onboarding components. */
export function OnboardingPreviewRoute() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "additional-organization") {
    return <AdditionalOrganizationPreview />;
  }
  if (view === "setup") {
    return <SetupAccountRoute token="approval-preview-token-not-submitted" />;
  }
  if (view === "organization") {
    return <OrganizationOnboardingPanel previewState="required" onComplete={() => undefined} />;
  }
  return <ManagedAuthPanel initialMode="signup" onSubmit={async () => undefined} />;
}
