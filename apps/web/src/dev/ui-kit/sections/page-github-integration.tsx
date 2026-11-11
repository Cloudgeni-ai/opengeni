import { useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { AppContext } from "@opengeni/react/app/app-context";
import { showPersonalGitHubReconnectToast } from "@opengeni/react/app/app-state";
import { nativeIntegrationModel } from "@opengeni/react/app/components/capabilities/native-connect-readiness";
import { SessionPersonalGitHubCapabilityCard } from "@opengeni/react/app/components/capabilities/session-personal-github-card";
import { Button } from "@opengeni/react/ui/button";
import type { AuthNeededItem } from "@opengeni/react";

import { IntegrationPage } from "@/components/capabilities/integration-page";
import { useGitHubIntegration } from "@/components/capabilities/use-github-integration";

import { KitSection, PagePreview, StateCell, StatesGrid } from "../kit";
import { showPart } from "./chat-shared";

/* ----------------------------------------------------------------------------
   The GitHub integration page with personal sign-in on: the production
   adapter (useGitHubIntegration) and IntegrationPage against a fake app
   context. Each state is one person's view of the same workspace. Approvals
   and the repair dialog run against in-memory fakes, so changing a select or
   pressing a fix works without a backend.
   -------------------------------------------------------------------------- */

const WORKSPACE_ID = "ws-kit";
const NOW = "2026-10-30T09:00:00.000Z";

type Issue =
  | "uninstalled"
  | "suspended"
  | "no_repositories"
  | "owner_unconfirmed"
  | "github_unreachable"
  | "account_changed";

type KitInstallation = {
  installationId: number;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositoryCount: number;
  issue?: Issue;
};

const LIFECYCLE: Record<Issue, string> = {
  uninstalled: "deleted",
  suspended: "suspended",
  no_repositories: "unverified",
  owner_unconfirmed: "unverified",
  github_unreachable: "unverified",
  account_changed: "unverified",
};

function binding(installation: KitInstallation) {
  return {
    installationId: installation.installationId,
    githubAccountId: installation.installationId + 1,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType,
    lifecycle: installation.issue ? LIFECYCLE[installation.issue] : "active",
    issue: installation.issue ?? null,
    repositoryScope: "selected",
    repositoryCount: installation.repositoryCount,
    configureUrl: `https://github.com/settings/installations/${installation.installationId}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const ACME: KitInstallation = {
  installationId: 71,
  accountLogin: "acme",
  accountType: "Organization",
  repositoryCount: 2,
};
const OCTOCAT: KitInstallation = {
  installationId: 81,
  accountLogin: "octocat",
  accountType: "User",
  repositoryCount: 3,
};

const SERVICES = [
  "billing",
  "search",
  "auth",
  "notifications",
  "payments",
  "analytics",
  "checkout",
  "catalog",
  "inventory",
  "shipping",
  "reviews",
  "recommendations",
  "gateway",
  "scheduler",
  "exports",
  "reports",
  "webhooks",
  "sync",
  "audit",
  "pricing",
];
/** 60 acme repositories plus two of octocat's: a long list. */
const MANY_REPOSITORIES = [
  ...SERVICES.flatMap((service) =>
    ["service", "worker", "web"].map((part) => `acme/${service}-${part}`),
  ),
  "octocat/dotfiles",
  "octocat/notes",
];

function appRepositories(installations: KitInstallation[], many: boolean) {
  const names = many ? MANY_REPOSITORIES : ["acme/web", "acme/api"];
  return installations.some((installation) => !installation.issue)
    ? names.map((fullName, index) => ({
        id: index + 1,
        installationId: fullName.startsWith("octocat/") ? 81 : 71,
        fullName,
        private: index % 4 !== 0,
      }))
    : [];
}

const personalConnection = {
  id: "connection-kit",
  version: 1,
  status: "active",
  providerDomain: "github.com",
  kind: "oauth2",
  metadata: { githubLogin: "octocat" },
};

type State = {
  key: string;
  label: string;
  permissions: string[];
  installations: KitInstallation[];
  connected: boolean;
  repositories: number;
  /** The app's repository list is long (62). */
  manyRepositories?: boolean;
  /** Approvals are on, with these saved decisions. */
  approvals?: boolean;
  /** The stored grant's status; GitHub refusing a refresh makes it needs_reauth. */
  connectionStatus?: "active" | "needs_reauth";
  /** False when the repository selection could not be read. */
  selectionLoaded?: boolean;
  /** All my repositories, at this access. */
  allRepositoriesAccess?: "read" | "write";
};

function personalRepository(
  id: number,
  fullName: string,
  push: boolean,
  selectedAccess: "read" | "write" | null,
) {
  return {
    repositoryId: String(id),
    fullName,
    canonicalUrl: `https://github.com/${fullName}`,
    defaultBranch: "main",
    visibility: "private",
    private: true,
    archived: false,
    disabled: false,
    permissions: { pull: true, triage: push, push, maintain: false, admin: false },
    selectedAccess,
    lastVerifiedAt: NOW,
  };
}
const PERSONAL_REPOSITORIES = [
  personalRepository(101, "octocat/dotfiles", true, "write"),
  personalRepository(102, "acme/web", true, "write"),
  personalRepository(103, "acme/api", true, null),
  personalRepository(104, "acme/handbook", false, null),
];

const MANAGER = ["github:use", "github:manage", "connections:read", "connections:write"];
const STATES: State[] = [
  {
    key: "many-repositories",
    label: "Two installations, 62 repositories: approvals stay above the list",
    permissions: MANAGER,
    installations: [ACME, OCTOCAT],
    connected: true,
    repositories: 3,
    manyRepositories: true,
    approvals: true,
  },
  {
    key: "uninstalled",
    label: "One installation was removed on GitHub: Reinstall, or Remove in ⋯",
    permissions: MANAGER,
    installations: [
      { ...ACME, repositoryCount: 60 },
      { ...OCTOCAT, issue: "uninstalled" },
    ],
    connected: true,
    repositories: 3,
    manyRepositories: true,
    approvals: true,
  },
  {
    key: "needs-authorization",
    label: "No owner proof for the link: Authorize opens the sign-in that confirms it",
    permissions: MANAGER,
    installations: [ACME, { ...OCTOCAT, issue: "owner_unconfirmed" }],
    connected: true,
    repositories: 3,
    approvals: true,
  },
  {
    key: "every-fix",
    label: "Every cause, each with its one fix",
    permissions: MANAGER,
    installations: [
      { ...ACME, accountLogin: "acme", issue: "suspended" },
      {
        installationId: 91,
        accountLogin: "acme-labs",
        accountType: "Organization",
        repositoryCount: 0,
        issue: "no_repositories",
      },
      {
        installationId: 92,
        accountLogin: "acme-archive",
        accountType: "Organization",
        repositoryCount: 4,
        issue: "owner_unconfirmed",
      },
      {
        installationId: 93,
        accountLogin: "acme-eu",
        accountType: "Organization",
        repositoryCount: 7,
        issue: "github_unreachable",
      },
      {
        installationId: 94,
        accountLogin: "acme-old",
        accountType: "Organization",
        repositoryCount: 2,
        issue: "account_changed",
      },
      { ...OCTOCAT, issue: "uninstalled" },
    ],
    connected: true,
    repositories: 3,
  },
  {
    key: "healthy",
    label: "One healthy installation: no status anywhere",
    permissions: MANAGER,
    installations: [ACME],
    connected: true,
    repositories: 3,
    approvals: true,
  },
  {
    key: "not-connected",
    label: "Not connected, app not installed",
    permissions: MANAGER,
    installations: [],
    connected: false,
    repositories: 0,
  },
  {
    key: "connected-zero",
    label: "Just connected: Choose repos is the next step",
    permissions: MANAGER,
    installations: [],
    connected: true,
    repositories: 0,
  },
  {
    key: "all-repositories",
    label: "All my repositories: anything @octocat can reach on GitHub",
    permissions: MANAGER,
    installations: [ACME],
    connected: true,
    repositories: 2,
    allRepositoriesAccess: "write",
  },
  {
    key: "needs-reconnect",
    label: "GitHub refused the stored grant: Reconnect is the one action",
    permissions: MANAGER,
    installations: [ACME],
    connected: true,
    repositories: 0,
    connectionStatus: "needs_reauth",
    selectionLoaded: false,
  },
  {
    key: "member",
    label: "A member without GitHub management: approvals read-only for the app",
    permissions: ["github:use", "connections:read", "connections:write"],
    installations: [ACME, { ...OCTOCAT, issue: "uninstalled" }],
    connected: true,
    repositories: 3,
    approvals: true,
  },
];

type Decision = "allow" | "ask" | "block" | "mixed";
type Actor = {
  kind: "workspace_app" | "personal";
  installationId?: number;
  connectionId?: string;
  label: string;
  groups: Record<"routine" | "review" | "merge", Decision>;
};

function approvalActors(state: State): Actor[] {
  return [
    ...state.installations.map((installation) => ({
      kind: "workspace_app" as const,
      installationId: installation.installationId,
      label: `Opengeni bot on ${installation.accountLogin}`,
      groups: { routine: "allow", review: "ask", merge: "ask" } as Actor["groups"],
    })),
    ...(state.connected
      ? [
          {
            kind: "personal" as const,
            connectionId: personalConnection.id,
            label: "@octocat",
            groups: { routine: "allow", review: "allow", merge: "ask" } as Actor["groups"],
          },
        ]
      : []),
  ];
}

/** The GitHub App connect flow, up to the sign-in step. */
function repairTransport() {
  let current: Record<string, unknown> | null = null;
  const attempt = () => {
    current = {
      id: "attempt-github-app-kit",
      workspaceId: WORKSPACE_ID,
      providerId: "github-app",
      ownership: "workspace",
      revision: 1,
      state: "requires_user_action",
      nextAction: { type: "authorize", url: "https://github.com/login/oauth/authorize?kit" },
      credentialsCommitted: false,
      integrationInstalled: false,
      completionRequirement: "integration",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    return structuredClone(current);
  };
  return {
    catalog: async () => [],
    accounts: async () => [],
    pending: async () => [],
    begin: async () => attempt(),
    recover: async () => structuredClone(current),
    get: async () => structuredClone(current),
    advance: async () => structuredClone(current),
    cancel: async () => structuredClone(current),
    disconnect: async () => {},
  };
}

function fakeContext(state: State) {
  const actors = approvalActors(state);
  const transport = repairTransport();
  const client = new Proxy(
    {
      connectTransport: () => transport,
      getGitHubActionPolicies: async () => ({
        enabled: state.approvals === true,
        actors: structuredClone(actors),
      }),
      updateGitHubActionPolicy: async (
        _workspaceId: string,
        input: {
          actor: { kind: string; installationId?: number; connectionId?: string };
          group: keyof Actor["groups"];
          decision: Decision;
        },
      ) => {
        const actor = actors.find((candidate) =>
          input.actor.kind === "workspace_app"
            ? candidate.installationId === input.actor.installationId
            : candidate.connectionId === input.actor.connectionId,
        )!;
        actor.groups[input.group] = input.decision;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return structuredClone(actor);
      },
    } as Record<string, unknown>,
    {
      get(target, key) {
        if (typeof key !== "string") return undefined;
        if (key in target) return target[key];
        if (key === "then") return undefined;
        return async () => ({});
      },
    },
  );
  const installations = state.installations.map(binding);
  const bound = installations.some((installation) => installation.lifecycle === "active");
  return new Proxy(
    {
      client,
      accessContext: {
        subjectId: "kit-person",
        workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions: state.permissions }],
      },
      githubStatus: {
        configured: true,
        status: bound ? "bound" : "unbound",
        setupMode: "platform",
        appId: null,
        clientId: null,
        appSlug: "opengeni",
        installUrl: "https://github.com/apps/opengeni/installations/new",
        linkUrl: "https://github.com/apps/opengeni/installations/new",
        installations,
        missing: [],
      },
      githubRepos: appRepositories(state.installations, state.manyRepositories === true),
      githubStatusFailed: false,
      githubCatalogReady: true,
      repoBusy: false,
      githubAppBusy: false,
      personalGitHubStatus: {
        enabled: true,
        connection: state.connected
          ? { ...personalConnection, status: state.connectionStatus ?? "active" }
          : null,
        reviewUrl: null,
        allRepositoriesAvailable: true,
      },
      personalGitHubSelection:
        state.connected && state.selectionLoaded !== false
          ? {
              repositories: PERSONAL_REPOSITORIES.slice(0, state.repositories),
              allRepositoriesAccess: state.allRepositoriesAccess ?? null,
            }
          : null,
      personalGitHubRepositories: state.connected
        ? PERSONAL_REPOSITORIES.map((repository) =>
            state.allRepositoriesAccess
              ? {
                  ...repository,
                  selectedAccess:
                    state.allRepositoriesAccess === "write" && repository.permissions.push
                      ? "write"
                      : "read",
                }
              : repository,
          )
        : [],
      personalGitHubCatalogReady: true,
      personalGitHubBusy: false,
      // Preview wiring: the production disconnect retries a connection that
      // changed while the page held it, then shows this toast.
      disconnectPersonalGitHub: async () => {
        toast.success("Your GitHub account was disconnected");
        return true;
      },
    } as Record<string, unknown>,
    {
      get(target, key) {
        if (typeof key !== "string") return undefined;
        if (key in target) return target[key];
        return async () => {};
      },
    },
  );
}

