import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import {
  AccountRulesOverviewSection,
  OrganizationAccountRulesSection,
  WorkspaceAccountRulesSection,
  useModelAccountSettingsOverview,
  useWorkspaceModelAccountSettings,
} from "../../../src/components/models/model-account-settings";
import { SectionStack } from "../../../src/components/ui/section";
import "../../../src/styles.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";
const view = params.get("view") ?? "organization";
const LABELS: Record<string, string> = {
  "claude-sub/opus": "Claude Opus 5.5",
  "claude-sub/sonnet": "Claude Sonnet 5.5",
  "codex/sol": "GPT-6.1 Sol",
};

function Organization() {
  const state = useModelAccountSettingsOverview("acme", true);
  return (
    <SectionStack>
      <OrganizationAccountRulesSection
        organizationName="Acme"
        state={state}
        modelLabel={(id) => LABELS[id] ?? id}
      />
      <AccountRulesOverviewSection
        organizationName="Acme"
        state={state}
        onOpenWorkspace={(id) => {
          document.body.dataset.opened = id;
        }}
      />
    </SectionStack>
  );
}

function Workspace() {
  const state = useWorkspaceModelAccountSettings(params.get("workspace") ?? "design", true);
  return (
    <SectionStack>
      <WorkspaceAccountRulesSection organizationName="Acme" state={state} />
    </SectionStack>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
    <div className="mx-auto max-w-3xl">{view === "workspace" ? <Workspace /> : <Organization />}</div>
    <Toaster />
  </main>,
);
