// SAMPLE DATA. Synthetic organization "Acme": no real accounts, credentials,
// people or provider calls. "Design team plan" was connected in the Design
// workspace (a former "Design only" account); "Acme Pro" is an account the
// organization connected. Saves change only this page's memory.
const ORG = "00000000-0000-4000-8000-00000000a000";
export const WORKSPACES = {
  design: { id: "00000000-0000-4000-8000-0000000000d1", name: "Design" },
  platform: { id: "00000000-0000-4000-8000-0000000000d2", name: "Platform" },
  research: { id: "00000000-0000-4000-8000-0000000000d3", name: "Research" },
  personal: { id: "00000000-0000-4000-8000-0000000000d4", name: "Alex Morgan" },
};
const PEOPLE = [
  { id: "00000000-0000-4000-8000-0000000000e1", name: "Alex Morgan", email: "alex@example.com" },
  { id: "00000000-0000-4000-8000-0000000000e2", name: "Sam Rivera", email: "sam@example.com" },
  { id: "00000000-0000-4000-8000-0000000000e3", name: "Jo Chen", email: "jo@example.com" },
];
const ACME_PRO = "00000000-0000-4000-8000-0000000000c1";
const DESIGN_PLAN = "00000000-0000-4000-8000-0000000000c2";

const params = new URLSearchParams(window.location.search);
/** `reach=people` or `reach=all` starts the former workspace account shared that way. */
const initialReach = params.get("reach");

const weekly = (remaining: number) => ({
  used: 100 - remaining,
  limit: 100,
  remaining,
  percent: 100 - remaining,
  resetAt: null,
  resetAfterSeconds: null,
  limitWindowSeconds: 604800,
});
function account(id: string, label: string, email: string, remaining: number, active: boolean) {
  return {
    id,
    source: "organization" as const,
    label,
    email,
    plan: "pro",
    status: "active" as const,
    active,
    allocatorEnabled: true,
    allocatorVersion: 1,
    extraCreditsEnabled: false,
    appsDesignated: false,
    canEnableApps: false,
    weekly: weekly(remaining),
    fiveHour: weekly(Math.min(100, remaining + 20)),
  };
}
const organizationAccounts = [
  account(ACME_PRO, "Acme Pro", "billing@example.com", 62, true),
  account(DESIGN_PLAN, "Design team plan", "design@example.com", 81, false),
];

type Policy = {
  allowedModels: string[] | null;
  allowedWorkspaces: string[] | null;
  allowPersonalWorkspaces: boolean;
  allowedPeople?: string[] | null;
  version: number;
};
const policies: Record<string, Policy> = {
  [ACME_PRO]: {
    allowedModels: null,
    allowedWorkspaces: null,
    allowPersonalWorkspaces: true,
    version: 1,
  },
  // Its reach today: only the workspace that connected it.
  [DESIGN_PLAN]:
    initialReach === "people"
      ? {
          allowedModels: null,
          allowedWorkspaces: [],
          allowPersonalWorkspaces: false,
          allowedPeople: [PEOPLE[0]!.id, PEOPLE[1]!.id],
          version: 2,
        }
      : {
          allowedModels: null,
          allowedWorkspaces: initialReach === "all" ? null : [],
          allowPersonalWorkspaces: false,
          version: 1,
        },
};
const local: Record<string, string[]> = { [DESIGN_PLAN]: [WORKSPACES.design.id] };
const managedBy: Record<string, string | null> = {
  [ACME_PRO]: null,
  [DESIGN_PLAN]: WORKSPACES.design.id,
};

export const receipts: unknown[] = [];
Object.assign(window, { accessReceipts: receipts });

const empty = {
  accounts: [],
  activeAccountId: null,
  settings: { rotationEnabled: false, rotationStrategy: "sharded", activeCredentialId: null },
};
const usage = {
  connected: true,
  credentialVersion: 1,
  windows: [],
  observedAt: null,
  source: null,
  refreshStatus: "not_checked",
  refreshCheckedAt: null,
};

