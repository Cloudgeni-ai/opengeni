import { Section, SectionStack, SectionVariantProvider } from "@/components/ui/section";
import { SettingRow } from "@/components/ui/setting-row";
import { ModelPolicyPicker, projectPickerRows } from "@opengeni/react";
import type { WorkspaceModelCatalogModel, ReasoningEffort, LatencyMode } from "@opengeni/sdk";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { directModelConnectionSpec, type CreateConnectionRequest } from "@opengeni/contracts";
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
import { SignInMethodsPreview } from "@/dev/sign-in-methods-preview";
import { OrganizationCreditBalance } from "@/components/organization-credit-balance";
import { CouponRedeem } from "@/components/credits/coupon-redeem";
import type { BillingCheckoutStatus } from "@opengeni/sdk";
import { CreditsCelebrationDialog } from "@/components/credits/checkout-credits-celebration";

// Local-only fixtures. No provider credentials or real payments are used.
let previewModel: Record<string, unknown> | null = null;
let previewCouponRedeemedAt: number | null = null;
const previewCreditScope = {
  label: "Launch credits",
  eligibleModelIds: ["gpt-6-luna", "gpt-6-sol"],
};
const scopedCreditPreview = () => new URLSearchParams(window.location.search).get("scoped") === "1";
const previewMethods = {
  async getBilling() {
    return { mode: "stripe" as const, balance: { balanceMicros: 0 } };
  },
  async createBillingCheckout({
    amountUsd,
    promotionCode,
  }: {
    amountUsd?: number;
    promotionCode?: string;
  }) {
    if (promotionCode) {
      // `LAUNCH100` is a $100 code here; anything else is refused like Stripe would.
      if (promotionCode.trim().toUpperCase() !== "LAUNCH100") {
        throw new Error("That code isn't valid or has expired.");
      }
      previewCouponRedeemedAt = Date.now();
      return {
        checkoutSessionId: "cs_preview_coupon",
        url: `${window.location.origin}/dev/onboarding?view=checkout&amount=100&coupon=1`,
        amountUsd: 100,
        ...(scopedCreditPreview() ? { promotionalScope: previewCreditScope } : {}),
      };
    }
    return {
      checkoutSessionId: "cs_preview_purchase",
      url: `${window.location.origin}/dev/onboarding?view=checkout&amount=${amountUsd}`,
    };
  },
  // The coupon's credits "land" two seconds after redeeming.
  async getBillingCheckout(checkoutSessionId: string) {
    const granted =
      previewCouponRedeemedAt !== null && Date.now() - previewCouponRedeemedAt > 2_000;
    return {
      checkoutSessionId,
      status: granted ? "complete" : "open",
      credit: {
        state: granted ? "granted" : "pending",
        amountMicros: 100_000_000,
        currency: "usd",
        free: true,
        ...(scopedCreditPreview() ? { promotionalScope: previewCreditScope } : {}),
      },
      balance: granted
        ? {
            accountId: "preview-organization",
            balanceMicros: 110_000_000,
            currency: "usd",
            updatedAt: new Date().toISOString(),
          }
        : null,
    };
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
  // Onboarding connects subscriptions for the organization.
  async organizationSupergrokConnectStart() {
    return previewMethods.supergrokConnectStart();
  },
  async organizationSupergrokConnectPoll(_organizationId: string, state: string) {
    return previewMethods.codexConnectPoll("", state);
  },
  async requestJson(_method: string, path: string, body?: { state?: string }) {
    if (path.endsWith("/codex/connect/start")) return previewMethods.codexConnectStart();
    if (path.endsWith("/codex/connect/poll"))
      return previewMethods.codexConnectPoll("", body?.state ?? "");
    throw new Error(`Not in the preview: ${path}`);
  },
  async createConnection(_workspaceId: string, request: CreateConnectionRequest) {
    const connection = {
      id: crypto.randomUUID(),
      version: 1,
      status: "active",
      subjectId: request.subjectId ?? null,
      kind: request.kind,
      providerDomain: request.providerDomain,
      metadata: request.metadata,
    };
    const spec = directModelConnectionSpec(connection);
    if (spec)
      previewModel = {
        id: spec.modelId,
        label: spec.model,
        provider: spec.providerId,
        providerLabel: spec.provider === "openai" ? "Your OpenAI" : "Your Azure OpenAI",
        api: "responses",
        cost: "workspace",
        policyAllowed: true,
        billing: { upstreamPayer: "workspace", metering: "external" },
        availability: { status: "available", selectable: true, reason: null, checkedAt: null },
        credentialReadiness: {
          status: "ready",
          reason: null,
          basis: "connection",
          checkedAt: null,
        },
      };
    return connection;
  },
  async getWorkspaceModelCatalog() {
    return { models: previewModel ? [previewModel] : [] };
  },
  async getNewSessionDraft() {
    return {
      revision: 0,
      text: "",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: "gpt-6-astra",
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
  // Developer setup ("Add AI agents to my product"). Nothing real is created.
  async createOrganizationApiKey() {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      apiKey: { id: crypto.randomUUID(), prefix: "ogk_preview12" },
      token: "ogk_preview12_NOT-A-REAL-KEY-local-preview-only",
    };
  },
  async createWorkspace() {
    return { id: "preview-setup-workspace" };
  },
  async createVariableSet() {
    return { id: "preview-variable-set" };
  },
  async createSession() {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { id: "preview-setup-session" };
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
              : `You selected $${Number(params.get("amount") || 25).toFixed(2)} in Opengeni credits. The real flow opens Stripe Checkout to collect payment details. This preview does not reproduce Stripe’s payment page.`}
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

/** `?included=free|deployment` previews the step when the deployment default model is included. */
function previewIncludedModel() {
  const included = new URLSearchParams(window.location.search).get("included");
  if (included === "free") return { id: "preview-free", label: "Preview Free Model", free: true };
  if (included === "deployment")
    return { id: "preview-included", label: "Preview Included Model", free: false };
  return null;
}

/** `?credits=trial` previews the step when the organization already holds Opengeni credits. */
function previewStartingCredits() {
  if (new URLSearchParams(window.location.search).get("credits") !== "trial") return null;
  return {
    balance: {
      balanceMicros: 10_000_000,
      currency: "usd",
      ...(scopedCreditPreview()
        ? {
            generalBalanceMicros: 0,
            promotionalCredits: [
              {
                ...previewCreditScope,
                label: "Signup credits",
                grantId: "00000000-0000-4000-8000-000000000001",
                remainingMicros: 10_000_000,
              },
            ],
          }
        : {}),
    },
    model: {
      id: scopedCreditPreview() ? "gpt-6-luna" : "preview-credits",
      label: scopedCreditPreview() ? "GPT-6 Luna" : "Preview Credits Model",
      reasoningEffort: "xhigh" as const,
    },
  };
}

function CreditBalancePreview() {
  const generalCredits =
    new URLSearchParams(window.location.search).get("general") === "0" ? 0 : 25_000_000;
  const [model, setModel] = useState("gpt-6-luna");
  const [effort, setEffort] = useState<ReasoningEffort>("medium");
  const [latency, setLatency] = useState<LatencyMode>("standard");
  const rows = projectPickerRows(
    ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"].map(
      (id): WorkspaceModelCatalogModel => ({
        id,
        label: id,
        provider: "openai",
        providerLabel: "OpenAI",
        api: "responses",
        cost: "credits",
        creditFunding: previewCreditScope.eligibleModelIds.includes(id)
          ? "promotional"
          : generalCredits > 0
            ? "general"
            : "unavailable",
        policyAllowed: true,
        credentialReadiness: {
          status: "ready",
          reason: null,
          basis: "configuration",
          checkedAt: null,
        },
        availability: { status: "available", selectable: true, reason: null, checkedAt: null },
      }),
    ),
  );

  const [granted, setGranted] = useState<BillingCheckoutStatus | null>(null);
  return (
    <section className="mx-auto grid w-full max-w-2xl gap-6 p-6">
      <h1 className="text-xl font-semibold text-fg">Credits</h1>
      <SectionVariantProvider variant="group">
        <SectionStack>
          <Section title="Balance">
            <div className="py-4">
              <OrganizationCreditBalance
                hasAccount
                canReadBilling
                loading={false}
                hasError={false}
                billing={{
                  mode: "stripe",
                  balance: {
                    accountId: "00000000-0000-4000-8000-000000000002",
                    currency: "usd",
                    updatedAt: new Date().toISOString(),
                    balanceMicros: 100_000_000 + generalCredits,
                    generalBalanceMicros: generalCredits,
                    promotionalCredits: [
                      {
                        ...previewCreditScope,
                        grantId: "00000000-0000-4000-8000-000000000001",
                        remainingMicros: 100_000_000,
                      },
                    ],
                  },
                }}
              />
            </div>
          </Section>
          <Section title="Model selection">
            <SettingRow
              label="Model"
              controlWidth="select"
              control={
                <ModelPolicyPicker
                  rows={rows}
                  model={model}
                  effort={effort}
                  latencyMode={latency}
                  onModelChange={setModel}
                  onEffortChange={setEffort}
                  onLatencyModeChange={setLatency}
                  triggerStyle={
                    new URLSearchParams(window.location.search).get("picker") === "pill"
                      ? "pill"
                      : "field"
                  }
                  menuSide="bottom"
                />
              }
            />
          </Section>
          <Section title="Redeem credits">
            <SettingRow
              label="Promo code"
              description="Opens Stripe to confirm your code."
              controlWidth="auto"
              control={
                <CouponRedeem
                  client={previewClient}
                  accountId="preview-organization"
                  workspaceId="preview-workspace"
                  variant="inline"
                  defaultOpen
                  onGranted={setGranted}
                />
              }
            />
          </Section>
        </SectionStack>
      </SectionVariantProvider>
      <p className="text-xs text-fg-muted">Local preview · Try LAUNCH100</p>
      {granted ? (
        <CreditsCelebrationDialog status={granted} open onOpenChange={() => setGranted(null)} />
      ) : null}
    </section>
  );
}

function ModelPreview({ organization = false }: { organization?: boolean }) {
  const [completed, setCompleted] = useState<false | { sessionId?: string }>(false);
  const includedModel = previewIncludedModel();
  const startingCredits = previewStartingCredits();
  if (completed)
    return (
      <section className="flex flex-1 items-center justify-center px-4">
        <div className="grid max-w-lg gap-4 rounded-xl border border-border bg-surface p-8">
          <p className="text-xs text-fg-subtle">LOCAL PREVIEW</p>
          <h1 className="text-xl font-semibold">Onboarding complete</h1>
          <p className="text-sm text-fg-muted">
            {completed.sessionId
              ? "In the app, you now arrive in the setup chat, in the Opengeni setup workspace."
              : "In the app, you now arrive in your Personal workspace. The connected model is selected for your next chat."}
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
      includedModel={includedModel}
      startingCredits={startingCredits}
      previewState="required"
      activeEmail="preview@example.test"
      onSignOut={() => window.location.assign("/dev/onboarding")}
      onComplete={(destination) => setCompleted(destination ?? {})}
    />
  ) : (
    <ModelAccessOnboardingPanel
      client={previewClient}
      organizationId="preview-organization"
      organizationName="Acme Robotics"
      workspaceId="preview-workspace"
      billingMode="stripe"
      codexEnabled
      supergrokEnabled
      includedModel={includedModel}
      startingCredits={startingCredits}
      onComplete={() => setCompleted({})}
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
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] max-w-6xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
        <aside className="w-64 shrink-0 border-r border-border bg-surface-2/35 p-3">
          <div className="mb-6 flex items-center gap-2 px-1 py-2 text-sm font-semibold">
            <span className="flex size-7 items-center justify-center rounded-md bg-brand text-xs font-bold text-brand-fg">
              O
            </span>
            Opengeni
          </div>
          <div className="grid gap-1.5">
            <OrganizationSwitcherLine
              orgs={[{ accountId: "preview-account", label: "Opengeni", canManage: true }]}
              currentLabel="Opengeni"
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
  if (new URLSearchParams(window.location.search).get("view") === "security")
    return <SignInMethodsPreview />;
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "additional-organization") {
    return <AdditionalOrganizationPreview />;
  }
  if (view === "setup") {
    return <SetupAccountRoute token="approval-preview-token-not-submitted" />;
  }
  if (view === "authorize" || view === "checkout") return <PreviewResult view={view} />;
  if (view === "credits") return <CreditPromptPreview />;
  if (view === "billing") return <CreditBalancePreview />;
  if (view === "organization") return <ModelPreview organization />;
  if (view === "models") return <ModelPreview />;
  if (view === "signin") return <ManagedAuthPanel onSubmit={async () => undefined} />;
  if (view === "verification-expired")
    return <ManagedAuthPanel verificationLinkError="expired" onSubmit={async () => undefined} />;
  return <ManagedAuthPanel initialMode="signup" onSubmit={async () => undefined} />;
}
