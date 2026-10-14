// SAMPLE DATA. Synthetic organization "Acme": no real accounts, credentials,
// people or provider calls. "Design team plan" was connected in the Design
// workspace (a former "Design only" account), "Research team plan" in the
// Research workspace; "Acme Pro" is an account the organization connected. Saves change only this page's memory.
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
const RESEARCH_PLAN = "00000000-0000-4000-8000-0000000000c3";
const PERSONAL_PLAN = "00000000-0000-4000-8000-0000000000c4";
/** Extra accounts for `mix=full`. */
const FULL_IDS = {
  ops: "00000000-0000-4000-8000-0000000000c5",
  paused: "00000000-0000-4000-8000-0000000000c6",
  signedOut: "00000000-0000-4000-8000-0000000000c7",
  empty: "00000000-0000-4000-8000-0000000000c8",
  claudeTeam: "00000000-0000-4000-8000-0000000000b1",
  claudeMax: "00000000-0000-4000-8000-0000000000b2",
  claudeOut: "00000000-0000-4000-8000-0000000000b3",
  claudeSignedOut: "00000000-0000-4000-8000-0000000000b4",
  grok: "00000000-0000-4000-8000-0000000000a1",
};

const params = new URLSearchParams(window.location.search);
const previewPersonalSharing = params.get("sharing") === "personal";
let personalShared = false;
/** `reach=people`: Acme Pro limited to people; `reach=all`: the Design plan in every shared workspace. */
const initialReach = params.get("reach");
/** `designSource=organization`: Design is set to use the organization's accounts. */
const designSource = params.get("designSource") === "organization" ? "organization" : "automatic";
/** `researchSource=workspace`: Research is set to use only its own accounts. */
const researchSource = params.get("researchSource") === "workspace" ? "workspace" : "automatic";
/** `kept=research`: Research also keeps Acme Pro as its own (a copy an older migration merged). */
const keptByResearch = params.get("kept") === "research";
/**
 * `mix=full`: a busy organization, as an admin meets it: more Codex accounts
 * (one paused, one signed out, one out of usage, one with usage limit
 * resets), Claude and SuperGrok subscriptions, two API keys, account rules
 * with one lock, and a workspace that changed some of them.
 */
const full = params.get("mix") === "full";