const methods: Record<string, (...args: never[]) => Promise<unknown>> = {
  async requestJson(method: string, path: string, body?: unknown) {
    if (method === "GET" && path === `/v1/organizations/${ORG}/codex/accounts`) {
      return {
        accounts: organizationAccounts,
        activeAccountId: ACME_PRO,
        settings: {
          rotationEnabled: true,
          rotationStrategy: "sharded",
          activeCredentialId: ACME_PRO,
        },
      };
    }
    if (method === "GET" && path.endsWith("/overview")) {
      const id = path.split("/").at(-2)!;
      const remaining = id === ACME_PRO ? 62 : 81;
      return {
        accountId: id,
        usage: {
          source: "provider",
          fetchedAt: new Date().toISOString(),
          stale: false,
          error: null,
          value: {
            status: "ok",
            planType: "pro",
            fiveHour: weekly(Math.min(100, remaining + 20)),
            weekly: weekly(remaining),
            limitReached: false,
            fetchedAt: new Date().toISOString(),
          },
        },
        resetCredits: {
          source: "none",
          fetchedAt: null,
          stale: false,
          error: null,
          detailState: "unknown",
          detailsComplete: false,
          availableCount: null,
          credits: [],
        },
        canRedeem: false,
        canResumeRedemption: false,
        redemptions: [],
        redemptionAccess: { ownership: "unowned", canClaimUnownedViaReconnect: false },
      };
    }
    receipts.push({ method, path, body });
    return {};
  },
  async listCodexAccounts(workspaceId: string) {
    // Each workspace reads the accounts it uses; Design's own is the former workspace account.
    const reaches = (id: string) => {
      const policy = policies[id]!;
      return (
        local[id]?.includes(workspaceId) ||
        policy.allowedWorkspaces === null ||
        policy.allowedWorkspaces.includes(workspaceId)
      );
    };
    // A workspace with its own account uses only its own (source "workspace").
    const own = organizationAccounts.filter((entry) => local[entry.id]?.includes(workspaceId));
    return {
      accounts: organizationAccounts
        .filter((entry) => workspaceId !== WORKSPACES.personal.id && reaches(entry.id))
        .filter((entry) => own.length === 0 || own.includes(entry))
        .map((entry) => ({
          ...entry,
          source: local[entry.id]?.includes(workspaceId) ? "workspace" : "organization",
        })),
      activeAccountId: ACME_PRO,
      source: {
        accountId: ORG,
        workspaceId,
        workspaceKind: workspaceId === WORKSPACES.personal.id ? "personal" : "shared",
        mode: "automatic",
        effectiveSource: own.length > 0 ? "workspace" : "organization",
        workspaceAvailable: true,
        organizationAvailable: true,
      },
      settings: {
        rotationEnabled: true,
        rotationStrategy: "sharded",
        activeCredentialId: ACME_PRO,
      },
    };
  },
  async codexOverview() {
    return { accounts: {} };
  },
  async getModelConnectionAccess(target: { connectionId: string }) {
    const id = target.connectionId;
    return {
      policy: policies[id],
      models: [
        { id: "codex/gpt-6-astra", label: "GPT-6 Astra" },
        { id: "codex/gpt-6-sol", label: "GPT-6.1 Sol" },
      ],
      workspaces: [WORKSPACES.design, WORKSPACES.platform, WORKSPACES.research],
      personalWorkspacesSupported: true,
      peopleSupported: true,
      people: PEOPLE,
      localWorkspaceIds: local[id] ?? [],
      managedByWorkspaceId: managedBy[id] ?? null,
    };
  },
  async updateModelConnectionAccess(target: { connectionId: string }, policy: Policy) {
    receipts.push({ access: target.connectionId, policy });
    policies[target.connectionId] = { ...policy, version: policy.version + 1 };
    return policies[target.connectionId];
  },
  async getOrganizationAdministrationOverview() {
    return {
      organization: { id: ORG, name: "Acme" },
      roles: [],
      workspaces: [WORKSPACES.design, WORKSPACES.platform, WORKSPACES.research],
    };
  },
  async listSuperGrokAccounts() {
    return empty;
  },
  async listOrganizationSuperGrokAccounts() {
    return empty;
  },
  async listClaudeSubscriptionAccounts() {
    return { ...empty, source: "workspace" };
  },
  async listOrganizationClaudeSubscriptionAccounts() {
    return { ...empty, source: "organization" };
  },
  async getClaudeSubscriptionAccountUsage() {
    return usage;
  },
  async getWorkspaceClaudeSubscriptionUsage() {
    return usage;
  },
  async listConnections() {
    return [];
  },
  async getWorkspaceModelCatalog() {
    return {
      models: [
        {
          id: "codex/gpt-6-astra",
          label: "GPT-6 Astra",
          api: "openai-responses",
          provider: "codex",
          providerLabel: "Codex",
          reasoningEffort: true,
          reasoningEfforts: ["low", "medium", "high"],
          hostedWebSearch: false,
          cost: "subscription",
          billing: { upstreamPayer: "connected_subscription", metering: "external" },
          credentialReadiness: {
            status: "ready",
            reason: null,
            basis: "connection",
            checkedAt: null,
          },
          availability: { status: "available", selectable: true, reason: null, checkedAt: null },
          policyAllowed: true,
        },
      ],
      defaultSelection: {
        model: "codex/gpt-6-astra",
        reasoningEffort: "medium",
        source: "deployment",
      },
    };
  },
  async getWorkspaceModelAccessPolicy() {
    return { allowedProviders: null, allowedModels: null, source: "organization" };
  },
  async getOrganizationModelProviderConnection() {
    return null;
  },
  async getOrganizationModelDefaults() {
    return {
      sessionDefaults: null,
      allowedProviders: null,
      allowedModels: null,
      modelCompactionThresholds: {},
      updatedAt: null,
    };
  },
  async getBilling() {
    return { mode: "disabled" };
  },
};

// Anything else the page reads answers empty, and is noted for the preview.
const client = new Proxy(methods, {
  get(target, name: string) {
    if (name in target) return target[name];
    return async (...args: unknown[]) => {
      receipts.push({ unhandled: name, args });
      return { models: [], accounts: [] };
    };
  },
});

export const ORGANIZATION_ID = ORG;

const appContext = {
  client,
  clientConfig: {
    billingMode: "disabled",
    models: [],
    defaultModel: "codex/gpt-6-astra",
    defaultReasoningEffort: "medium",
  },
  accessContext: null,
  workspaces: [],
  captureWorkspaceInvocation: () => null,
  ownsWorkspaceInvocation: () => false,
  updateWorkspaceSettings: async () => null,
};

// One stable value, as the app's provider gives.
export function useAppContext() {
  return appContext;
}

export function useOptionalAppContext() {
  return useAppContext();
}
