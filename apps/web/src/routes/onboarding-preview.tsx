import { OpenGeniProvider } from "@opengeni/react";
import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { directModelConnectionSpec, type CreateConnectionRequest } from "@opengeni/contracts";
import { ChevronsUpDownIcon } from "lucide-react";
import { createContext, lazy, Suspense, useContext, useState, type ReactNode } from "react";

import { GetStartedCard } from "@/components/onboarding/get-started-card";
import { OnboardingFrame } from "@/components/onboarding/onboarding-frame";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fetchClientConfig, signOutManaged, signUpEmail } from "@/api";
import { userErrorText } from "@/lib/api-error";
import { AppContextFixtureProvider, type AppContextValue } from "@/context";
import {
  newOnboardingJourney,
  normalizeIntents,
  ONBOARDING_MARKS,
  onboardingJourneyStorageKey,
  type OnboardingMark,
  writeOnboardingJourney,
  type OnboardingIntent,
} from "@/lib/onboarding-journey";
import { EMPTY_FIRST_AGENT, FIRST_AGENT_TASKS, type FirstAgentAnswers } from "@/lib/first-agent";
import { gitHubRepositoryResource } from "@/lib/session-tools";
import { FIRST_AGENT_STEPS, FirstAgentRoute, type FirstAgentStep } from "@/routes/first-agent";
import { GetStartedRoute } from "@/routes/get-started";
import { PlaygroundRoute } from "@/routes/playground";
import { CreditRequiredPromptView } from "@/components/credit-required-prompt";
import { ManagedAuthPanel } from "@/components/managed-auth-panel";
import { ModelAccessOnboardingPanel } from "@/components/model-access-onboarding";
import { OrganizationOnboardingPanel } from "@/components/organization-onboarding-panel";
import { CreateOrganizationDialog } from "@/components/rail/create-organization-dialog";
import { OrganizationSwitcherLine } from "@/components/rail/switcher-block";
import { SetupAccountRoute } from "@/routes/setup-account";
import { SignInMethodsPreview } from "@/dev/sign-in-methods-preview";

/**
 * The query a preview view reads (`path`, `model`, `intent`…): the page's own
 * URL, or the walkthrough's current screen.
 */
const PreviewParamsContext = createContext<URLSearchParams | null>(null);
function usePreviewParams(): URLSearchParams {
  return useContext(PreviewParamsContext) ?? new URLSearchParams(window.location.search);
}

const OnboardingWalkthrough = lazy(() =>
  import("@/dev/onboarding-walkthrough").then((module) => ({
    default: module.OnboardingWalkthrough,
  })),
);

