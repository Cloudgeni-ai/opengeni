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
   context. Each state is one person's view of the same workspace.
   -------------------------------------------------------------------------- */

const WORKSPACE_ID = "ws-kit";
const NOW = "2026-10-30T09:00:00.000Z";

const installation = {
  installationId: 71,
  githubAccountId: 72,
  accountLogin: "acme",
  accountType: "Organization",
  lifecycle: "active",
  repositoryScope: "selected",
  repositoryCount: 2,
  configureUrl: "https://github.com/organizations/acme/settings/installations/71",
  createdAt: NOW,
  updatedAt: NOW,
};
const appStatus = (bound: boolean) => ({
  configured: true,
  status: bound ? "bound" : "unbound",
  setupMode: "platform",
  appId: null,
  clientId: null,
  appSlug: "opengeni",
  installUrl: "https://github.com/apps/opengeni/installations/new",
  linkUrl: "https://github.com/apps/opengeni/installations/new",
  installations: bound ? [installation] : [],
  missing: [],
});
const appRepos = [
  { id: 1, installationId: 71, fullName: "acme/web", private: true },
  { id: 2, installationId: 71, fullName: "acme/api", private: true },
];
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
  bound: boolean;
  connected: boolean;
  repositories: number;
  /** The stored grant's status; GitHub refusing a refresh makes it needs_reauth. */
  connectionStatus?: "active" | "needs_reauth";
  /** False when the repository selection could not be read. */
  selectionLoaded?: boolean;
  /** All my repositories, at this access. */
  allRepositoriesAccess?: "read" | "write";
  /** Action approvals as the server reports them; absent when off. */
  sensitive?: "allow" | "ask" | "block";
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
    key: "not-connected",
    label: "Not connected, app not installed",
    permissions: MANAGER,
    bound: false,
    connected: false,
    repositories: 0,
  },
  {
    key: "connected-zero",
    label: "Just connected: Choose repos is the next step",
    permissions: MANAGER,
    bound: false,
    connected: true,
    repositories: 0,
  },
  {
    key: "both",
    label: "Your GitHub connected and the Opengeni app installed",
    permissions: MANAGER,
    bound: true,
    connected: true,
    repositories: 3,
  },
  {
    key: "all-repositories",
    label: "All my repositories: anything @octocat can reach on GitHub",
    permissions: MANAGER,
    bound: true,
    connected: true,
    repositories: 2,
    allRepositoriesAccess: "write",
  },
  {
    key: "needs-reconnect",
    label: "GitHub refused the stored grant: Reconnect is the one action",
    permissions: MANAGER,
    bound: true,
    connected: true,
    repositories: 0,
    connectionStatus: "needs_reauth",
    selectionLoaded: false,
  },
  {
    key: "selection-unread",
    label: "Connected, but the repository list could not be read yet",
    permissions: MANAGER,
    bound: true,
    connected: true,
    repositories: 0,
    selectionLoaded: false,
  },
  {
    key: "member",
    label: "A member without GitHub management",
    permissions: ["github:use", "connections:read", "connections:write"],
    bound: true,
    connected: false,
    repositories: 0,
  },
  {
    key: "approvals",
    label: "Action approvals: Settings and deletions starts at Ask",
    permissions: MANAGER,
    bound: true,
    connected: true,
    repositories: 3,
    sensitive: "ask",
  },
  {
    key: "approvals-allowed",
    label: "Action approvals: the person allowed Settings and deletions",
    permissions: MANAGER,
    bound: true,
    connected: true,
    repositories: 3,
    sensitive: "allow",
  },
];

function fakeContext(state: State) {
  const client = new Proxy(
    {
      connectTransport: () => ({}),
      getGitHubActionPolicies: async () =>
        state.sensitive
          ? {
              enabled: true,
              actors: [
                {
                  kind: "workspace_app",
                  installationId: 71,
                  label: "Opengeni bot on acme",
                  groups: { routine: "allow", review: "ask", merge: "ask" },
                },
                {
                  kind: "personal",
                  connectionId: personalConnection.id,
                  label: `@${personalConnection.metadata.githubLogin}`,
                  groups: {
                    routine: "allow",
                    review: "allow",
                    merge: "allow",
                    sensitive: state.sensitive,
                  },
                },
              ],
            }
          : { enabled: false, actors: [] },
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
  return new Proxy(
    {
      client,
      accessContext: {
        subjectId: "kit-person",
        workspaceGrants: [{ workspaceId: WORKSPACE_ID, permissions: state.permissions }],
      },
      githubStatus: appStatus(state.bound),
      githubRepos: state.bound ? appRepos : [],
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

const CARD_STATES: State[] = [
  { ...STATES[0]!, key: "card-not-connected", label: "Chat card: not connected" },
  { ...STATES[1]!, key: "card-connected-zero", label: "Chat card: connected, no repos yet" },
  { ...STATES[2]!, key: "card-connected", label: "Chat card: connected with repos" },
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