const weekly = (remaining: number) => ({
  used: 100 - remaining,
  limit: 100,
  remaining,
  percent: 100 - remaining,
  resetAt: null,
  resetAfterSeconds: null,
  limitWindowSeconds: 604800,
});
function account(id: string, label: string | null, email: string, remaining: number, active: boolean) {
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
const personalAccount = account(PERSONAL_PLAN, "Alex's personal account", "alex@example.com", 71, true);
const organizationAccounts = [
  account(ACME_PRO, "Acme Pro", "billing@example.com", 62, true),
  account(DESIGN_PLAN, "Design team plan", "design@example.com", 81, false),
  account(RESEARCH_PLAN, "Research team plan", "research@example.com", 44, false),
  ...(full
    ? [
        { ...account(FULL_IDS.ops, null, "ops@example.com", 93, false), resetCreditAvailableCount: 2 },
        { ...account(FULL_IDS.paused, null, "spare@example.com", 100, false), allocatorEnabled: false },
        {
          ...account(FULL_IDS.signedOut, null, "old-plan@example.com", 50, false),
          status: "needs_relogin" as const,
        },
        account(FULL_IDS.empty, null, "night-shift@example.com", 0, false),
      ]
    : []),
];

type Policy = {
  allowedModels: string[] | null;
  allowedWorkspaces: string[] | null;
  allowPersonalWorkspaces: boolean;
  allowedPeople?: string[] | null;
  sharePersonal?: true;
  version: number;
};
const policies: Record<string, Policy> = {
  [PERSONAL_PLAN]: {
    allowedModels: null,
    allowedWorkspaces: [],
    allowPersonalWorkspaces: false,
    version: 1,
  },
  // `reach=people`: the organization's own account limited to two people.
  [ACME_PRO]:
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
          allowedWorkspaces: null,
          allowPersonalWorkspaces: true,
          version: 1,
        },
  // Its reach today: only the workspace that connected it (`reach=all`: every shared one).
  [DESIGN_PLAN]: {
    allowedModels: null,
    allowedWorkspaces: initialReach === "all" ? null : [],
    allowPersonalWorkspaces: false,
    version: 1,
  },
  // Research's own account, used only there: never available in Design.
  [RESEARCH_PLAN]: {
    allowedModels: null,
    allowedWorkspaces: [],
    allowPersonalWorkspaces: false,
    version: 1,
  },
  ...(full
    ? Object.fromEntries(
        Object.values(FULL_IDS).map((id) => [
          id,
          id === FULL_IDS.empty
            ? {
                allowedModels: null,
                allowedWorkspaces: [WORKSPACES.platform.id, WORKSPACES.research.id],
                allowPersonalWorkspaces: false,
                version: 1,
              }
            : id === FULL_IDS.claudeOut
              ? {
                  allowedModels: null,
                  allowedWorkspaces: [],
                  allowPersonalWorkspaces: false,
                  version: 1,
                }
              : {
                  allowedModels: null,
                  allowedWorkspaces: null,
                  allowPersonalWorkspaces: true,
                  version: 1,
                },
        ]),
      )
    : {}),
};
const local: Record<string, string[]> = {
  ...(keptByResearch ? { [ACME_PRO]: [WORKSPACES.research.id] } : {}),
  [DESIGN_PLAN]: [WORKSPACES.design.id],
  [RESEARCH_PLAN]: [WORKSPACES.research.id],
};
const managedBy: Record<string, string | null> = {
  [ACME_PRO]: null,
  [DESIGN_PLAN]: WORKSPACES.design.id,
  [RESEARCH_PLAN]: WORKSPACES.research.id,
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

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
function claudeAccount(
  id: string,
  email: string,
  plan: string,
  usedPercent: number,
  extra: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  return {
    id,
    scope: "organization" as const,
    subject: email,
    email,
    label: null,
    plan,
    status: "active" as const,
    active: false,
    expiresAt: null,
    lastRefreshAt: now,
    lastError: null,
    allocatorEnabled: true,
    allocatorVersion: 1,
    allocatorUpdatedAt: null,
    version: 1,
    usage: {
      ...usage,
      observedAt: now,
      source: "provider",
      refreshStatus: "available",
      refreshCheckedAt: now,
      windows: [
        {
          id: "seven_day",
          usedPercent,
          resetsAt: inDays(3),
          status: usedPercent >= 100 ? "rejected" : "allowed",
          observedAt: now,
          source: "provider",
        },
      ],
    },
    ...extra,
  };
}
const claudeAccounts = full
  ? [
      { ...claudeAccount(FULL_IDS.claudeTeam, "team@example.com", "claude_max", 31), active: true },
      claudeAccount(FULL_IDS.claudeMax, "studio@example.com", "claude_max", 64),
      claudeAccount(FULL_IDS.claudeOut, "lab@example.com", "claude_pro", 100),
      claudeAccount(FULL_IDS.claudeSignedOut, "former@example.com", "claude_max", 10, {
        status: "needs_relogin",
      }),
    ]
  : [];
const grokAccounts = full
  ? [
      {
        id: FULL_IDS.grok,
        plan: null,
        scope: "organization" as const,
        subject: "grok@example.com",
        email: "grok@example.com",
        label: "Acme SuperGrok",
        status: "active" as const,
        active: true,
        allocatorEnabled: true,
        allocatorVersion: 1,
        quota: {
          usedPercent: 14,
          periodStart: inDays(-10),
          periodEnd: inDays(20),
          subscriptionTier: "SuperGrok",
          checkedAt: new Date().toISOString(),
        },
      },
    ]
  : [];
/** API keys the organization connected (`mix=full`). */
const organizationKeys = full ? new Set(["openrouter", "vercel_gateway"]) : new Set<string>();
const ruleValues = () => ({
  rotation: full
    ? {
        codex: { mode: "spread" as const },
        claude: { mode: "spread" as const },
        xai: { mode: "primary_first" as const },
      }
    : { codex: { mode: "spread" as const } },
  providers: full
    ? {
        codex: {
          enabled: true,
          useOrganizationAccounts: true,
          inferenceSource: "organization" as const,
        },
      }
    : {},
  crossProviderFailover: false,
  fallbackOrder: {},
  personalConnectionsAllowed: true,
  personalFallbackAllowed: false,
});
const organizationRules = {
  organizationId: ORG,
  values: ruleValues(),
  locked: full ? ["personalFallbackAllowed"] : [],
  version: 1,
  updatedAt: null,
};
const ORGANIZATION_SOURCES = {
  rotation: "organization",
  providers: "organization",
  crossProviderFailover: "organization",
  fallbackOrder: "organization",
  personalConnectionsAllowed: "organization",
  personalFallbackAllowed: "organization",
} as const;
/** In `mix=full`, Research spreads Claude work its own way and switches provider when it runs out. */
function workspaceRules(workspaceId: string) {
  const values = ruleValues();
  const sources: Record<string, string> = {
    ...ORGANIZATION_SOURCES,
    ...(organizationRules.locked.includes("personalFallbackAllowed")
      ? { personalFallbackAllowed: "locked" }
      : {}),
  };
  const entrySources = { rotation: {}, providers: {}, fallbackOrder: {} } as Record<
    string,
    Record<string, string>
  >;
  if (full && workspaceId === WORKSPACES.research.id) {
    values.rotation = { ...values.rotation, claude: { mode: "primary_first" } } as never;
    values.crossProviderFailover = true;
    sources.rotation = "workspace";
    sources.crossProviderFailover = "workspace";
    entrySources.rotation = { claude: "workspace" };
  }
  return { values, sources, entrySources };
}

const methods: Record<string, (...args: never[]) => Promise<unknown>> = {
  async requestJson(method: string, path: string, body?: unknown) {
    if (method === "GET" && path === `/v1/organizations/${ORG}/codex/accounts`) {
      return {
        // The workspaces whose pool lists it as their own (none under people scope).
        accounts: organizationAccounts.map((entry) => ({
          ...entry,
          ownInWorkspaceIds: policies[entry.id]!.allowedPeople ? [] : (local[entry.id] ?? []),
        })),
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
      const remaining = id === ACME_PRO ? 62 : id === RESEARCH_PLAN ? 44 : 81;
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
    // As the workspace pool projection lists them: shared accounts whose scope
    // includes the workspace (people-scoped ones are in no workspace's pool),
    // its own copies classified "workspace"; automatic lists both pools, a
    // workspace set to the organization's lists only organization ones.
    // A workspace's own copy is its workspace-pool entry; a grant to the
    // workspace is an organization-pool entry (both when "all" includes it).
    const personal = workspaceId === WORKSPACES.personal.id;
    const rows = organizationAccounts
      .filter((entry) => !policies[entry.id]!.allowedPeople)
      .map((entry) => {
        const policy = policies[entry.id]!;
        return {
          entry,
          local: local[entry.id]?.includes(workspaceId) ?? false,
          // A Personal workspace only through "Personal workspaces".
          organization: personal
            ? policy.allowPersonalWorkspaces
            : policy.allowedWorkspaces === null || policy.allowedWorkspaces.includes(workspaceId),
        };
      })
      .filter((row) => row.local || row.organization);
    const mode =
      workspaceId === WORKSPACES.design.id
        ? designSource
        : workspaceId === WORKSPACES.research.id
          ? researchSource
          : "automatic";
    const workspaceAvailable = rows.some((row) => row.local) ||
      (previewPersonalSharing && personal && !personalShared);
    const listed = (row: (typeof rows)[number]) =>
      mode === "automatic" || (mode === "workspace" ? row.local : row.organization);
    return {
      accounts: [
        ...rows.filter(listed).map((row) => ({ ...row.entry, source: row.local ? "workspace" : "organization" })),
        ...(previewPersonalSharing && personal && !personalShared
          ? [{ ...personalAccount, source: "workspace" }] : []),
      ],
      activeAccountId: ACME_PRO,
      source: {
        accountId: ORG,
        workspaceId,
        workspaceKind: workspaceId === WORKSPACES.personal.id ? "personal" : "shared",
        mode,
        effectiveSource:
          mode === "workspace" || (mode === "automatic" && workspaceAvailable)
            ? "workspace"
            : "organization",
        workspaceAvailable,
        organizationAvailable: rows.some((row) => row.organization),
        workspaceSetAside: rows.some((row) => row.local && !listed(row)),
        organizationCount: rows.filter((row) => !row.local && row.organization).length,
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
      policy: policies[id] ?? {
        allowedModels: null,
        allowedWorkspaces: null,
        allowPersonalWorkspaces: true,
        version: 1,
      },
      models: [
        { id: "codex/gpt-6-astra", label: "GPT-6 Astra" },
        { id: "codex/gpt-6-sol", label: "GPT-6.1 Sol" },
      ],
      workspaces: [WORKSPACES.design, WORKSPACES.platform, WORKSPACES.research],
      personalWorkspacesSupported: true,
      // People scope only for an account no workspace manages (design 5.4, decision 5).
      peopleSupported: id !== PERSONAL_PLAN && !managedBy[id],
      personalSharingSupported: id === PERSONAL_PLAN && !personalShared,
      ...(managedBy[id] ? {} : { people: PEOPLE }),
      localWorkspaceIds: local[id] ?? [],
      managedByWorkspaceId: managedBy[id] ?? null,
    };
  },
  async updateModelConnectionAccess(target: { connectionId: string }, policy: Policy) {
    receipts.push({ access: target.connectionId, policy });
    if (target.connectionId === PERSONAL_PLAN && policy.sharePersonal) {
      personalShared = true;
      organizationAccounts.push(personalAccount);
    }
    // Returned in the response schema's key order, as the API does.
    policies[target.connectionId] = {
      allowedModels: policy.allowedModels,
      allowedWorkspaces: policy.allowedWorkspaces,
      allowPersonalWorkspaces: policy.allowPersonalWorkspaces,
      ...(policy.allowedPeople === undefined ? {} : { allowedPeople: policy.allowedPeople }),
      version: policy.version + 1,
    };
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
    return {
      ...empty,
      source: "organization",
      organizationId: ORG,
      accounts: grokAccounts,
      activeAccountId: grokAccounts[0]?.id ?? null,
    };
  },
  async listClaudeSubscriptionAccounts() {
    return { ...empty, source: "workspace" };
  },
  async listOrganizationClaudeSubscriptionAccounts() {
    return {
      ...empty,
      source: "organization",
      organizationId: ORG,
      accounts: claudeAccounts,
      activeAccountId: claudeAccounts[0]?.id ?? null,
      settings: {
        rotationEnabled: true,
        rotationStrategy: "sharded",
        activeCredentialId: claudeAccounts[0]?.id ?? null,
      },
    };
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
  async getModelAccountSettingsOverview() {
    return {
      organization: organizationRules,
      workspaces: [WORKSPACES.design, WORKSPACES.platform, WORKSPACES.research].map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        ...workspaceRules(workspace.id),
      })),
      nextCursor: null,
    };
  },
  async updateOrganizationModelAccountSettings(
    _organizationId: string,
    request: Record<string, unknown>,
  ) {
    receipts.push({ accountRules: request });
    const { expectedVersion: _version, locked, ...values } = request;
    Object.assign(organizationRules.values, values);
    if (Array.isArray(locked)) organizationRules.locked = locked as string[];
    organizationRules.version += 1;
    return organizationRules;
  },
  async getWorkspaceModelAccountSettings(workspaceId: string) {
    const rules = workspaceRules(workspaceId);
    return {
      workspaceId,
      version: 1,
      updatedAt: null,
      canEdit: workspaceId !== WORKSPACES.personal.id,
      locked: organizationRules.locked,
      ...rules,
      overrides: { rotation: null, providers: null, crossProviderFailover: null, fallbackOrder: null, personalConnectionsAllowed: null, personalFallbackAllowed: null },
    };
  },
  async getOrganizationModelProviderConnection(_organizationId: string, kind: string) {
    if (!organizationKeys.has(kind)) return null;
    const now = new Date().toISOString();
    return { providerKind: kind, status: "active", version: 1, createdAt: now, updatedAt: now };
  },
  async listOrganizationProviderCustomModels() {
    return { models: [] };
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
    claudeSubscriptionEnabled: full,
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