// Local-only fixtures. No provider credentials or real payments are used.
let previewModel: Record<string, unknown> | null = null;
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
  async listOrganizationInvitations() {
    const now = new Date().toISOString();
    return {
      invitations: [
        {
          id: "preview-invitation",
          organizationId: "preview-organization",
          organizationName: "Acme Robotics",
          targetEmail: "ada@example.test",
          targetName: "Ada",
          initialWorkspaceIds: [],
          role: "member",
          status: "pending",
          revision: 1,
          expiresAt: now,
          acceptedMembershipId: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
      nextCursor: null,
    };
  },
  async acceptOrganizationInvitation() {
    return { invitation: {}, membership: { personalWorkspaceId: "preview-workspace" } };
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
};
const previewClient = previewMethods as unknown as OpenGeniBrowserClient;

function PreviewResult({ view }: { view: string }) {
  const params = usePreviewParams();
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

/** `?included=deployment` previews the step when the deployment pays for its default model. */
function previewIncludedModel(params: URLSearchParams) {
  const included = params.get("included");
  if (included === "free") return { id: "preview-free", label: "Preview Free Model", free: true };
  if (included === "deployment")
    return { id: "preview-included", label: "Preview Included Model", free: false };
  return null;
}

/** `?credits=trial` previews the step when the organization already holds OpenGeni credits. */
function previewStartingCredits(params: URLSearchParams) {
  if (params.get("credits") !== "trial") return null;
  return {
    balance: { balanceMicros: 10_000_000, currency: "usd" },
    model: {
      id: "preview-credits",
      label: "Preview Credits Model",
      reasoningEffort: "xhigh" as const,
    },
  };
}

/**
 * The first question (with the organization's name folded in) and the
 * fallback model step over fixtures: `?billing=disabled` (no Stripe),
 * `?codex=off`, `?ref=producthunt` (a product preselected).
 */
function ModelPreview({ organization = false }: { organization?: boolean }) {
  const params = usePreviewParams();
  const [completed, setCompleted] = useState<string | null>(null);
  const includedModel = previewIncludedModel(params);
  const startingCredits = previewStartingCredits(params);
  const billingMode = params.get("billing") === "disabled" ? "disabled" : "stripe";
  const codexEnabled = params.get("codex") !== "off";
  if (completed)
    return (
      <section className="flex flex-1 items-center justify-center px-4 py-8">
        <div className="grid max-w-lg gap-4 rounded-xl border border-border bg-surface p-8">
          <p className="text-xs text-fg-subtle">LOCAL PREVIEW</p>
          <h1 className="text-xl font-semibold">Next</h1>
          <p className="text-sm text-fg-muted">In the app, you now arrive on {completed}.</p>
          <Button onClick={() => setCompleted(null)}>Try another option</Button>
        </div>
      </section>
    );
  return organization ? (
    <OrganizationOnboardingPanel
      client={previewClient}
      previewState={params.get("invitation") === "pending" ? "invitation_pending" : "required"}
      preselectedUse={params.get("ref") === "producthunt" ? "product" : null}
      activeName="Ada Lovelace"
      activeEmail="ada@example.test"
      onSignOut={() => window.location.assign("/dev/onboarding")}
      onComplete={(next) => setCompleted(next?.to ?? "the app")}
    />
  ) : (
    <OnboardingFrame>
      <ModelAccessOnboardingPanel
        client={previewClient}
        organizationId="preview-organization"
        organizationName="Acme Robotics"
        workspaceId="preview-workspace"
        billingMode={billingMode}
        codexEnabled={codexEnabled}
        supergrokEnabled
        includedModel={includedModel}
        startingCredits={startingCredits}
        onComplete={() => setCompleted("the ready moment, then the app")}
      />
    </OnboardingFrame>
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

const PREVIEW_REPOSITORIES = ["acme/shop", "acme/support-site", "acme/infra"].map(
  (fullName, index) => ({
    id: 9000 + index,
    installationId: 77,
    fullName,
    name: fullName.split("/")[1]!,
    private: index !== 1,
    htmlUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: "main",
    accountLogin: "acme",
    accountType: "Organization",
  }),
);

/**
 * What first run remembers, from the preview query: `?use=product|work`,
 * `?product=have|explore`, `?fill=1` (a website, a repository and a task),
 * `?fill=site` (the website only), `?builder=own`, `?skipped=1`.
 */
function previewFirstAgent(params: URLSearchParams): FirstAgentAnswers {
  const use = params.get("use");
  const product = params.get("product");
  const fill = params.get("fill");
  const repository = PREVIEW_REPOSITORIES[0]!;
  return {
    ...EMPTY_FIRST_AGENT,
    use: use === "product" || use === "work" ? use : null,
    product: product === "have" || product === "explore" ? product : null,
    ...(fill === "1" || fill === "site" ? { website: "acme-robotics.com" } : {}),
    ...(fill === "1"
      ? {
          repository: {
            fullName: repository.fullName,
            url: repository.htmlUrl,
            resource: gitHubRepositoryResource(repository, "main"),
          },
          task: FIRST_AGENT_TASKS[0]!.task,
        }
      : {}),
    builder: params.get("builder") === "own" ? "own" : null,
    outcome: params.get("skipped") === "1" ? "skipped" : null,
  };
}

const FIXTURE_ORG = "00000000-0000-4000-8000-0000000000a1";
const FIXTURE_PERSONAL = "00000000-0000-4000-8000-0000000000b1";
const FIXTURE_DEVELOPMENT = "00000000-0000-4000-8000-0000000000c1";
const FIXTURE_SUBJECT = "user:preview-onboarding";
/** A credits-billed model at the built-in +5% markup; no balance pays for it. */
const PREVIEW_CREDITS_MODEL = {
  id: "openai/gpt-6-luna",
  label: "GPT-6 Luna",
  source: "opengeni",
  cost: "credits",
  api: "responses",
  policyAllowed: true,
  pricing: { default: { marginBps: 500 } },
  credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
  availability: { status: "unavailable", selectable: false, reason: "no_credits", checkedAt: null },
  capabilities: {
    reasoning: {
      upstream: "supported",
      runnable: true,
      efforts: ["low", "medium"],
      defaultEffort: "low",
      required: false,
    },
  },
};
const WORKSPACE_PERMISSIONS = [
  "workspace:read",
  "workspace:admin",
  "sessions:create",
  "sessions:read",
  "github:manage",
];

/**
 * App pages over fixture data: `?path=` build | cloud | explore | invited,
 * `?model=none` (no usable model), `?mcp=oauth` (coding agents sign in with
 * OAuth), `?role=member`, `?github=on|connected`, `?credits=trial`. First
 * run answers: see previewFirstAgent.
 * Nothing here reaches the API.
 */
function AppFixture({ children }: { children: (workspaceId: string) => ReactNode }) {
  const params = usePreviewParams();
  const path = params.get("path") ?? "explore";
  const member = params.get("role") === "member" || path === "invited";
  const modelReady = params.get("model") !== "none";
  const intents: OnboardingIntent[] =
    path === "both" ? ["build", "cloud"] : path === "invited" ? [] : normalizeIntents([path]);
  const building = intents.includes("build");
  const workspaceId = building ? FIXTURE_DEVELOPMENT : FIXTURE_PERSONAL;
  const now = new Date().toISOString();
  const billingMode = params.get("billing") === "disabled" ? "disabled" : "stripe";
  const githubMode = params.get("github");
  const firstAgent = previewFirstAgent(params);
  const [journeyReady] = useState(() => {
    if (params.get("journey") === "none")
      writeOnboardingJourney(onboardingJourneyStorageKey(FIXTURE_SUBJECT, FIXTURE_ORG), null);
    else
      writeOnboardingJourney(onboardingJourneyStorageKey(FIXTURE_SUBJECT, FIXTURE_ORG), {
        ...newOnboardingJourney({
          intents,
          invited: path === "invited",
          developmentWorkspaceId: building ? FIXTURE_DEVELOPMENT : null,
        }),
        firstAgent,
        // `?marks=api_key,first_api_session`: what this browser remembers.
        marks: Object.fromEntries(
          (params.get("marks") ?? "")
            .split(",")
            .filter((mark): mark is OnboardingMark =>
              (ONBOARDING_MARKS as readonly string[]).includes(mark),
            )
            .map((mark) => [mark, now]),
        ),
      });
    return true;
  });
  const model = {
    id: "codex/gpt-6-luna",
    label: "GPT-6 Luna",
    source: "codex",
    cost: "subscription",
    api: "responses",
    policyAllowed: true,
    credentialReadiness: { status: "ready", reason: null, basis: "configuration", checkedAt: null },
    availability: {
      status: modelReady ? "available" : "unavailable",
      selectable: modelReady,
      reason: modelReady ? null : "missing_credential",
      checkedAt: null,
    },
    capabilities: {
      reasoning: {
        upstream: "supported",
        runnable: true,
        efforts: ["low", "medium"],
        defaultEffort: "low",
        required: false,
      },
    },
  };
  const fixtureClient = {
    ...previewMethods,
    async getBilling() {
      return {
        mode: billingMode,
        balance: {
          balanceMicros: params.get("credits") === "trial" ? 10_000_000 : 0,
          currency: "usd",
        },
      };
    },
    async getWorkspaceModelCatalog() {
      // `?credits=trial`: the verified-signup grant pays for GPT-6 Luna.
      const trial = billingMode === "stripe" && params.get("credits") === "trial";
      const credits = trial
        ? {
            ...PREVIEW_CREDITS_MODEL,
            availability: { status: "available", selectable: true, reason: null, checkedAt: null },
            capabilities: {
              reasoning: {
                upstream: "supported",
                runnable: true,
                efforts: ["low", "medium", "high", "xhigh"],
                defaultEffort: "medium",
                required: false,
              },
            },
          }
        : PREVIEW_CREDITS_MODEL;
      return {
        models: billingMode === "stripe" ? [model, credits] : [model],
        defaultSelection: trial
          ? { model: credits.id, reasoningEffort: "xhigh", source: "credits" }
          : modelReady
            ? { model: model.id, reasoningEffort: "low", source: "subscription" }
            : null,
        creditsSelection: null,
      };
    },
    async listSessionPage() {
      return { sessions: [], pinned: [], pinnedTruncated: false, nextCursor: null };
    },
    // `?appChat=1`: the demo app's first chat has arrived.
    async listSessions() {
      return params.get("appChat") === "1"
        ? [
            {
              id: "00000000-0000-4000-8000-0000000000d1",
              createdBy: { kind: "subject", subjectId: "external_user:demo" },
            },
          ]
        : [];
    },
    async createOrganizationApiKey() {
      return { token: `ogk_${"preview".padEnd(64, "0")}`, apiKey: { id: "preview-key" } };
    },
    async createOrganizationWorkspace(_organizationId: string, request: { name: string }) {
      return { id: crypto.randomUUID(), name: request.name };
    },
    async createSession() {
      throw new Error("The preview doesn't start chats. Open the playground in a workspace.");
    },
    connectTransport() {
      return {};
    },
  } as unknown as OpenGeniBrowserClient;
  const context = {
    client: fixtureClient,
    clientConfig: {
      productAccessMode: "managed",
      auth: { mode: "managedSession" },
      billingMode,
      models: [{ id: model.id, source: "codex" }],
      mcpOAuthEnabled: params.get("mcp") === "oauth",
      firstPartyMcpTools: { default: [], allowed: [] },
    },
    authSession: { user: { name: "Ada Lovelace", email: "ada@example.test" } },
    accessContext: {
      mode: "managed",
      subjectId: FIXTURE_SUBJECT,
      defaultAccountId: FIXTURE_ORG,
      defaultWorkspaceId: FIXTURE_PERSONAL,
      accountGrants: [
        {
          accountId: FIXTURE_ORG,
          subjectId: FIXTURE_SUBJECT,
          role: member ? "member" : "owner",
          permissions: member ? ["account:read"] : ["account:admin", "api_keys:manage"],
          metadata: { accountName: "Acme Robotics" },
        },
      ],
      workspaceGrants: [FIXTURE_PERSONAL, FIXTURE_DEVELOPMENT].map((id) => ({
        workspaceId: id,
        accountId: FIXTURE_ORG,
        subjectId: FIXTURE_SUBJECT,
        permissions: WORKSPACE_PERMISSIONS,
      })),
    },
    workspaces: [
      {
        id: FIXTURE_PERSONAL,
        accountId: FIXTURE_ORG,
        kind: "personal",
        name: "Personal workspace",
        createdAt: now,
      },
      ...(building
        ? [
            {
              id: FIXTURE_DEVELOPMENT,
              accountId: FIXTURE_ORG,
              kind: "shared",
              name: "Development",
              createdAt: now,
            },
          ]
        : []),
    ],
    githubStatus:
      githubMode === "on" || githubMode === "connected"
        ? {
            configured: true,
            status: githubMode === "connected" ? "bound" : "unbound",
            setupMode: "platform",
            installUrl: "https://github.com",
            installations: [],
          }
        : githubMode === "off"
          ? { configured: false, status: "disabled", installations: [] }
          : null,
    githubRepos: githubMode === "connected" ? PREVIEW_REPOSITORIES : [],
    githubCatalogReady: true,
    personalGitHubRepositories: [],
    personalGitHubCatalogReady: true,
    personalGitHubStatus: null,
    refreshGitHub: async () => undefined,
    connectPersonalGitHub: async () => undefined,
    refreshPrincipalAccess: async () => true,
  } as unknown as AppContextValue;
  if (!journeyReady) return null;
  return (
    <AppContextFixtureProvider value={context}>
      <TooltipProvider>
        <OpenGeniProvider client={fixtureClient} workspaceId={workspaceId}>
          {children(workspaceId)}
        </OpenGeniProvider>
      </TooltipProvider>
    </AppContextFixtureProvider>
  );
}

/** The new-chat page's column, with the checklist where the suggestions go. */
function ChecklistPreview() {
  return (
    <AppFixture>
      {(workspaceId) => (
        <main className="min-h-dvh overflow-y-auto bg-canvas">
          <div className="mx-auto max-w-3xl px-4 pt-10 pb-16">
            <h1 className="text-center text-3xl font-semibold tracking-tight text-fg">
              What should the agent do?
            </h1>
            <div
              className="mt-8 h-32 rounded-[14px] border border-border bg-surface"
              aria-hidden="true"
            />
            <GetStartedCard workspaceId={workspaceId} onPrefill={() => undefined} />
          </div>
        </main>
      )}
    </AppFixture>
  );
}

const PREVIEW_GROUPS: ReadonlyArray<{
  title: string;
  views: ReadonlyArray<readonly [label: string, query: string]>;
}> = [
  {
    title: "Sign up and sign in",
    views: [
      ["Sign up", "view=signup"],
      ["Sign in", "view=signin"],
      ["Expired verification link", "view=verification-expired"],
      ["Invited person sets up their account", "view=setup"],
      ["Sign-in methods (personal security)", "view=security"],
    ],
  },
  {
    title: "First question (creates the organization)",
    views: [
      ["What do you want to use Opengeni for?", "view=organization"],
      [
        "The same, Product Hunt visitor (a product preselected)",
        "view=organization&ref=producthunt",
      ],
      ["Join an organization you were invited to", "view=invitation&invitation=pending"],
      ["Another organization (account menu)", "view=additional-organization"],
    ],
  },
  {
    title: "First run in the app",
    views: [
      ["The first question again (replay, Get started)", "view=first-agent&path=build&step=use"],
      ["Do you already have a product?", "view=first-agent&path=build&use=product&step=product"],
      [
        "Tell us about your product (nothing entered, GitHub to connect)",
        "view=first-agent&path=build&use=product&product=have&step=details&github=on",
      ],
      [
        "Tell us about your product (filled in, repository picked)",
        "view=first-agent&path=build&use=product&product=have&step=details&github=connected&fill=1",
      ],
      [
        "Tell us about your product (GitHub not set up here)",
        "view=first-agent&path=build&use=product&product=have&step=details&github=off&fill=site",
      ],
      [
        "Ready: free credits, Start building",
        "view=first-agent&path=build&use=product&product=have&step=ready&fill=1&credits=trial",
      ],
      [
        "Ready: free credits (exploring)",
        "view=first-agent&path=build&use=product&product=explore&step=ready&credits=trial",
      ],
      [
        "Ready: free credits (own work)",
        "view=first-agent&path=cloud&use=work&step=ready&credits=trial",
      ],
      ["Ready after Skip", "view=first-agent&path=cloud&step=ready&skipped=1&credits=trial"],
      [
        "No trial grant, a model already works (no amount)",
        "view=first-agent&path=cloud&use=work&step=ready&billing=disabled",
      ],
      [
        "No trial grant and no model: the model step first",
        "view=first-agent&path=cloud&use=work&step=ready&model=none",
      ],
      [
        "Your own coding agent: key, prompt, waiting",
        "view=first-agent&path=build&use=product&product=have&step=own-agent&fill=1&builder=own&mcp=oauth",
      ],
      [
        "Your own coding agent: it worked",
        "view=first-agent&path=build&use=product&product=have&step=own-agent&fill=1&builder=own&appChat=1",
      ],
    ],
  },
  {
    title: "Model step (the fallback without a trial grant)",
    views: [
      ["No model yet (choose)", "view=models"],
      ["A model the server includes", "view=models&included=deployment&billing=disabled"],
      ["On a server without Stripe", "view=models&billing=disabled"],
      ["Out of credits (dialog)", "view=credits"],
    ],
  },
  {
    title: "Get started checklist (new-chat page)",
    views: [
      ["Just look around", "view=checklist&path=explore"],
      ["Just look around, no model yet", "view=checklist&path=explore&model=none"],
      ["Build", "view=checklist&path=build"],
      ["Run in the cloud", "view=checklist&path=cloud&github=on"],
      ["Build and run in the cloud", "view=checklist&path=both&github=on"],
      ["Invited member welcome", "view=checklist&path=invited&model=none"],
    ],
  },
  {
    title: "Get started page",
    views: [
      ["Nothing answered yet", "view=get-started&journey=none"],
      ["Build", "view=get-started&path=build"],
      ["Build and run in the cloud", "view=get-started&path=both&github=on"],
      ["Add an agent to your product", "view=get-started&path=build&step=product"],
      ["Your app's first chat arrived", "view=get-started&path=build&step=product&appChat=1"],
      ["Coding agent (cloud)", "view=get-started&path=cloud&mcp=oauth&step=coding-agent"],
      [
        "Run in the cloud, no model, GitHub available",
        "view=get-started&path=cloud&github=on&model=none",
      ],
      ["First task picker", "view=get-started&path=cloud&step=first-task"],
      ["Invited member", "view=get-started&path=invited&role=member"],
    ],
  },
  {
    title: "Playground",
    views: [["Playground (a recorded demo)", "view=playground&path=build"]],
  },
];

const DEV_TEST_PASSWORD = "Opengeni-dev-2026!";

/**
 * Development only: signs out, creates a fresh account and signs in as it, so
 * the real first run starts from organization setup. It uses the ordinary
 * sign-up endpoint and works only where the server verifies new accounts
 * itself (the local environment); anywhere else it says so and does nothing.
 */
function StartAsNewUser() {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string }
  >({ kind: "idle" });
  const start = async () => {
    setState({ kind: "busy" });
    try {
      const config = await fetchClientConfig();
      if (config.auth.mode !== "managedSession" || config.auth.emailVerificationRequired) {
        setState({
          kind: "error",
          message:
            "This server verifies email addresses, so a test account can't sign in without an inbox. Use the local stack.",
        });
        return;
      }
      await signOutManaged().catch(() => undefined);
      const stamp = new Date().toISOString().replace(/\D/gu, "").slice(2, 14);
      const email = `test+${stamp}@acme.dev`;
      await signUpEmail({ name: "Test user", email, password: DEV_TEST_PASSWORD });
      window.location.assign("/");
    } catch (error) {
      setState({ kind: "error", message: userErrorText(error) });
    }
  };
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" disabled={state.kind === "busy"} onClick={() => void start()}>
          {state.kind === "busy" ? "Creating account…" : "Start as a new user"}
        </Button>
        <Button asChild variant="outline">
          <a href="/?onboarding=restart">Replay onboarding in my organization</a>
        </Button>
      </div>
      <p className="text-xs leading-4.5 text-fg-muted">
        New user: signs you out, creates test+&lt;time&gt;@acme.dev (password {DEV_TEST_PASSWORD})
        and opens the first question. Replay: keeps your account and organization, forgets this
        browser's Get started progress and first-run answers, and asks the first question again in
        the app. Add <code className="font-mono">?onboarding=restart</code> to any app URL to replay
        in that workspace's organization.
      </p>
      {state.kind === "error" ? (
        <p role="alert" className="text-xs text-danger">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}

function PreviewIndex() {
  return (
    <main className="min-h-dvh overflow-y-auto bg-canvas text-fg">
      <div className="mx-auto max-w-[720px] px-4 py-10">
        <p className="text-xs font-medium text-fg-subtle">Development only</p>
        <h1 className="mt-1 text-xl font-semibold tracking-[-0.5px]">Onboarding previews</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Every first-run step over fake data. Nothing here calls the API except the two buttons
          under Try it for real.
        </p>
        <section className="mt-8 border-t border-border pt-6" aria-labelledby="preview-walkthrough">
          <h2 id="preview-walkthrough" className="text-base font-semibold">
            Walk through every screen
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            Every onboarding screen in order on one page: Previous and Next (or the arrow keys), a
            jump list, the path and the theme. No forms to fill and no accounts.
          </p>
          <Button asChild className="mt-3">
            <a href="/dev/onboarding?view=walkthrough">Open the walkthrough</a>
          </Button>
        </section>
        <section className="mt-8 border-t border-border pt-6" aria-labelledby="preview-real">
          <h2 id="preview-real" className="text-base font-semibold">
            Try it for real
          </h2>
          <div className="mt-3">
            <StartAsNewUser />
          </div>
        </section>
        {PREVIEW_GROUPS.map((group) => (
          <section
            key={group.title}
            className="mt-8 border-t border-border pt-6"
            aria-label={group.title}
          >
            <h2 className="text-base font-semibold">{group.title}</h2>
            <ul className="mt-2 grid gap-0.5">
              {group.views.map(([label, query]) => (
                <li key={query}>
                  <a
                    href={`/dev/onboarding?${query}`}
                    className="-mx-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 rounded-[10px] px-2 py-1.5 text-sm hover:bg-hover"
                  >
                    <span className="text-fg">{label}</span>
                    <code className="truncate font-mono text-xs text-fg-subtle">{query}</code>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}

/** One preview screen by name; its query comes from `usePreviewParams`. */
function PreviewView({ view }: { view: string }) {
  const params = usePreviewParams();
  if (view === "security") return <SignInMethodsPreview />;
  if (view === "additional-organization") return <AdditionalOrganizationPreview />;
  if (view === "setup") return <SetupAccountRoute token="approval-preview-token-not-submitted" />;
  if (view === "authorize" || view === "checkout") return <PreviewResult view={view} />;
  if (view === "credits") return <CreditPromptPreview />;
  if (view === "organization" || view === "invitation") return <ModelPreview organization />;
  if (view === "first-agent") {
    const step = params.get("step");
    return (
      <AppFixture>
        {(workspaceId) => (
          <main className="flex h-full min-h-dvh flex-col bg-canvas">
            <FirstAgentRoute
              workspaceId={workspaceId}
              step={
                FIRST_AGENT_STEPS.includes(step as FirstAgentStep)
                  ? (step as FirstAgentStep)
                  : "use"
              }
            />
          </main>
        )}
      </AppFixture>
    );
  }
  if (view === "checklist") return <ChecklistPreview />;
  if (view === "get-started")
    return (
      <AppFixture>
        {(workspaceId) => (
          <main className="flex h-full min-h-dvh flex-col bg-canvas">
            <GetStartedRoute workspaceId={workspaceId} step={params.get("step")} />
          </main>
        )}
      </AppFixture>
    );
  if (view === "playground")
    return (
      <AppFixture>{(workspaceId) => <PlaygroundRoute workspaceId={workspaceId} />}</AppFixture>
    );
  if (view === "models") return <ModelPreview />;
  if (view === "signin") return <ManagedAuthPanel onSubmit={async () => undefined} />;
  if (view === "verification-expired")
    return <ManagedAuthPanel verificationLinkError="expired" onSubmit={async () => undefined} />;
  return <ManagedAuthPanel initialMode="signup" onSubmit={async () => undefined} />;
}

/** Public development-only harness rendering the production onboarding components. */
export function OnboardingPreviewRoute() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (!view) return <PreviewIndex />;
  if (view === "walkthrough")
    return (
      <Suspense fallback={null}>
        <OnboardingWalkthrough
          renderScreen={(screen) => (
            <PreviewParamsContext.Provider value={screen.params}>
              <PreviewView view={screen.view} />
            </PreviewParamsContext.Provider>
          )}
        />
      </Suspense>
    );
  return <PreviewView view={view} />;
}