const READY_CATALOG = {
  status: "ready" as const,
  providers: ["github-app", "github-personal"].map((id) => ({
    id,
    label: id,
    family: "github",
    readiness: "available",
    ownership: ["personal"],
    setup: ["oauth"],
  })),
} as unknown as Parameters<typeof nativeIntegrationModel>[1];

function GitHubPage() {
  const adapter = useGitHubIntegration({ workspaceId: WORKSPACE_ID });
  const model = nativeIntegrationModel(adapter.model, READY_CATALOG, false, () => {});
  return (
    <>
      <IntegrationPage model={model} onBack={() => {}} backLabel="Capabilities" />
      {adapter.dialogs}
    </>
  );
}

function Provider({ state, children }: { state: State; children: ReactNode }) {
  const value = useMemo(() => fakeContext(state), [state]);
  return <AppContext.Provider value={value as never}>{children}</AppContext.Provider>;
}

const CARD_REQUEST = {
  kind: "auth-needed",
  id: "github-personal-kit",
  turnId: "turn-kit",
  serverId: "opengeni",
  providerDomain: "github.com",
  connectionId: null,
  reason: "missing_connection",
  scopes: [],
  resource: null,
  toolName: "capability_authorization_request",
  authorizationUrl: null,
  occurredAt: NOW,
  capability: {
    id: "api:github-personal",
    name: "Your GitHub",
    kind: "api",
    source: "built_in",
    action: "connect",
    rationale: "Connect your GitHub so the pull request opens under your name.",
    requiredVariables: [],
  },
} as unknown as AuthNeededItem;

