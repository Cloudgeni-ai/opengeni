import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import {
  AccountRuleLocksPage,
  OrganizationAccountRulesSection,
  WorkspaceAccountRulesSection,
  useModelAccountSettingsOverview,
  useWorkspaceModelAccountSettings,
} from "../../../src/components/models/model-account-settings";
import { SectionStack } from "../../../src/components/ui/section";
import { PersonalFallbackPreference } from "../../../src/components/models/model-account-policy-controls";
import "../../../src/styles.css";

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.ogTheme = params.get("theme") === "dark" ? "dark" : "light";
const view = params.get("view") ?? "organization";
const NAMES: Record<string, string> = { design: "Design", platform: "Platform", research: "Research" };
const LABELS: Record<string, string> = {
  "claude-sub/opus": "Claude Opus 5.5",
  "claude-sub/sonnet": "Claude Sonnet 5.5",
  "codex/sol": "GPT-6.1 Sol",
};

function Organization() {
  const state = useModelAccountSettingsOverview("acme", true);
  const [locks, setLocks] = useState(false);
  if (locks)
    return (
      <AccountRuleLocksPage organizationName="Acme" state={state} onClose={() => setLocks(false)} />
    );
  return (
    <SectionStack>
      <OrganizationAccountRulesSection
        organizationName="Acme"
        state={state}
        modelLabel={(id) => LABELS[id] ?? id}
        onEditLocks={() => setLocks(true)}
      />
    </SectionStack>
  );
}

function Workspace() {
  const workspaceId = params.get("workspace") ?? "design";
  const state = useWorkspaceModelAccountSettings(workspaceId, true);
  return (
    <SectionStack>
      <WorkspaceAccountRulesSection
        organizationName="Acme"
        workspaceName={NAMES[workspaceId] ?? workspaceId}
        state={state}
      />
      <PersonalFallbackPreference organizationId="acme" allowed={state.settings?.values.personalConnectionsAllowed === true && state.settings.values.personalFallbackAllowed} />
    </SectionStack>
  );
}

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-4 py-8 text-fg sm:px-8">
    <div className="mx-auto max-w-3xl">{view === "workspace" ? <Workspace /> : <Organization />}</div>
    <Toaster />
  </main>,
);
