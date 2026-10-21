// Synthetic organization "Acme" with one shared workspace, "Design", seen by
// an organization owner. `openai=1` and `azure=1` start those organization keys
// connected. Every write lands in `window.modelsReceipts` with keys redacted.
const params = new URLSearchParams(window.location.search);
const receipts: unknown[] = [];
(window as unknown as { modelsReceipts: unknown[] }).modelsReceipts = receipts;

type Connection = {
  id: string;
  providerKind: string;
  status: "active" | "revoked";
  version: number;
  endpoint?: string | null;
  createdAt: string;
  updatedAt: string;
};
const now = "2026-10-21T12:00:00.000Z";
const connections: Record<string, Connection | null> = {
  openai:
    params.get("openai") === "1"
      ? { id: "org-openai", providerKind: "openai", status: "active", version: 1, createdAt: now, updatedAt: now }
      : null,
  azure_openai:
    params.get("azure") === "1"
      ? {
          id: "org-azure",
          providerKind: "azure_openai",
          status: "active",
          version: 1,
          endpoint: "https://acme.openai.azure.com/openai/v1",
          createdAt: now,
          updatedAt: now,
        }
      : null,
};
const customModels: Record<string, { id: string; upstreamModelId: string; label: null; version: number; createdAt: string; updatedAt: string }[]> = {
  openai: params.get("openai") === "1" ? [{ id: "m-1", upstreamModelId: "gpt-6.1-sol", label: null, version: 1, createdAt: now, updatedAt: now }] : [],
  azure_openai: [],
};
const emptyPool = {
  accounts: [],
  activeAccountId: null,
  settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: null },
};
const accountValues = {
  rotation: {},
  providers: {},
  crossProviderFailover: false,
  fallbackOrder: {},
  personalConnectionsAllowed: true,
  personalFallbackAllowed: false,
};
const nulls = Object.fromEntries(Object.keys(accountValues).map((key) => [key, null]));
const fromOrganization = Object.fromEntries(
  Object.keys(accountValues).map((key) => [key, "organization"]),
);
const openPolicy = {
  allowedModels: null,
  allowedWorkspaces: null,
  allowPersonalWorkspaces: true,
  version: 1,
};

const known: Record<string, (...args: any[]) => Promise<unknown>> = {
  listCodexAccounts: async () => ({
    ...emptyPool,
    source: {
      accountId: "acme",
      workspaceId: "design",
      workspaceKind: "shared",
      mode: "automatic",
      effectiveSource: "organization",
      workspaceAvailable: false,
      organizationAvailable: false,
    },
  }),
  codexOverview: async () => ({ accounts: {} }),
  requestJson: async (method: string) => (method === "GET" ? emptyPool : {}),
  getModelConnectionAccess: async () => ({
    policy: openPolicy,
    workspaces: [{ id: "design", name: "Design" }],
    models: [],
    personalWorkspacesSupported: false,
  }),
  updateModelConnectionAccess: async (_target: unknown, policy: unknown) => policy,
  listSuperGrokAccounts: async () => emptyPool,
  listOrganizationSuperGrokAccounts: async () => emptyPool,
  listConnections: async () => [],
  listClaudeSubscriptionAccounts: async () => ({ ...emptyPool, source: "workspace" }),
  listOrganizationClaudeSubscriptionAccounts: async () => ({ ...emptyPool, source: "organization" }),
  listWorkspaceGatewayCustomModels: async () => ({ models: [] }),
  listWorkspaceOpenRouterCustomModels: async () => ({ models: [] }),
  listWorkspaceOpperCustomModels: async () => ({ models: [] }),
  listWorkspaceClaudeCustomModels: async () => ({ models: [] }),
  getWorkspaceModelCatalog: async () => ({ models: [] }),
  getWorkspaceModelAccessPolicy: async () => ({ allowedProviders: null, allowedModels: null }),
  getWorkspaceModelAccountSettings: async () => ({
    workspaceId: "design",
    values: accountValues,
    sources: fromOrganization,
    entrySources: { rotation: {}, providers: {}, fallbackOrder: {} },
    locked: [],
    overrides: nulls,
    version: 0,
    updatedAt: null,
    canEdit: true,
  }),
  getModelAccountSettingsOverview: async () => ({
    organization: {
      organizationId: "acme",
      values: accountValues,
      locked: [],
      version: 0,
      updatedAt: null,
    },
    workspaces: [],
    nextCursor: null,
  }),
  getOrganizationAdministrationOverview: async () => ({
    organization: { id: "acme", name: "Acme" },
    roles: [],
    workspaces: [{ id: "design", name: "Design" }],
  }),
  getWorkspaceSubscriptionUsagePools: async () => ({ pools: [] }),
  getOrganizationSubscriptionUsagePools: async () => ({ pools: [] }),
  getBilling: async () => ({ mode: "disabled" }),
  getOrganizationModelProviderConnection: async (_org: string, kind: string) =>
    connections[kind] ?? null,
  upsertOrganizationModelProviderConnection: async (
    _org: string,
    kind: string,
    request: { endpoint?: string },
  ) => {
    receipts.push({ upsert: kind, request: { ...request, apiKey: "redacted" } });
    const saved: Connection = {
      id: `org-${kind}`,
      providerKind: kind,
      status: "active",
      version: (connections[kind]?.version ?? 0) + 1,
      ...(request.endpoint ? { endpoint: `${request.endpoint.replace(/\/+$/, "")}/openai/v1` } : {}),
      createdAt: now,
      updatedAt: now,
    };
    connections[kind] = saved;
    return saved;
  },
  revokeOrganizationModelProviderConnection: async (_org: string, kind: string) => {
    receipts.push({ revoke: kind });
    const current = connections[kind];
    connections[kind] = null;
    return { ...current, status: "revoked", version: (current?.version ?? 0) + 1 };
  },
  listOrganizationProviderCustomModels: async (_org: string, kind: string) => ({
    models: [...(customModels[kind] ?? [])],
  }),
  createOrganizationProviderCustomModel: async (
    _org: string,
    kind: string,
    request: { upstreamModelId: string },
  ) => {
    receipts.push({ addModel: kind, upstreamModelId: request.upstreamModelId });
    const model = {
      id: `m-${Date.now()}`,
      upstreamModelId: request.upstreamModelId,
      label: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    (customModels[kind] ??= []).push(model);
    return model;
  },
};

// Reads this preview doesn't model answer empty; each one is named in the console.
const client = new Proxy(known, {
  get(target, name: string) {
    if (name in target) return target[name];
    if (name === "then") return undefined;
    return async () => {
      console.info(`[preview] unmodelled client call ${name}`);
      return { models: [], accounts: [], pools: [], items: [] };
    };
  },
});

// One stable value, as the app's memoized context is.
const appContext = {
    client,
    clientConfig: {
      billingMode: "disabled",
      models: [],
      defaultModel: "codex/sol",
      defaultReasoningEffort: "medium",
    },
    accessContext: null,
    workspaces: [{ id: "design", name: "Design", settings: {} }],
    captureWorkspaceInvocation: () => "preview-transition",
    ownsWorkspaceInvocation: () => true,
    updateWorkspaceSettings: async () => null,
};

export function useAppContext() {
  return appContext;
}
