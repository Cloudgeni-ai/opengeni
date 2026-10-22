// Synthetic organization "Acme" with one shared workspace, "Design", seen by
// an organization owner. `openai=1` and `azure=1` start those organization keys
// connected. `many=1` gives the organization twelve Codex and eleven Claude
// accounts with mixed owners, reach and status, and a second workspace,
// "Research". Every write lands in `window.modelsReceipts` with keys redacted.
// `claude=1` turns Claude subscriptions on. Its sign-in is synthetic: start
// returns a claude.com URL (the browser test stubs that page), and complete
// accepts only "preview-code" and holds for 1.5s when `slow=1`.
import { OpenGeniApiError } from "@opengeni/sdk";
import { createElement, type ReactNode } from "react";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";

const params = new URLSearchParams(window.location.search);
const many = params.get("many") === "1";
const claudeOn = many || params.get("claude") === "1";
const slow = params.get("slow") === "1";
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

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const everyone = {
  ownerWorkspaceId: null,
  everyWorkspace: true,
  workspaceIds: [],
  personalWorkspaces: true,
  people: null,
};
const reaches = [
  everyone,
  everyone,
  { ...everyone, everyWorkspace: false, personalWorkspaces: false, workspaceIds: ["design"] },
  { ...everyone, ownerWorkspaceId: "research", everyWorkspace: false, workspaceIds: ["research"] },
  { ...everyone, everyWorkspace: false, people: 3 },
  { ...everyone, personalWorkspaces: false },
];
const names = ["Ada", "Bo", "Cleo", "Dag", "Eli", "Frida", "Gus", "Hedda", "Ivar", "Juno", "Kai", "Liv"];
const manyCodex = names.map((name, index) => ({
  id: id(index + 1),
  source: "organization",
  label: `${name}'s plan`,
  email: `${name.toLowerCase()}@acme.example`,
  plan: index % 3 === 0 ? "pro" : "plus",
  status: index === 4 ? "needs_relogin" : "active",
  active: index === 0,
  allocatorEnabled: index < 8,
  allocatorVersion: 1,
  appsDesignated: false,
  canEnableApps: false,
  reach: reaches[index % reaches.length],
  weekly: { used: 10 + index * 7, limit: 100, remaining: 90 - index * 7, percent: 10 + index * 7, resetAt: null, resetAfterSeconds: 86_400 * 3, limitWindowSeconds: 604_800 },
}));
const manyClaude = names.slice(0, 11).map((name, index) => ({
  id: id(100 + index),
  scope: "organization",
  subject: "acme",
  email: `${name.toLowerCase()}.claude@acme.example`,
  label: `${name} Max`,
  plan: index % 2 === 0 ? "claude_max" : "claude_pro",
  status: index === 6 ? "needs_relogin" : "active",
  active: index === 0,
  expiresAt: null,
  lastRefreshAt: now,
  lastError: null,
  allocatorEnabled: index < 7,
  allocatorVersion: 1,
  allocatorUpdatedAt: null,
  version: 1,
  reach: reaches[(index + 2) % reaches.length],
}));
// Claude accounts connected through this preview's sign-in.
const claudeConnected: Record<"organization" | "workspace", unknown[]> = {
  organization: [],
  workspace: [],
};
const claudeAttempt = "11111111-1111-4111-8111-111111111111";
const claudeStart = async (scope: "organization" | "workspace", request?: unknown) => {
  receipts.push({ claudeStart: scope, request });
  if (slow) await new Promise((resolve) => setTimeout(resolve, 1000));
  return {
    attemptId: claudeAttempt,
    authorizationUrl: "https://claude.com/cai/oauth/authorize?state=preview",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
};
const claudeComplete = async (scope: "organization" | "workspace", request: { code: string }) => {
  if (slow) await new Promise((resolve) => setTimeout(resolve, 1500));
  receipts.push({ claudeComplete: scope, code: request.code === "preview-code" });
  if (request.code !== "preview-code") {
    throw new OpenGeniApiError(422, "", {
      code: "validation_error",
      displayMessage: "Copy the full authorization code from the Claude page.",
    });
  }
  const account = {
    ...manyClaude[0]!,
    id: id(900),
    scope: scope === "organization" ? "organization" : "workspace",
    email: "ada.claude@acme.example",
    label: null,
    active: true,
    reach: everyone,
  };
  claudeConnected[scope] = [account];
  return { connected: true, accountId: account.id, credentialVersion: 1 };
};
const pool = (provider: "codex" | "claude", accounts: { id: string; label: string }[]) => ({
  provider,
  observedAt: now,
  windows: [
    {
      id: "weekly",
      remainingPercent: provider === "codex" ? 58 : 71,
      accounts: accounts.map((account, index) => ({
        id: account.id,
        label: account.label,
        remainingPercent: 90 - index * 6,
        resetsAt: null,
        weight: 1,
        weightBasis: "plan_estimate",
        observedAt: now,
      })),
      forecast: {
        kind: "unused",
        basis: "last 14 days",
        runsOutAt: null,
        nextResetAt: "2026-10-24T12:00:00.000Z",
        unusedPercent: 22,
        lowestPercent: 40,
        historyDays: 14,
      },
    },
  ],
});
const organizationPools = many
  ? {
      pools: [
        pool("codex", manyCodex.slice(0, 8).map((account) => ({ id: account.id, label: account.label }))),
        pool("claude", manyClaude.slice(0, 7).map((account) => ({ id: account.id, label: account.label ?? "" }))),
      ],
      checkedAt: now,
    }
  : { pools: [] };
const codexOverview = (index: number) => ({
  accountId: id(index + 1),
  usage: {
    source: "provider",
    fetchedAt: now,
    stale: false,
    error: null,
    value: {
      status: "ok",
      planType: null,
      fiveHour: null,
      weekly: manyCodex[index]!.weekly,
      limitReached: false,
      fetchedAt: now,
    },
  },
  resetCredits: { source: "none", fetchedAt: null, stale: false, error: null, detailState: "unknown", detailsComplete: false, availableCount: null, credits: [] },
  canRedeem: false,
  canResumeRedemption: false,
  redemptions: [],
  redemptionAccess: { ownership: "unowned", canClaimUnownedViaReconnect: false },
});

const known: Record<string, (...args: any[]) => Promise<unknown>> = {
  getClaudeSubscriptionAccountUsage: async () => previewClaudeUsage(),
  getOrganizationClaudeSubscriptionAccountUsage: async () => previewClaudeUsage(),
  startOrganizationClaudeSubscriptionOAuth: async () => claudeStart("organization"),
  startWorkspaceClaudeSubscriptionOAuth: async (_workspace: string, request: unknown) =>
    claudeStart("workspace", request),
  completeOrganizationClaudeSubscriptionOAuth: async (_org: string, request: { code: string }) =>
    claudeComplete("organization", request),
  completeWorkspaceClaudeSubscriptionOAuth: async (_workspace: string, request: { code: string }) =>
    claudeComplete("workspace", request),
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
  requestJson: async (method: string, path: string) => {
    if (method !== "GET") return {};
    if (!many) return emptyPool;
    if (path.endsWith("/codex/accounts")) {
      return { ...emptyPool, accounts: manyCodex, activeAccountId: manyCodex[0]!.id };
    }
    const overview = /\/codex\/accounts\/([^/]+)\/overview$/.exec(path);
    if (overview) {
      // Live usage arrives a little after the list, as it does for real.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return codexOverview(manyCodex.findIndex((account) => account.id === overview[1]));
    }
    return emptyPool;
  },
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
  listClaudeSubscriptionAccounts: async () => ({
    ...emptyPool,
    accounts: claudeConnected.workspace,
    source: "workspace",
  }),
  listOrganizationClaudeSubscriptionAccounts: async () =>
    many
      ? { ...emptyPool, accounts: manyClaude, activeAccountId: manyClaude[0]!.id, source: "organization" }
      : { ...emptyPool, accounts: claudeConnected.organization, source: "organization" },
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
    workspaces: [
      { id: "design", name: "Design" },
      ...(many ? [{ id: "research", name: "Research" }] : []),
    ],
  }),
  getWorkspaceSubscriptionUsagePools: async () => ({ pools: [] }),
  getOrganizationSubscriptionUsagePools: async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return organizationPools;
  },
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

function previewClaudeUsage() {
  return {
    connected: true,
    credentialVersion: 1,
    windows: [],
    observedAt: null,
    source: null,
    refreshStatus: "not_checked",
    refreshCheckedAt: null,
  };
}

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
      ...(claudeOn ? { claudeSubscriptionEnabled: true } : {}),
    },
    accessContext: null,
    workspaces: [
      { id: "design", name: "Design", settings: {} },
      ...(many ? [{ id: "research", name: "Research", settings: {} }] : []),
    ],
    captureWorkspaceInvocation: () => "preview-transition",
    ownsWorkspaceInvocation: () => true,
    updateWorkspaceSettings: async () => null,
};

export function useAppContext() {
  return appContext;
}

// Some lazy/shared components resolve through the package entry point instead
// of the preview alias. Supply the same synthetic state through the real
// context too, so navigation does not depend on Vite's optimized-module graph.
export function PreviewAppContextProvider({ children }: { children: ReactNode }) {
  return createElement(AppContext.Provider, { value: appContext as unknown as AppContextValue }, children);
}