const stateByKey = (key: string) => STATES.find((state) => state.key === key)!;
const CARD_STATES: State[] = [
  { ...stateByKey("not-connected"), key: "card-not-connected", label: "Chat card: not connected" },
  {
    ...stateByKey("connected-zero"),
    key: "card-connected-zero",
    label: "Chat card: connected, no repos yet",
  },
  { ...stateByKey("healthy"), key: "card-connected", label: "Chat card: connected with repos" },
];

export default function GitHubIntegrationPageSection() {
  return (
    <KitSection sectionKey="page-github-integration">
      <StatesGrid title="States" columns={1}>
        {STATES.filter((state) => showPart(state.key)).map((state) => (
          <StateCell key={state.key} label={state.label} align="stretch" span="full">
            <div data-preview={`github-${state.key}`} className="w-full max-w-[760px]">
              <PagePreview label={`GitHub: ${state.label}`}>
                <Provider state={state}>
                  <GitHubPage />
                </Provider>
              </PagePreview>
            </div>
          </StateCell>
        ))}
      </StatesGrid>
      {showPart("reconnect-toast") ? (
        <StatesGrid title="Toast" columns={1}>
          <StateCell label="Shown once per stale grant; it stays until Reconnect or close">
            <div data-preview="github-reconnect-toast">
              <Button
                variant="outline"
                onClick={() =>
                  showPersonalGitHubReconnectToast(
                    personalConnection.metadata.githubLogin,
                    () => {},
                  )
                }
              >
                Show the reconnect toast
              </Button>
            </div>
          </StateCell>
        </StatesGrid>
      ) : null}
      <StatesGrid title="In a chat" columns={1}>
        {CARD_STATES.filter((state) => showPart(state.key)).map((state) => (
          <StateCell key={state.key} label={state.label} align="stretch" span="full">
            <div data-preview={`github-${state.key}`} className="w-full max-w-[560px]">
              <Provider state={state}>
                <SessionPersonalGitHubCapabilityCard
                  item={CARD_REQUEST}
                  workspaceId={WORKSPACE_ID}
                />
              </Provider>
            </div>
          </StateCell>
        ))}
      </StatesGrid>
    </KitSection>
  );
}
