import { useSyncExternalStore } from "react";

// Sample-only app context for the production GitHub conversation card. Each
// `?state=` is one product state; no request leaves the page.
const params = new URLSearchParams(window.location.search);
export const scenario = params.get("state") ?? "ready";

export const githubCatalogItem = {
  id: "api:github-app",
  kind: "api",
  name: "GitHub App",
  description: "Connect your GitHub account and choose the repositories this workspace can access.",
  providerDomain: "github.com",
  logoAssetPath: null,
  enabled: false,
  authKind: "oauth2",
  metadata: {},
};

const WORKSPACE = "sample";
const installation = (installationId: number, accountLogin: string) => ({
  installationId,
  githubAccountId: installationId,
  accountLogin,
  accountType: accountLogin === "acme" ? "Organization" : "User",
  lifecycle: "active" as const,
  repositoryScope: "selected" as const,
  repositoryCount: 0,
  configureUrl: "https://github.com/apps/opengeni/installations/42",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});
const repo = (
  id: number,
  fullName: string,
  options: { private?: boolean; branch?: string; installationId?: number } = {},
) => {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    id,
    installationId: options.installationId ?? 42,
    fullName,
    name,
    private: options.private ?? true,
    htmlUrl: `https://github.com/${fullName}`,
    cloneUrl: `https://github.com/${fullName}.git`,
    defaultBranch: options.branch ?? "main",
    accountLogin: owner,
    accountType: "Organization",
  };
};
const acme = [
  repo(101, "acme/api"),
  repo(102, "acme/web"),
  repo(103, "acme/docs", { private: false }),
  repo(104, "acme/infra", { branch: "production" }),
  repo(105, "acme/mobile"),
  repo(106, "acme/design-system", { private: false }),
  repo(107, "acme/data-pipeline"),
  repo(108, "acme/billing"),
  repo(109, "acme/auth-service", { branch: "develop" }),
  repo(110, "acme/marketing-site", { private: false }),
  repo(111, "acme/cli", { private: false }),
  repo(112, "acme/sdk-python"),
];
const northwind = [
  repo(201, "northwind/dotfiles", { installationId: 77, private: false }),
  repo(202, "northwind/notes", { installationId: 77 }),
];
const mounted = (repository: (typeof acme)[number]) => ({
  kind: "repository" as const,
  uri: repository.cloneUrl,
  ref: repository.defaultBranch,
  provider: "github" as const,
  mountPath: `repos/github.com/${repository.fullName}`,
  githubRepositoryId: repository.id,
  githubInstallationId: repository.installationId,
});

const bound = (installations = [installation(42, "acme")]) => ({
  configured: true,
  status: "bound",
  setupMode: "platform",
  appId: null,
  clientId: null,
  appSlug: null,
  installUrl: "https://api.example.test/github/connect",
  linkUrl: "https://api.example.test/github/connect",
  installations,
  missing: [],
});
const unbound = {
  ...bound([]),
  status: "unbound",
};

type Store = {
  githubStatus: unknown;
  githubRepos: unknown[];
  githubCatalogReady: boolean;
  githubStatusFailed: boolean;
  permissions: string[];
  personal: boolean;
  resources: unknown[];
  sent: unknown[];
};

