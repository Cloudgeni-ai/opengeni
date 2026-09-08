import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { ChevronsUpDownIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { CreditRequiredPromptView } from "@/components/credit-required-prompt";
import { ManagedAuthPanel } from "@/components/managed-auth-panel";
import { ModelAccessOnboardingPanel } from "@/components/model-access-onboarding";
import { OrganizationOnboardingPanel } from "@/components/organization-onboarding-panel";
import { CreateOrganizationDialog } from "@/components/rail/create-organization-dialog";
import { OrganizationSwitcherLine } from "@/components/rail/switcher-block";
import { SetupAccountRoute } from "@/routes/setup-account";

// Local-only fixtures. No provider credentials or real payments are used.
const previewMethods = {
  async getBilling() {
    return { mode: "stripe" as const, balance: { balanceMicros: 0 } };
  },
  async createBillingCheckout({ amountUsd }: { amountUsd: number }) {
    return { url: `${window.location.origin}/dev/onboarding?view=checkout&amount=${amountUsd}` };
  },
  async codexConnectStart() {
    const state = crypto.randomUUID();
    return {
      state,
      userCode: "DEMO-2254",
      intervalSeconds: 2,
      verificationUri: `${window.location.origin}/dev/onboarding?view=authorize&state=${state}&provider=Codex`,
    };
  },
  async codexConnectPoll(_workspaceId: string, state: string) {
    return {
      status: localStorage.getItem(`preview-auth:${state}`) ? "connected" : "pending",
      plan: "Plus",
    };
  },
  async supergrokConnectStart() {
    const start = await previewMethods.codexConnectStart();
    return {
      ...start,
      expiresInSeconds: 600,
      verificationUri: start.verificationUri.replace("provider=Codex", "provider=SuperGrok"),
    };
  },
  async supergrokConnectPoll(workspaceId: string, state: string) {
    return previewMethods.codexConnectPoll(workspaceId, state);
  },
  async createConnection() {
    return {};
  },
  async getWorkspaceModelCatalog() {
    return { models: [] };
  },
  async getNewSessionDraft() {
    return {
      revision: 0,
      text: "",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "gpt-5.6-sol",
      reasoningEffort: "low",
      latencyMode: "standard",
      options: {},
      selectionHistory: { projects: [] },
      updatedAt: null,
    };
  },
  async saveNewSessionDraft() {
    return previewMethods.getNewSessionDraft();
  },
};
const previewClient = previewMethods as unknown as OpenGeniBrowserClient;

function PreviewResult({ view }: { view: string }) {
  const params = new URLSearchParams(window.location.search);
  const [finished, setFinished] = useState(false);
  const authorization = view === "authorize";
  const provider = params.get("provider") === "SuperGrok" ? "SuperGrok" : "Codex";
  return (
    <section className="flex flex-1 items-center justify-center px-4 py-8">
      <div className="grid w-full max-w-lg gap-4 rounded-xl border border-border bg-surface p-8">
        <p className="text-xs font-medium text-fg-subtle">LOCAL PREVIEW</p>
        <h1 className="text-xl font-semibold">
          {finished
            ? "All set"
            : authorization
              ? `${provider} authorization`
              : "Review your credits"}
        </h1>
        <p className="text-sm leading-relaxed text-fg-muted">
          {finished
            ? authorization
              ? "Authorization simulated. Return to the onboarding tab to see the connected state."
              : "Payment simulated. No money was charged."
            : authorization
              ? "This simulates the external sign-in step. In the real flow, you authorize on the provider’s website using code DEMO-2254."
              : `You selected $${Number(params.get("amount") || 25).toFixed(2)} in OpenGeni credits. The real flow opens Stripe Checkout to collect payment details. This preview does not reproduce Stripe’s payment page.`}
        </p>
        {!finished ? (
          <Button
            onClick={() => {
              if (authorization)
                localStorage.setItem(`preview-auth:${params.get("state")}`, "connected");
              setFinished(true);
            }}
          >
            {authorization ? "Simulate successful authorization" : "Simulate successful payment"}
          </Button>
        ) : null}
        <Button asChild variant="ghost">
          <a href="/dev/onboarding?view=models">Back to onboarding</a>
        </Button>
      </div>
    </section>
  );
}

function ModelPreview({ organization = false }: { organization?: boolean }) {
  const [completed, setCompleted] = useState(false);
  if (completed)
    return (
      <section className="flex flex-1 items-center justify-center px-4">
        <div className="grid max-w-lg gap-4 rounded-xl border border-border bg-surface p-8">
          <p className="text-xs text-fg-subtle">LOCAL PREVIEW</p>
          <h1 className="text-xl font-semibold">Onboarding complete</h1>
          <p className="text-sm text-fg-muted">
            In the app, you now arrive in your Personal workspace. The connected model is selected
            for your next chat.
          </p>
          <Button onClick={() => setCompleted(false)}>Try another option</Button>
          <Button asChild variant="ghost">
            <a href="/dev/onboarding?view=credits">Preview the empty-credits dialog</a>
          </Button>
        </div>
      </section>
    );
  return organization ? (
    <OrganizationOnboardingPanel
      client={previewClient}
      billingMode="stripe"
      codexEnabled
      supergrokEnabled
      previewState="required"
      onComplete={() => setCompleted(true)}
    />
  ) : (
    <ModelAccessOnboardingPanel
      client={previewClient}
      organizationId="preview-organization"
      workspaceId="preview-workspace"
      billingMode="stripe"
      codexEnabled
      supergrokEnabled
      onComplete={() => setCompleted(true)}
    />
  );
}

function CreditPromptPreview() {
  const [open, setOpen] = useState(true);
  return (
    <section className="flex flex-1 items-center justify-center">
      <Button onClick={() => setOpen(true)}>Preview empty credits</Button>
      <CreditRequiredPromptView
        client={previewClient}
        open={open}
        workspaceId="preview-workspace"
        accountId="preview-organization"
        canBuyCredits
        onOpenChange={setOpen}
      />
    </section>
  );
}

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
              <span className="flex size-7 items-center justify-center rounded-md bg-brand-strong/25 text-xs font-semibold text-[var(--og-color-accent-strong)]">
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
  if (view === "authorize" || view === "checkout") return <PreviewResult view={view} />;
  if (view === "credits") return <CreditPromptPreview />;
  if (view === "organization") return <ModelPreview organization />;
  if (view === "models") return <ModelPreview />;
  return <ManagedAuthPanel initialMode="signup" onSubmit={async () => undefined} />;
}