const everyone = ["github:use", "github:manage", "sessions:control", "sessions:read"];
function initial(): Store {
  const base: Store = {
    githubStatus: bound(),
    githubRepos: acme,
    githubCatalogReady: true,
    githubStatusFailed: false,
    permissions: everyone,
    personal: false,
    resources: [],
    sent: [],
  };
  switch (scenario) {
    case "ready":
    case "opening":
      return { ...base, githubStatus: unbound, githubRepos: [] };
    case "connected":
    case "connected-zero":
      return { ...base, githubRepos: [] };
    case "connected-one":
    case "attach-one":
      return { ...base, githubRepos: [acme[0]] };
    case "attached":
      return { ...base, resources: [mounted(acme[0]!)] };
    case "revoked":
      return { ...base, resources: [mounted(repo(150, "acme/legacy-api"))] };
    case "multi":
      return {
        ...base,
        githubStatus: bound([installation(42, "acme"), installation(77, "northwind")]),
        githubRepos: [...acme.slice(0, 3), ...northwind],
        resources: [mounted(acme[0]!)],
      };
    case "read-only":
      return { ...base, permissions: ["github:use", "sessions:read"] };
    case "member":
      return {
        ...base,
        githubStatus: { ...bound(), linkUrl: null, installUrl: null },
        permissions: ["github:use", "sessions:control", "sessions:read"],
      };
    case "personal":
      return { ...base, personal: true, githubRepos: acme.slice(0, 3) };
    case "loading":
      return { ...base, githubRepos: [], githubCatalogReady: false };
    case "load-failed":
      return { ...base, githubRepos: [], githubCatalogReady: false, githubStatusFailed: true };
    case "not-configured":
      return {
        ...base,
        githubStatus: { ...unbound, configured: false, status: "disabled", linkUrl: null },
        githubRepos: [],
      };
    case "not-configured-operator":
      return {
        ...base,
        githubStatus: {
          ...unbound,
          configured: false,
          status: "disabled",
          setupMode: "operator",
          linkUrl: null,
        },
        githubRepos: [],
      };
    case "cannot-connect":
      return {
        ...base,
        githubStatus: { ...unbound, linkUrl: null, installUrl: null },
        githubRepos: [],
        permissions: ["github:use", "sessions:control"],
      };
    case "no-access":
      return { ...base, githubStatus: null, githubRepos: [], permissions: ["sessions:control"] };
    default:
      return base;
  }
}

let store = initial();
const listeners = new Set<() => void>();
function update(patch: Partial<Store>) {
  store = { ...store, ...patch };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Browser checks drive "connected in another tab" and read submitted messages. */
const control = {
  store: () => store,
  connectElsewhere: () => update({ githubStatus: bound(), githubRepos: acme }),
  revoke: () => update({ githubRepos: store.githubRepos.slice(1) }),
  refreshes: 0,
};
(window as unknown as { __githubCard: typeof control }).__githubCard = control;

const sendBehaviour = params.get("send") ?? "ok";
const client = {
  catalogAssetUrl: () => null,
  // The pending navigation state: GitHub never answers in the preview.
  getGitHubApp: async () => await new Promise(() => {}),
  sendMessage: async (_workspaceId: string, _sessionId: string, input: unknown) => {
    update({ sent: [...store.sent, input] });
    if (sendBehaviour === "pending") return await new Promise(() => {});
    if (sendBehaviour === "fail") {
      throw Object.assign(new Error("The session is no longer accepting messages."), {
        status: 409,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      id: "accepted",
      type: "user.message",
      payload: { routing: sendBehaviour === "queued" ? "queued_for_execution" : "accepted_for_execution" },
    };
  },
};

function contextFor(current: Store) {
  return {
    client,
    githubStatus: current.githubStatus,
    githubRepos: current.githubRepos,
    githubCatalogReady: current.githubCatalogReady,
    githubStatusFailed: current.githubStatusFailed,
    repoBusy: false,
    personalGitHubBusy: false,
    refreshGitHub: async () => {
      control.refreshes += 1;
    },
    refreshPersonalGitHub: async () => {},
    captureWorkspaceInvocation: () => ({ revision: 1 }),
    accessContext: {
      subjectId: "member",
      workspaceGrants: [{ workspaceId: WORKSPACE, permissions: current.permissions }],
    },
    workspaces: [{ id: WORKSPACE, kind: current.personal ? "personal" : "shared" }],
    workspaceCapabilityCatalog: [githubCatalogItem],
  };
}
let cached = { store, context: contextFor(store) };

export function useAppContext() {
  const current = useSyncExternalStore(subscribe, () => store);
  if (cached.store !== current) cached = { store: current, context: contextFor(current) };
  return cached.context;
}

export function sessionResources() {
  return store.resources;
}
export function useSessionResources() {
  return useSyncExternalStore(subscribe, () => store.resources);
}
